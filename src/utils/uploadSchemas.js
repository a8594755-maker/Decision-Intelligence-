/**
 * Upload Data Type Schema Definitions
 * Defines field structure, validation rules, and labels for each upload type
 */

export const UPLOAD_SCHEMAS = {
  // Goods Receipt
  goods_receipt: {
    label: 'Goods Receipt',
    description: 'For calculating defect rate and on-time delivery rate',
    icon: '📦',
    fields: [
      // === Required Fields ===
      {
        key: 'supplier_name',
        label: 'Supplier Name',
        type: 'string',
        required: true,
        description: 'Official supplier name'
      },
      {
        key: 'material_code',
        label: 'Material Code',
        type: 'string',
        required: true,
        description: 'Material code or part number'
      },
      {
        key: 'actual_delivery_date',
        label: 'Actual Delivery Date',
        type: 'date',
        required: true,
        description: 'Date when supplier actually delivered'
      },
      {
        key: 'received_qty',
        label: 'Received Quantity',
        type: 'number',
        required: true,
        description: 'Actual quantity received',
        min: 0
      },
      
      // === Optional Fields ===
      {
        key: 'supplier_code',
        label: 'Supplier Code',
        type: 'string',
        required: false,
        description: 'Supplier ID or code'
      },
      {
        key: 'material_name',
        label: 'Material Name',
        type: 'string',
        required: false,
        description: 'Material name in Chinese or English'
      },
      {
        key: 'po_number',
        label: 'PO Number',
        type: 'string',
        required: false,
        description: 'Purchase Order number'
      },
      {
        key: 'receipt_number',
        label: 'Receipt Number',
        type: 'string',
        required: false,
        description: 'Goods receipt document number'
      },
      {
        key: 'planned_delivery_date',
        label: 'Planned Delivery Date',
        type: 'date',
        required: false,
        description: 'Originally scheduled delivery date (for on-time calculation)'
      },
      {
        key: 'receipt_date',
        label: 'Receipt Date',
        type: 'date',
        required: false,
        description: 'Date when warehouse actually received goods'
      },
      {
        key: 'rejected_qty',
        label: 'Rejected Quantity',
        type: 'number',
        required: false,
        description: 'Quantity rejected due to quality issues (for defect rate calculation)',
        min: 0,
        default: 0
      },
      {
        key: 'category',
        label: 'Material Category',
        type: 'string',
        required: false,
        description: 'Material classification (e.g., raw material, parts, packaging)'
      },
      {
        key: 'uom',
        label: 'Unit',
        type: 'string',
        required: false,
        description: 'Unit of measure (e.g., pcs, kg, m)',
        default: 'pcs'
      }
    ]
  },

  // Price History
  price_history: {
    label: 'Price History',
    description: 'For calculating price volatility',
    icon: '💰',
    fields: [
      // === Required Fields ===
      {
        key: 'supplier_name',
        label: 'Supplier Name',
        type: 'string',
        required: true,
        description: 'Official supplier name'
      },
      {
        key: 'material_code',
        label: 'Material Code',
        type: 'string',
        required: true,
        description: 'Material code or part number'
      },
      {
        key: 'order_date',
        label: 'Order Date',
        type: 'date',
        required: true,
        description: 'Order or quotation date'
      },
      {
        key: 'unit_price',
        label: 'Unit Price',
        type: 'number',
        required: true,
        description: 'Unit price',
        min: 0
      },
      
      // === Optional Fields ===
      {
        key: 'supplier_code',
        label: 'Supplier Code',
        type: 'string',
        required: false,
        description: 'Supplier ID or code'
      },
      {
        key: 'material_name',
        label: 'Material Name',
        type: 'string',
        required: false,
        description: 'Material name in Chinese or English'
      },
      {
        key: 'currency',
        label: 'Currency',
        type: 'string',
        required: false,
        description: 'Price currency (e.g., USD, TWD, CNY)',
        default: 'USD'
      },
      {
        key: 'quantity',
        label: 'Quantity',
        type: 'number',
        required: false,
        description: 'Order quantity',
        min: 0,
        default: 0
      },
      {
        key: 'is_contract_price',
        label: 'Contract Price',
        type: 'boolean',
        required: false,
        description: 'Whether this is a long-term contract price',
        default: false
      }
    ]
  },

  // Supplier Master
  supplier_master: {
    label: 'Supplier Master',
    description: 'Create or update supplier basic information',
    icon: '🏢',
    fields: [
      // === Required Fields ===
      {
        key: 'supplier_code',
        label: 'Supplier Code',
        type: 'string',
        required: true,
        description: 'Internal supplier ID (unique identifier)'
      },
      {
        key: 'supplier_name',
        label: 'Supplier Name',
        type: 'string',
        required: true,
        description: 'Official supplier name (full company name)'
      },
      
      // === Optional Fields ===
      {
        key: 'contact_person',
        label: 'Contact Person',
        type: 'string',
        required: false,
        description: 'Primary contact person name'
      },
      {
        key: 'phone',
        label: 'Phone',
        type: 'string',
        required: false,
        description: 'Contact phone number'
      },
      {
        key: 'email',
        label: 'Email',
        type: 'string',
        required: false,
        description: 'Contact email address'
      },
      {
        key: 'address',
        label: 'Address',
        type: 'string',
        required: false,
        description: 'Company address'
      },
      {
        key: 'product_category',
        label: 'Product Category',
        type: 'string',
        required: false,
        description: 'Primary product category supplied'
      },
      {
        key: 'payment_terms',
        label: 'Payment Terms',
        type: 'string',
        required: false,
        description: 'Payment method or terms (e.g., Net 30, COD)'
      },
      {
        key: 'delivery_time',
        label: 'Delivery Time',
        type: 'string',
        required: false,
        description: 'Standard delivery lead time (e.g., 7 days, 2 weeks)'
      },
      {
        key: 'status',
        label: 'Status',
        type: 'string',
        required: false,
        description: 'Supplier status (e.g., active, inactive, suspended)',
        default: 'active'
      }
    ]
  },

  // Quality Incident - Reserved for future use
  quality_incident: {
    label: 'Quality Incident',
    description: 'Record supplier quality issues',
    icon: '⚠️',
    fields: [
      {
        key: 'supplier_name',
        label: 'Supplier Name',
        type: 'string',
        required: true,
        description: 'Name of supplier with incident'
      },
      {
        key: 'material_code',
        label: 'Material Code',
        type: 'string',
        required: true,
        description: 'Material code with incident'
      },
      {
        key: 'incident_date',
        label: 'Incident Date',
        type: 'date',
        required: true,
        description: 'Date when incident was discovered'
      },
      {
        key: 'incident_type',
        label: 'Incident Type',
        type: 'string',
        required: true,
        description: 'Incident category (e.g., dimensional non-conformance, appearance defect, functional failure)'
      },
      {
        key: 'severity',
        label: 'Severity',
        type: 'string',
        required: false,
        description: 'Severity level (e.g., low, medium, high, critical)',
        default: 'medium'
      },
      {
        key: 'description',
        label: 'Description',
        type: 'string',
        required: false,
        description: 'Detailed incident description'
      },
      {
        key: 'affected_qty',
        label: 'Affected Quantity',
        type: 'number',
        required: false,
        description: 'Quantity affected',
        min: 0
      }
    ]
  },

  // BOM Edge - BOM relationship table
  bom_edge: {
    label: 'BOM Edge',
    description: 'BOM relationship table (parent-child material usage)',
    icon: '🔗',
    fields: [
      // === Required Fields ===
      {
        key: 'parent_material',
        label: 'Parent Material',
        type: 'string',
        required: true,
        description: 'Parent material code (FG or assembly)'
      },
      {
        key: 'child_material',
        label: 'Child Material',
        type: 'string',
        required: true,
        description: 'Child material code (component)'
      },
      {
        key: 'qty_per',
        label: 'Quantity Per Unit',
        type: 'number',
        required: true,
        description: 'Quantity per unit (must be > 0)',
        min: 0.0001
      },
      
      // === Optional Fields ===
      {
        key: 'uom',
        label: 'Unit of Measure',
        type: 'string',
        required: false,
        description: 'Unit of measure (e.g., pcs, kg, m)',
        default: 'pcs'
      },
      {
        key: 'plant_id',
        label: 'Plant ID',
        type: 'string',
        required: false,
        description: 'Plant code (for multi-plant support)'
      },
      {
        key: 'bom_version',
        label: 'BOM Version',
        type: 'string',
        required: false,
        description: 'BOM version identifier'
      },
      {
        key: 'valid_from',
        label: 'Valid From',
        type: 'date',
        required: false,
        description: 'Valid from date (YYYY-MM-DD)'
      },
      {
        key: 'valid_to',
        label: 'Valid To',
        type: 'date',
        required: false,
        description: 'Valid to date (YYYY-MM-DD)'
      },
      {
        key: 'scrap_rate',
        label: 'Scrap Rate',
        type: 'number',
        required: false,
        description: 'Scrap rate (0 <= scrap_rate < 1, e.g., 0.05 = 5%)',
        min: 0,
        max: 0.9999
      },
      {
        key: 'yield_rate',
        label: 'Yield Rate',
        type: 'number',
        required: false,
        description: 'Yield rate (0 < yield_rate <= 1, e.g., 0.95 = 95%)',
        min: 0.0001,
        max: 1
      },
      {
        key: 'alt_group',
        label: 'Alternative Group',
        type: 'string',
        required: false,
        description: 'Alternative material group identifier'
      },
      {
        key: 'priority',
        label: 'Priority',
        type: 'number',
        required: false,
        description: 'Priority (lower number = higher priority)',
        min: 1
      },
      {
        key: 'mix_ratio',
        label: 'Mix Ratio',
        type: 'number',
        required: false,
        description: 'Mix ratio for alternative materials (0 < mix_ratio <= 1)',
        min: 0.0001,
        max: 1
      },
      {
        key: 'ecn_number',
        label: 'ECN Number',
        type: 'string',
        required: false,
        description: 'Engineering Change Notice number'
      },
      {
        key: 'ecn_effective_date',
        label: 'ECN Effective Date',
        type: 'date',
        required: false,
        description: 'ECN effective date (YYYY-MM-DD)'
      },
      {
        key: 'routing_id',
        label: 'Routing ID',
        type: 'string',
        required: false,
        description: 'Routing/process version identifier'
      },
      {
        key: 'notes',
        label: 'Notes',
        type: 'string',
        required: false,
        description: 'Additional notes'
      }
    ]
  },

  // Demand FG - Finished goods demand table
  demand_fg: {
    label: 'Demand FG',
    description: 'Finished goods demand table (time-series demand data)',
    icon: '📊',
    fields: [
      // === Required Fields ===
      {
        key: 'material_code',
        label: 'Material Code',
        type: 'string',
        required: true,
        description: 'Finished goods material code'
      },
      {
        key: 'plant_id',
        label: 'Plant ID',
        type: 'string',
        required: true,
        description: 'Plant code (required for multi-plant support)'
      },
      {
        key: 'demand_qty',
        label: 'Demand Quantity',
        type: 'number',
        required: true,
        description: 'Demand quantity (must be >= 0)',
        min: 0
      },
      
      // === Time Bucket Fields (at least one required) ===
      {
        key: 'week_bucket',
        label: 'Week Bucket',
        type: 'string',
        required: false,
        description: 'Week bucket format: YYYY-W## (e.g., 2026-W02). Use either week_bucket or date.'
      },
      {
        key: 'date',
        label: 'Date',
        type: 'date',
        required: false,
        description: 'Date format: YYYY-MM-DD (e.g., 2026-01-08). Use either week_bucket or date.'
      },
      {
        key: 'time_bucket',
        label: 'Time Bucket',
        type: 'string',
        required: false,
        description: 'Unified time bucket (auto-filled from week_bucket or date)'
      },
      
      // === Optional Fields ===
      {
        key: 'uom',
        label: 'Unit of Measure',
        type: 'string',
        required: false,
        description: 'Unit of measure (e.g., pcs, kg, m)',
        default: 'pcs'
      },
      {
        key: 'source_type',
        label: 'Source Type',
        type: 'string',
        required: false,
        description: 'Demand source type: SO, forecast, manual, other'
      },
      {
        key: 'source_id',
        label: 'Source ID',
        type: 'string',
        required: false,
        description: 'Source identifier (e.g., order number, forecast ID)'
      },
      {
        key: 'customer_id',
        label: 'Customer ID',
        type: 'string',
        required: false,
        description: 'Customer code'
      },
      {
        key: 'project_id',
        label: 'Project ID',
        type: 'string',
        required: false,
        description: 'Project code'
      },
      {
        key: 'priority',
        label: 'Priority',
        type: 'number',
        required: false,
        description: 'Priority (lower number = higher priority)',
        min: 1
      },
      {
        key: 'status',
        label: 'Status',
        type: 'string',
        required: false,
        description: 'Status: draft, confirmed, cancelled',
        default: 'confirmed'
      },
      {
        key: 'notes',
        label: 'Notes',
        type: 'string',
        required: false,
        description: 'Additional notes'
      }
    ]
  },

  // PO Open Lines - Purchase order open lines table
  po_open_lines: {
    label: 'PO Open Lines',
    description: 'Purchase order open lines (supply commitments)',
    icon: '📋',
    fields: [
      // === Required Fields ===
      {
        key: 'po_number',
        label: 'PO Number',
        type: 'string',
        required: true,
        description: 'Purchase order number'
      },
      {
        key: 'po_line',
        label: 'PO Line',
        type: 'string',
        required: true,
        description: 'Purchase order line number (e.g., 10, 20)'
      },
      {
        key: 'material_code',
        label: 'Material Code',
        type: 'string',
        required: true,
        description: 'Material code (component or raw material)'
      },
      {
        key: 'plant_id',
        label: 'Plant ID',
        type: 'string',
        required: true,
        description: 'Plant code'
      },
      {
        key: 'open_qty',
        label: 'Open Quantity',
        type: 'number',
        required: true,
        description: 'Open quantity (not yet received, must be >= 0)',
        min: 0
      },

      // === Risk/Delay Fields (optional but recommended for Workflow B) ===
      {
        key: 'supplier_name',
        label: 'Supplier Name',
        type: 'string',
        required: false,
        description: 'Supplier name (recommended for risk scoring)'
      },
      {
        key: 'order_date',
        label: 'Order Date',
        type: 'date',
        required: false,
        description: 'PO creation date (recommended for lead-time trend)'
      },
      {
        key: 'promised_date',
        label: 'Promised Date',
        type: 'date',
        required: false,
        description: 'Supplier promised delivery date (recommended for delay metrics)'
      },
      
      // === Time Bucket Fields (at least one required) ===
      {
        key: 'week_bucket',
        label: 'Week Bucket',
        type: 'string',
        required: false,
        description: 'Week bucket format: YYYY-W## (e.g., 2026-W05). Use either week_bucket or date.'
      },
      {
        key: 'date',
        label: 'Date',
        type: 'date',
        required: false,
        description: 'Date format: YYYY-MM-DD (e.g., 2026-02-10). Use either week_bucket or date.'
      },
      {
        key: 'time_bucket',
        label: 'Time Bucket',
        type: 'string',
        required: false,
        description: 'Unified time bucket (auto-filled from week_bucket or date)'
      },
      
      // === Optional Fields ===
      {
        key: 'uom',
        label: 'Unit of Measure',
        type: 'string',
        required: false,
        description: 'Unit of measure (e.g., pcs, kg)',
        default: 'pcs'
      },
      {
        key: 'supplier_id',
        label: 'Supplier ID',
        type: 'string',
        required: false,
        description: 'Supplier code'
      },
      {
        key: 'status',
        label: 'Status',
        type: 'string',
        required: false,
        description: 'Status: open, closed, cancelled',
        default: 'open'
      },
      {
        key: 'notes',
        label: 'Notes',
        type: 'string',
        required: false,
        description: 'Additional notes'
      }
    ]
  },

  // Inventory Snapshots - Inventory snapshot table
  inventory_snapshots: {
    label: 'Inventory Snapshots',
    description: 'Inventory snapshot data (on-hand inventory by date)',
    icon: '📦',
    fields: [
      // === Required Fields ===
      {
        key: 'material_code',
        label: 'Material Code',
        type: 'string',
        required: true,
        description: 'Material code (component, raw material, or finished goods)'
      },
      {
        key: 'plant_id',
        label: 'Plant ID',
        type: 'string',
        required: true,
        description: 'Plant code'
      },
      {
        key: 'snapshot_date',
        label: 'Snapshot Date',
        type: 'date',
        required: true,
        description: 'Snapshot date (YYYY-MM-DD)'
      },
      {
        key: 'onhand_qty',
        label: 'On-hand Quantity',
        type: 'number',
        required: true,
        description: 'On-hand quantity (actual inventory; negative values allowed and treated as shortage)'
      },
      
      // === Optional Fields ===
      {
        key: 'allocated_qty',
        label: 'Allocated Quantity',
        type: 'number',
        required: false,
        description: 'Allocated quantity (committed but not shipped, must be >= 0)',
        min: 0,
        default: 0
      },
      {
        key: 'safety_stock',
        label: 'Safety Stock',
        type: 'number',
        required: false,
        description: 'Safety stock (minimum inventory level, must be >= 0)',
        min: 0,
        default: 0
      },
      {
        key: 'shortage_qty',
        label: 'Shortage Quantity',
        type: 'number',
        required: false,
        description: 'Computed shortage (positive value when onhand_qty is negative)',
        min: 0,
        default: 0
      },
      {
        key: 'uom',
        label: 'Unit of Measure',
        type: 'string',
        required: false,
        description: 'Unit of measure (e.g., pcs, kg)',
        default: 'pcs'
      },
      {
        key: 'notes',
        label: 'Notes',
        type: 'string',
        required: false,
        description: 'Additional notes'
      }
    ]
  },

  // Operational Costs - Daily operational cost records
  operational_costs: {
    label: 'Operational Costs',
    description: 'Daily operational cost records (labor, material, overhead)',
    icon: '🏭',
    fields: [
      // === Required Fields ===
      {
        key: 'cost_date',
        label: 'Cost Date',
        type: 'date',
        required: true,
        description: 'Cost record date (YYYY-MM-DD)'
      },
      {
        key: 'direct_labor_hours',
        label: 'Direct Labor Hours',
        type: 'number',
        required: true,
        description: 'Direct labor hours worked',
        min: 0
      },
      {
        key: 'direct_labor_rate',
        label: 'Direct Labor Rate',
        type: 'number',
        required: true,
        description: 'Hourly rate for direct labor',
        min: 0
      },
      {
        key: 'production_output',
        label: 'Production Output',
        type: 'number',
        required: true,
        description: 'Total production output quantity',
        min: 0
      },

      // === Optional Fields ===
      {
        key: 'indirect_labor_hours',
        label: 'Indirect Labor Hours',
        type: 'number',
        required: false,
        description: 'Indirect labor hours (supervision, maintenance, etc.)',
        min: 0,
        default: 0
      },
      {
        key: 'indirect_labor_rate',
        label: 'Indirect Labor Rate',
        type: 'number',
        required: false,
        description: 'Hourly rate for indirect labor',
        min: 0,
        default: 0
      },
      {
        key: 'production_unit',
        label: 'Production Unit',
        type: 'string',
        required: false,
        description: 'Unit of measure for production output (e.g., pcs, kg)',
        default: 'pcs'
      },
      {
        key: 'material_cost',
        label: 'Material Cost',
        type: 'number',
        required: false,
        description: 'Total material cost for the day',
        min: 0,
        default: 0
      },
      {
        key: 'overhead_cost',
        label: 'Overhead Cost',
        type: 'number',
        required: false,
        description: 'Factory overhead cost for the day',
        min: 0,
        default: 0
      },
      {
        key: 'notes',
        label: 'Notes',
        type: 'string',
        required: false,
        description: 'Additional notes or remarks'
      }
    ]
  },

  // FG Financials - Finished goods financial data
  fg_financials: {
    label: 'FG Financials',
    description: 'Finished goods financial data (pricing and margin)',
    icon: '💵',
    fields: [
      // === Required Fields ===
      {
        key: 'material_code',
        label: 'Material Code',
        type: 'string',
        required: true,
        description: 'Finished goods material code'
      },
      {
        key: 'unit_margin',
        label: 'Unit Margin',
        type: 'number',
        required: true,
        description: 'Unit margin (gross margin per unit, must be >= 0)',
        min: 0
      },
      
      // === Optional Fields ===
      {
        key: 'plant_id',
        label: 'Plant ID',
        type: 'string',
        required: false,
        description: 'Plant code (leave empty for global pricing)'
      },
      {
        key: 'unit_price',
        label: 'Unit Price',
        type: 'number',
        required: false,
        description: 'Unit price (selling price, must be >= 0)',
        min: 0
      },
      {
        key: 'currency',
        label: 'Currency',
        type: 'string',
        required: false,
        description: 'Currency code (e.g., USD, EUR, CNY)',
        default: 'USD'
      },
      {
        key: 'valid_from',
        label: 'Valid From',
        type: 'date',
        required: false,
        description: 'Valid from date (YYYY-MM-DD)'
      },
      {
        key: 'valid_to',
        label: 'Valid To',
        type: 'date',
        required: false,
        description: 'Valid to date (YYYY-MM-DD)'
      },
      {
        key: 'notes',
        label: 'Notes',
        type: 'string',
        required: false,
        description: 'Additional notes'
      }
    ]
  }
};

