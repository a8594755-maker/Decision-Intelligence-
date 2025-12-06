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
    
    case 'number':
      const num = Number(value);
      if (isNaN(num)) {
        return { valid: false, error: 'Must be a number' };
      }
      return { valid: true, value: num };
    
    case 'date':
      // Try to parse date
      const date = new Date(value);
      if (isNaN(date.getTime())) {
        return { valid: false, error: 'Invalid date format' };
      }
      return { valid: true, value: date.toISOString().split('T')[0] };
    
    case 'boolean':
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
    
    default:
      return { valid: true, value };
  }
};

export default UPLOAD_SCHEMAS;

