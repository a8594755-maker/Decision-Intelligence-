/**
 * erpPayloadStabilizer.js — Freezes ERP adapter payload schemas for v1
 *
 * Extends erpAdapterPayload.js with versioned schemas, SAP IDoc round-trip
 * validation, and comprehensive test fixtures.
 *
 * @module services/hardening/erpPayloadStabilizer
 */

import {
  ERP_SCHEMAS,
  transformToErpPayload,
  validateForErp,
  SAP_IDOC_FIXTURES,
} from './erpAdapterPayload.js';

// ── Schema Version Registry ─────────────────────────────────────────────────

export const ERP_SCHEMA_VERSION = '1.0.0';

export const ERP_SCHEMA_REGISTRY = Object.freeze({
  '1.0.0': {
    systems: Object.keys(ERP_SCHEMAS),
    frozen_at: '2026-03-17',
    sap_idoc_types: ['MATMAS05', 'ORDERS05'],
  },
});

// ── SAP IDoc Full Fixtures ──────────────────────────────────────────────────

export const SAP_IDOC_FULL_FIXTURES = Object.freeze({
  // Purchase Order (ORDERS05) - full IDoc envelope
  purchase_order_create: {
    IDOC_TYPE: 'ORDERS05',
    MESTYP: 'ORDERS',
    SNDPRT: 'LS',
    SNDPRN: 'DI_WORKER',
    RCVPRT: 'LS',
    RCVPRN: 'SAP_ERP',
    DOCNUM: '{generated}',
    E1EDK01: {
      BSART: 'NB',         // Standard PO
      EKORG: '1000',       // Purchasing Org
      EKGRP: '001',        // Purchasing Group
      WAERS: 'USD',        // Currency
      LIFNR: '{supplier}', // Vendor
      BEDAT: '{order_date}',
    },
    E1EDP01: [{
      EBELP: '00010',      // PO Item
      MATNR: '{material}', // Material Number
      WERKS: '{plant}',    // Plant
      MENGE: '{quantity}',
      MEINS: 'EA',
      NETPR: '{unit_price}',
      EINDT: '{delivery_date}',
    }],
    E1EDKA1: [{
      PARVW: 'LF',         // Vendor
      PARTN: '{supplier}',
    }],
  },

  // Safety Stock Adjustment (MATMAS05)
  safety_stock_adjust: {
    IDOC_TYPE: 'MATMAS05',
    MESTYP: 'MATMAS',
    SNDPRT: 'LS',
    SNDPRN: 'DI_WORKER',
    E1MARAM: {
      MATNR: '{material}',
      MAKTX: '{description}',
      MEINS: 'EA',
    },
    E1MARCM: {
      WERKS: '{plant}',
      BESKZ: 'F',           // External procurement
      EISBE: '{safety_stock}',
    },
  },

  // Production Order (LOIPRO)
  production_order_create: {
    IDOC_TYPE: 'LOIPRO',
    MESTYP: 'LOIPRO',
    SNDPRT: 'LS',
    SNDPRN: 'DI_WORKER',
    E1ORHDR: {
      AUFNR: '{generated}',
      AUART: 'PP01',
      MATNR: '{material}',
      WERKS: '{plant}',
      GAMNG: '{quantity}',
      GLTRP: '{delivery_date}',
      GSTRP: '{start_date}',
    },
  },
});

// ── Stable ERP Payload Builder ──────────────────────────────────────────────

/**
 * Build a stable, versioned ERP payload from a writeback artifact.
 *
 * @param {Object} writebackPayload - writeback_payload artifact
 * @param {string} [targetSystem] - Override target system
 * @returns {{ ok: boolean, payload?: Object, errors?: string[] }}
 */
export function buildStableErpPayload(writebackPayload, targetSystem = null) {
  const system = targetSystem || writebackPayload?.target_system || 'generic';

  // 1. Validate for target ERP
  const validation = validateForErp(writebackPayload, system);
  if (!validation.valid) {
    return { ok: false, errors: validation.errors };
  }

  // 2. Transform to ERP format
  const result = transformToErpPayload(writebackPayload, system);
  if (!result.ok) {
    return { ok: false, errors: result.errors };
  }

  // 3. Add version metadata
  const payload = {
    ...result.adapter_payload,
    schema_version: ERP_SCHEMA_VERSION,
    source: 'digital_worker_v1',
    task_id: writebackPayload.task_id,
    writeback_idempotency_key: writebackPayload.idempotency_key,
  };

  return { ok: true, payload };
}

/**
 * Validate an ERP payload can be round-tripped (serialize → deserialize → compare).
 */
export function validateRoundTrip(erpPayload) {
  try {
    const serialized = JSON.stringify(erpPayload);
    const deserialized = JSON.parse(serialized);

    // Check key fields survived round-trip
    const checks = [
      deserialized.target_system === erpPayload.target_system,
      deserialized.schema_version === erpPayload.schema_version,
      deserialized.idempotency_key === erpPayload.idempotency_key,
      deserialized.record_count === erpPayload.record_count,
      Array.isArray(deserialized.records),
      deserialized.records?.length === erpPayload.records?.length,
    ];

    const passed = checks.every(Boolean);
    return {
      ok: passed,
      serialized_size: serialized.length,
      record_count: deserialized.records?.length || 0,
      errors: passed ? [] : ['Round-trip validation failed — fields changed during serialization'],
    };
  } catch (err) {
    return { ok: false, errors: [`Serialization error: ${err.message}`] };
  }
}

/**
 * Generate test fixture for a specific IDoc type with real values.
 */
export function generateFixture(idocType, params = {}) {
  const templates = {
    ORDERS05: SAP_IDOC_FULL_FIXTURES.purchase_order_create,
    MATMAS05: SAP_IDOC_FULL_FIXTURES.safety_stock_adjust,
    LOIPRO: SAP_IDOC_FULL_FIXTURES.production_order_create,
  };

  const template = templates[idocType];
  if (!template) return { ok: false, error: `Unknown IDoc type: ${idocType}` };

  // Replace placeholders with actual values
  const json = JSON.stringify(template);
  const filled = json
    .replace(/\{material\}/g, params.material || 'MAT-001')
    .replace(/\{plant\}/g, params.plant || 'P10')
    .replace(/\{quantity\}/g, String(params.quantity || 500))
    .replace(/\{supplier\}/g, params.supplier || 'SUP-001')
    .replace(/\{order_date\}/g, params.order_date || '2026-04-01')
    .replace(/\{delivery_date\}/g, params.delivery_date || '2026-04-15')
    .replace(/\{start_date\}/g, params.start_date || '2026-04-05')
    .replace(/\{unit_price\}/g, String(params.unit_price || 25.00))
    .replace(/\{safety_stock\}/g, String(params.safety_stock || 100))
    .replace(/\{description\}/g, params.description || 'Material')
    .replace(/\{generated\}/g, `DI-${Date.now().toString(36).toUpperCase()}`);

  return { ok: true, fixture: JSON.parse(filled), idoc_type: idocType };
}