/**
 * Utility function: Get required fields for an upload type
 */
export const getRequiredFields = (uploadType) => {
  const schema = UPLOAD_SCHEMAS[uploadType];
  if (!schema) return [];
  return schema.fields.filter(f => f.required).map(f => f.key);
};

/**
 * Utility function: Get optional fields for an upload type
 */
export const getOptionalFields = (uploadType) => {
  const schema = UPLOAD_SCHEMAS[uploadType];
  if (!schema) return [];
  return schema.fields.filter(f => !f.required).map(f => f.key);
};

/**
 * Utility function: Get all fields for an upload type
 */
export const getAllFields = (uploadType) => {
  const schema = UPLOAD_SCHEMAS[uploadType];
  if (!schema) return [];
  return schema.fields.map(f => f.key);
};

/**
 * Utility function: Get field definition by key
 */
export const getFieldDefinition = (uploadType, fieldKey) => {
  const schema = UPLOAD_SCHEMAS[uploadType];
  if (!schema) return null;
  return schema.fields.find(f => f.key === fieldKey);
};

/**
 * Utility function: Get default value for a field
 */
export const getFieldDefault = (uploadType, fieldKey) => {
  const field = getFieldDefinition(uploadType, fieldKey);
  return field?.default;
};

/**
 * Utility function: Validate field type
 */
export const validateFieldType = (value, type) => {
  if (value === null || value === undefined || value === '') {
    return { valid: true, value: null }; // Empty values are handled by required validation
  }

  switch (type) {
    case 'string':
      return { valid: true, value: String(value) };
    
    case 'number': {
      const num = Number(value);
      if (isNaN(num)) {
        return { valid: false, error: 'Must be a number' };
      }
      return { valid: true, value: num };
    }
    
    case 'date': {
      // Try to parse date
      const date = new Date(value);
      if (isNaN(date.getTime())) {
        return { valid: false, error: 'Invalid date format' };
      }
      return { valid: true, value: date.toISOString().split('T')[0] };
    }
    
    case 'boolean': {
      if (typeof value === 'boolean') {
        return { valid: true, value };
      }
      const lowerValue = String(value).toLowerCase();
      if (['true', 'yes', '1', 'y', '是'].includes(lowerValue)) {
        return { valid: true, value: true };
      }
      if (['false', 'no', '0', 'n', '否'].includes(lowerValue)) {
        return { valid: true, value: false };
      }
      return { valid: false, error: 'Must be a boolean value (true/false)' };
    }
    
    default:
      return { valid: true, value };
  }
};

export default UPLOAD_SCHEMAS;
