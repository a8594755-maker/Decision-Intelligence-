/**
 * erpAdapterPayload.js — ERP Adapter Payload Schema + Fixtures
 *
 * Defines the stable ERP payload schema for different target systems.
 * v1: JSON only (no direct ERP connection). Provides SAP IDoc fixtures for testing.
 *
 * @module services/hardening/erpAdapterPayload
 */

// ── Adapter Schemas ─────────────────────────────────────────────────────────

export const ERP_SCHEMAS = Object.freeze({
  sap_mm: {
    name: 'SAP MM (Materials Management)',
    version: '1.0',
    envelope: 'MATMAS05',
    required_fields: ['material_code', 'plant_id', 'quantity'],
    optional_fields: ['order_date', 'delivery_date', 'supplier_id', 'unit_cost', 'storage_location'],
    transform: (mutation) => ({
      IDOC_TYPE: 'MATMAS05',
      MESTYP: 'MATMAS',
      SNDPRT: 'LS',
      SNDPRN: 'DI_WORKER',
      E1MARAM: {
        MATNR: mutation.field_changes?.material_code || '',
        MAKTX: mutation.field_changes?.description || '',
        MEINS: 'EA',
      },
      E1MARCM: {
        WERKS: mutation.field_changes?.plant_id || '',
        BESKZ: mutation.action === 'create_production_order' ? 'E' : 'F',
      },
      E1EISBE: {
        BSTMI: mutation.field_changes?.quantity || 0,
      },
    }),
  },

  oracle_scm: {
    name: 'Oracle SCM Cloud',
    version: '1.0',
    envelope: 'PurchaseOrder',
    required_fields: ['material_code', 'plant_id', 'quantity'],
    optional_fields: ['order_date', 'delivery_date', 'supplier_id'],
    transform: (mutation) => ({
      OrderType: 'STANDARD',
      VendorId: mutation.field_changes?.supplier_id || null,
      ShipToOrganizationCode: mutation.field_changes?.plant_id || '',
      Lines: [{
        ItemNumber: mutation.field_changes?.material_code || '',
        Quantity: mutation.field_changes?.quantity || 0,
        UOMCode: 'EA',
        NeedByDate: mutation.field_changes?.delivery_date || null,
      }],
    }),
  },

  generic: {
    name: 'Generic REST API',
    version: '1.0',
    envelope: 'GenericPayload',
    required_fields: ['material_code', 'quantity'],
    optional_fields: ['plant_id', 'order_date', 'delivery_date', 'supplier_id'],
    transform: (mutation) => ({
      action: mutation.action,
      entity: mutation.entity,
      fields: mutation.field_changes || {},
      metadata: {
        before: mutation.before || null,
        after: mutation.after || null,
      },
    }),
  },
});

/**
 * Transform a writeback_payload into ERP-specific format.
 *
 * @param {Object} writebackPayload - writeback_payload artifact
 * @param {string} [targetSystem] - Override target system
 * @returns {{ ok: boolean, adapter_payload?: Object, errors?: string[] }}
 */
export function transformToErpPayload(writebackPayload, targetSystem = null) {
  const system = targetSystem || writebackPayload?.target_system || 'generic';
  const schema = ERP_SCHEMAS[system] || ERP_SCHEMAS.generic;
  const errors = [];

  if (!writebackPayload?.intended_mutations?.length) {
    return { ok: false, errors: ['No mutations to transform'] };
  }

  // Validate required fields
  for (const mutation of writebackPayload.intended_mutations) {
    for (const field of schema.required_fields) {
      if (!mutation.field_changes?.[field] && mutation.field_changes?.[field] !== 0) {
        errors.push(`Mutation missing required field "${field}" for ${system}`);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Transform each mutation
  const transformed = writebackPayload.intended_mutations.map(m => schema.transform(m));

  return {
    ok: true,
    adapter_payload: {
      target_system: system,
      schema_version: schema.version,
      envelope_type: schema.envelope,
      idempotency_key: writebackPayload.idempotency_key,
      approval_metadata: writebackPayload.approval_metadata,
      records: transformed,
      record_count: transformed.length,
      generated_at: new Date().toISOString(),
    },
  };
}

/**
 * Validate a writeback_payload has all fields needed for a specific ERP system.
 */
export function validateForErp(writebackPayload, targetSystem) {
  const schema = ERP_SCHEMAS[targetSystem];
  if (!schema) {
    return { valid: false, errors: [`Unknown ERP system: ${targetSystem}`] };
  }

  const errors = [];
  for (const mutation of (writebackPayload?.intended_mutations || [])) {
    for (const field of schema.required_fields) {
      if (!mutation.field_changes?.[field] && mutation.field_changes?.[field] !== 0) {
        errors.push(`Missing "${field}" for ${targetSystem}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── SAP IDoc Fixtures ───────────────────────────────────────────────────────

export const SAP_IDOC_FIXTURES = Object.freeze({
  purchase_order: {
    IDOC_TYPE: 'ORDERS05',
    MESTYP: 'ORDERS',
    SNDPRT: 'LS',
    SNDPRN: 'DI_WORKER',
    E1EDK01: {
      BSART: 'NB',
      EKORG: '1000',
      EKGRP: '001',
    },
    E1EDP01: {
      MATNR: 'MAT-001',
      WERKS: 'P10',
      MENGE: 500,
      MEINS: 'EA',
      EINDT: '2026-04-15',
    },
    E1EDKA1: {
      PARVW: 'LF',
      PARTN: 'SUP-001',
    },
  },

  material_master: {
    IDOC_TYPE: 'MATMAS05',
    MESTYP: 'MATMAS',
    E1MARAM: {
      MATNR: 'MAT-001',
      MAKTX: 'Test Material',
      MEINS: 'EA',
    },
    E1MARCM: {
      WERKS: 'P10',
      EISBE: 100,  // safety stock
    },
  },
});
