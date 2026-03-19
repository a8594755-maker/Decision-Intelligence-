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

// ── Adapter Payload Contract (frozen shape for downstream consumers) ────────

/**
 * Locked contract for the adapter_payload envelope shape.
 * Any change here is a breaking change for downstream ERP consumers.
 */
export const ADAPTER_PAYLOAD_CONTRACT = Object.freeze({
  version: '1.0',
  required_envelope_keys: Object.freeze([
    'target_system', 'schema_version', 'envelope_type',
    'idempotency_key', 'approval_metadata', 'records',
    'record_count', 'generated_at',
  ]),
  supported_systems: Object.freeze(['sap_mm', 'oracle_scm', 'generic']),
  sap_mm_record_keys: Object.freeze(['IDOC_TYPE', 'MESTYP', 'SNDPRT', 'SNDPRN', 'E1MARAM', 'E1MARCM', 'E1EISBE']),
  oracle_scm_record_keys: Object.freeze(['OrderType', 'VendorId', 'ShipToOrganizationCode', 'Lines']),
  generic_record_keys: Object.freeze(['action', 'entity', 'fields', 'metadata']),
});

/**
 * Validate that an adapter_payload conforms to the locked contract.
 * Use this at publish-time to prevent malformed payloads from reaching ERP.
 *
 * @param {Object} adapterPayload - The adapter_payload from transformToErpPayload
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateAdapterPayloadContract(adapterPayload) {
  const errors = [];

  if (!adapterPayload || typeof adapterPayload !== 'object') {
    return { valid: false, errors: ['adapter_payload is missing or not an object'] };
  }

  // Check envelope keys
  for (const key of ADAPTER_PAYLOAD_CONTRACT.required_envelope_keys) {
    if (!(key in adapterPayload)) {
      errors.push(`Missing required envelope key: "${key}"`);
    }
  }

  // Check target_system is supported
  if (adapterPayload.target_system &&
      !ADAPTER_PAYLOAD_CONTRACT.supported_systems.includes(adapterPayload.target_system)) {
    // Not an error — unknown systems use generic transform — but flag it
    errors.push(`Unknown target_system: "${adapterPayload.target_system}" (will use generic adapter)`);
  }

  // Validate record shapes per system
  if (Array.isArray(adapterPayload.records) && adapterPayload.records.length > 0) {
    const system = adapterPayload.target_system;
    const expectedKeys =
      system === 'sap_mm' ? ADAPTER_PAYLOAD_CONTRACT.sap_mm_record_keys :
      system === 'oracle_scm' ? ADAPTER_PAYLOAD_CONTRACT.oracle_scm_record_keys :
      ADAPTER_PAYLOAD_CONTRACT.generic_record_keys;

    for (let i = 0; i < adapterPayload.records.length; i++) {
      const record = adapterPayload.records[i];
      for (const key of expectedKeys) {
        if (!(key in record)) {
          errors.push(`Record[${i}] missing expected key "${key}" for ${system}`);
        }
      }
    }
  }

  // Validate record_count matches
  if (adapterPayload.record_count !== adapterPayload.records?.length) {
    errors.push(`record_count (${adapterPayload.record_count}) does not match records.length (${adapterPayload.records?.length})`);
  }

  // Validate generated_at is ISO timestamp
  if (adapterPayload.generated_at && isNaN(Date.parse(adapterPayload.generated_at))) {
    errors.push('generated_at is not a valid ISO timestamp');
  }

  return { valid: errors.length === 0, errors };
}

// ── Mutation Field Type Schemas (locked) ──────────────────────────────────────

/**
 * Field-level type constraints for mutation payloads.
 * Validates that values are the correct type before ERP transform.
 * Any change here is a breaking change for ERP consumers.
 */
export const MUTATION_FIELD_TYPES = Object.freeze({
  material_code: 'string',
  plant_id:      'string',
  quantity:      'number',
  order_date:    'string',   // ISO date
  delivery_date: 'string',   // ISO date
  supplier_id:   'string',
  unit_cost:     'number',
  storage_location: 'string',
  description:   'string',
});

/**
 * Validate mutation field values match the expected types.
 *
 * @param {Object} fieldChanges - The field_changes object from a mutation
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateMutationFieldTypes(fieldChanges) {
  if (!fieldChanges || typeof fieldChanges !== 'object') {
    return { valid: false, errors: ['field_changes is missing or not an object'] };
  }

  const errors = [];
  for (const [field, value] of Object.entries(fieldChanges)) {
    const expectedType = MUTATION_FIELD_TYPES[field];
    if (!expectedType) continue; // unknown fields pass through

    if (value == null) continue; // null/undefined allowed (optional fields)

    const actualType = typeof value;
    if (actualType !== expectedType) {
      errors.push(`Field "${field}" expected ${expectedType}, got ${actualType} (value: ${JSON.stringify(value)})`);
    }

    // Date fields must be valid ISO strings
    if ((field === 'order_date' || field === 'delivery_date') && actualType === 'string') {
      if (isNaN(Date.parse(value))) {
        errors.push(`Field "${field}" is not a valid ISO date string: "${value}"`);
      }
    }

    // Quantity and unit_cost must be non-negative
    if ((field === 'quantity' || field === 'unit_cost') && actualType === 'number') {
      if (value < 0) {
        errors.push(`Field "${field}" must be non-negative, got ${value}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Full validation: schema required fields + field type checking.
 * Use this before calling transformToErpPayload.
 *
 * @param {Object} writebackPayload - The writeback payload
 * @param {string} targetSystem - ERP system identifier
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateWritebackPayload(writebackPayload, targetSystem) {
  const schemaResult = validateForErp(writebackPayload, targetSystem);
  if (!schemaResult.valid) return schemaResult;

  const errors = [];
  for (const mutation of (writebackPayload?.intended_mutations || [])) {
    const typeResult = validateMutationFieldTypes(mutation.field_changes);
    if (!typeResult.valid) errors.push(...typeResult.errors);
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
