/**
 * supplierEventContractV1.js
 *
 * Zod-based schema contract for real-time supplier events.
 * Part of the Sense layer — receives events from external systems
 * (ERP, TMS, supplier portals, manual entry) and validates them
 * before feeding into the risk closed-loop pipeline.
 *
 * Follows the same Zod + .passthrough() pattern as planningApiContractV1.js.
 */

import { z } from 'zod';

// ── Event Type Enum ──────────────────────────────────────────────────────────

export const SUPPLIER_EVENT_TYPES = [
  'delivery_delay',
  'quality_alert',
  'capacity_change',
  'force_majeure',
  'shipment_status',
  'price_change',
];

export const SEVERITY_LEVELS = ['low', 'medium', 'high', 'critical'];

// ── Base Event Schema ────────────────────────────────────────────────────────

export const supplierEventBaseSchema = z.object({
  event_id:      z.string().min(1),
  event_type:    z.enum(SUPPLIER_EVENT_TYPES),
  supplier_id:   z.string().min(1),
  supplier_name: z.string().optional(),
  material_code: z.string().optional().nullable(),
  plant_id:      z.string().optional().nullable(),
  severity:      z.enum(SEVERITY_LEVELS).default('medium'),
  occurred_at:   z.string().min(1),
  source_system: z.string().default('external'),
  description:   z.string().optional().default(''),
  metadata:      z.record(z.string(), z.any()).optional().default({}),
}).passthrough();

// ── Type-Specific Detail Schemas ─────────────────────────────────────────────

export const deliveryDelayDetailSchema = z.object({
  po_number:    z.string().optional(),
  original_eta: z.string(),
  revised_eta:  z.string(),
  delay_days:   z.number().nonnegative(),
  reason:       z.string().optional().default(''),
}).passthrough();

export const qualityAlertDetailSchema = z.object({
  batch_number:     z.string().optional(),
  defect_rate_pct:  z.number().min(0).max(100),
  reject_qty:       z.number().optional(),
  quality_category: z.enum(['minor', 'major', 'critical']).default('major'),
}).passthrough();

export const capacityChangeDetailSchema = z.object({
  previous_capacity_pct: z.number(),
  new_capacity_pct:      z.number(),
  effective_date:        z.string(),
  duration_days:         z.number().optional().nullable(),
  reason:                z.string().optional().default(''),
}).passthrough();

export const forceMajeureDetailSchema = z.object({
  event_category:          z.enum(['natural_disaster', 'geopolitical', 'pandemic', 'regulatory', 'other']),
  affected_region:         z.string().optional(),
  estimated_duration_days: z.number().optional().nullable(),
  affected_materials:      z.array(z.string()).default([]),
}).passthrough();

export const shipmentStatusDetailSchema = z.object({
  shipment_id:      z.string(),
  status:           z.enum(['in_transit', 'delayed', 'customs_hold', 'delivered', 'lost']),
  current_location: z.string().optional(),
  revised_eta:      z.string().optional(),
}).passthrough();

export const priceChangeDetailSchema = z.object({
  old_unit_price: z.number(),
  new_unit_price: z.number(),
  currency:       z.string().default('USD'),
  effective_date: z.string(),
  reason:         z.string().optional().default(''),
}).passthrough();

// ── Composite Event Schema ───────────────────────────────────────────────────

export const supplierEventSchema = supplierEventBaseSchema.extend({
  details: z.union([
    deliveryDelayDetailSchema,
    qualityAlertDetailSchema,
    capacityChangeDetailSchema,
    forceMajeureDetailSchema,
    shipmentStatusDetailSchema,
    priceChangeDetailSchema,
    z.record(z.string(), z.any()),
  ]).optional().default({}),
}).passthrough();

// ── Batch Request Schema ─────────────────────────────────────────────────────

export const supplierEventBatchSchema = z.object({
  events:        z.array(supplierEventSchema).min(1).max(100),
  source_system: z.string().default('external'),
  batch_id:      z.string().optional(),
}).passthrough();

// ── Validation Functions ─────────────────────────────────────────────────────

/**
 * Validate a single supplier event payload.
 * Throws ZodError on validation failure.
 * @param {Object} payload
 * @returns {Object} parsed & validated event
 */
export function validateSupplierEvent(payload = {}) {
  return supplierEventSchema.parse(payload);
}

/**
 * Validate a batch of supplier events.
 * Throws ZodError on validation failure.
 * @param {Object} payload - { events[], source_system?, batch_id? }
 * @returns {Object} parsed & validated batch
 */
export function validateSupplierEventBatch(payload = {}) {
  return supplierEventBatchSchema.parse(payload);
}

/**
 * Safe validation (no throw). Returns { success, data, error }.
 * @param {Object} payload
 * @returns {{ success: boolean, data?: Object, error?: string }}
 */
export function safeValidateSupplierEvent(payload = {}) {
  const result = supplierEventSchema.safeParse(payload);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
  };
}

export default {
  SUPPLIER_EVENT_TYPES,
  SEVERITY_LEVELS,
  supplierEventSchema,
  supplierEventBatchSchema,
  validateSupplierEvent,
  validateSupplierEventBatch,
  safeValidateSupplierEvent,
};
