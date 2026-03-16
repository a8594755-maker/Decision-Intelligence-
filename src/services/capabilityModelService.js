/**
 * capabilityModelService.js — Platform-Level Capability Model
 *
 * Abstracts the raw executor types (builtin_tool, registered_tool, dynamic_tool,
 * python_tool, report, export, llm_call, opencloud, excel) into a unified
 * platform-level capability catalog.
 *
 * Provides:
 *   1. Capability Catalog — unified registry of all capabilities with metadata
 *   2. Policy by Capability — approval level, review requirements, data access
 *   3. Tool Binding by Worker Type — which capabilities each worker template can use
 *   4. Data Access Policy — what data each capability can read/write
 *
 * Architecture:
 *   BuiltinToolCatalog + ToolRegistry + ExecutorRegistry
 *     → CapabilityModel (unified abstraction)
 *       → PolicyEngine (per-capability governance)
 *       → WorkerBindings (per-template access control)
 */

import { BUILTIN_TOOLS, TOOL_CATEGORY } from './builtinToolCatalog.js';
import { listToolTypes } from './aiEmployee/executors/executorRegistry.js';
import { supabase } from './supabaseClient';
import { getWorkerTemplateFromDB, listTemplatesFromDB } from './aiEmployee/persistence/employeeRepo.js';

// ── Capability Classes ──────────────────────────────────────────────────────

/**
 * High-level capability classes that group executor types.
 * A capability class represents "what it does" not "how it runs".
 */
export const CAPABILITY_CLASS = {
  PLANNING:      'planning',       // forecast, plan, risk analysis
  ANALYSIS:      'analysis',       // data analysis, solver, ML
  REPORTING:     'reporting',      // report generation, export, excel
  SYNTHESIS:     'synthesis',      // LLM summarization, narrative
  INTEGRATION:   'integration',    // OpenCloud, external systems
  CUSTOM_CODE:   'custom_code',    // dynamic/registered python tools
  NEGOTIATION:   'negotiation',    // negotiation strategy
  MONITORING:    'monitoring',     // alerts, closed-loop, dashboards
};

// ── Executor → Capability Class Mapping ─────────────────────────────────────

const EXECUTOR_TO_CLASS = {
  builtin_tool:  null,             // resolved per-tool from catalog
  python_tool:   CAPABILITY_CLASS.CUSTOM_CODE,
  python_report: CAPABILITY_CLASS.REPORTING,
  dynamic_tool:  CAPABILITY_CLASS.CUSTOM_CODE,
  llm_call:      CAPABILITY_CLASS.SYNTHESIS,
  report:        CAPABILITY_CLASS.REPORTING,
  export:        CAPABILITY_CLASS.REPORTING,
  opencloud:     CAPABILITY_CLASS.INTEGRATION,
  excel:         CAPABILITY_CLASS.REPORTING,
};

const CATEGORY_TO_CLASS = {
  [TOOL_CATEGORY.CORE_PLANNING]:  CAPABILITY_CLASS.PLANNING,
  [TOOL_CATEGORY.RISK]:           CAPABILITY_CLASS.PLANNING,
  [TOOL_CATEGORY.SCENARIO]:       CAPABILITY_CLASS.ANALYSIS,
  [TOOL_CATEGORY.NEGOTIATION]:    CAPABILITY_CLASS.NEGOTIATION,
  [TOOL_CATEGORY.COST_REVENUE]:   CAPABILITY_CLASS.ANALYSIS,
  [TOOL_CATEGORY.BOM]:            CAPABILITY_CLASS.PLANNING,
  [TOOL_CATEGORY.UTILITY]:        CAPABILITY_CLASS.ANALYSIS,
  [TOOL_CATEGORY.ANALYTICS]:      CAPABILITY_CLASS.ANALYSIS,
  [TOOL_CATEGORY.GOVERNANCE]:     CAPABILITY_CLASS.MONITORING,
  [TOOL_CATEGORY.DATA_ACCESS]:    CAPABILITY_CLASS.ANALYSIS,
  [TOOL_CATEGORY.MONITORING]:     CAPABILITY_CLASS.MONITORING,
};

// ── Capability Policies ─────────────────────────────────────────────────────

/**
 * Per-class default policies.
 * Can be overridden per-capability or per-worker.
 */
export const CAPABILITY_POLICIES = {
  [CAPABILITY_CLASS.PLANNING]: {
    approval_required: true,
    min_autonomy_level: 'A1',
    auto_approve_at: 'A3',
    review_required: true,
    max_retry: 3,
    data_access: 'read',
    sensitive_data_allowed: false,
    budget_tier: 'tier_c',
  },
  [CAPABILITY_CLASS.ANALYSIS]: {
    approval_required: false,
    min_autonomy_level: 'A1',
    auto_approve_at: 'A2',
    review_required: true,
    max_retry: 3,
    data_access: 'read',
    sensitive_data_allowed: false,
    budget_tier: 'tier_b',
  },
  [CAPABILITY_CLASS.REPORTING]: {
    approval_required: false,
    min_autonomy_level: 'A1',
    auto_approve_at: 'A2',
    review_required: true,
    max_retry: 2,
    data_access: 'read',
    sensitive_data_allowed: false,
    budget_tier: 'tier_a',
  },
  [CAPABILITY_CLASS.SYNTHESIS]: {
    approval_required: false,
    min_autonomy_level: 'A1',
    auto_approve_at: 'A1',
    review_required: false,
    max_retry: 2,
    data_access: 'read',
    sensitive_data_allowed: false,
    budget_tier: 'tier_a',
  },
  [CAPABILITY_CLASS.INTEGRATION]: {
    approval_required: true,
    min_autonomy_level: 'A2',
    auto_approve_at: 'A4',
    review_required: true,
    max_retry: 1,
    data_access: 'read_write',
    sensitive_data_allowed: true,
    budget_tier: 'tier_c',
  },
  [CAPABILITY_CLASS.CUSTOM_CODE]: {
    approval_required: false,
    min_autonomy_level: 'A1',
    auto_approve_at: 'A3',
    review_required: true,
    max_retry: 3,
    data_access: 'read',
    sensitive_data_allowed: false,
    budget_tier: 'tier_b',
  },
  [CAPABILITY_CLASS.NEGOTIATION]: {
    approval_required: true,
    min_autonomy_level: 'A2',
    auto_approve_at: 'A4',
    review_required: true,
    max_retry: 2,
    data_access: 'read',
    sensitive_data_allowed: true,
    budget_tier: 'tier_c',
  },
  [CAPABILITY_CLASS.MONITORING]: {
    approval_required: false,
    min_autonomy_level: 'A1',
    auto_approve_at: 'A1',
    review_required: false,
    max_retry: 1,
    data_access: 'read',
    sensitive_data_allowed: false,
    budget_tier: 'tier_a',
  },
};

// ── DB-First Policy Resolution ──────────────────────────────────────────────

/**
 * Resolve a capability policy from DB first, falling back to hardcoded.
 * This is the primary entry point for policy lookups at runtime.
 *
 * @param {string} capabilityClass - CAPABILITY_CLASS value
 * @param {string} [capabilityId]  - Specific capability ID for overrides
 * @returns {Promise<Object>} policy object
 */
export async function getCapabilityPolicyFromDB(capabilityClass, capabilityId = null) {
  try {
    // Try specific capability override first
    if (capabilityId) {
      const { data } = await supabase
        .from('capability_policies')
        .select('*')
        .eq('capability_class', capabilityClass)
        .eq('capability_id', capabilityId)
        .eq('is_active', true)
        .maybeSingle();
      if (data) return data;
    }

    // Try class-level DB policy
    const { data } = await supabase
      .from('capability_policies')
      .select('*')
      .eq('capability_class', capabilityClass)
      .is('capability_id', null)
      .eq('is_active', true)
      .maybeSingle();
    if (data) return data;
  } catch {
    // DB unavailable — fall through to hardcoded
  }

  return CAPABILITY_POLICIES[capabilityClass] || null;
}

/**
 * Load all capability policies from DB, merging with hardcoded defaults.
 * Returns a map of capabilityClass → policy.
 *
 * @returns {Promise<Object>} Map of capability class → policy
 */
export async function loadAllPoliciesFromDB() {
  const merged = { ...CAPABILITY_POLICIES };
  try {
    const { data } = await supabase
      .from('capability_policies')
      .select('*')
      .eq('is_active', true)
      .is('capability_id', null);
    if (data?.length) {
      for (const row of data) {
        merged[row.capability_class] = row;
      }
    }
  } catch {
    // DB unavailable — return hardcoded
  }
  return merged;
}

// ── Data Access Policies ────────────────────────────────────────────────────

/**
 * Data access scope per capability.
 * Defines what datasets a capability can read/write and field-level restrictions.
 */
export const DATA_ACCESS_POLICIES = {
  [CAPABILITY_CLASS.PLANNING]: {
    readable_datasets: ['demand_fg', 'inventory_snapshots', 'po_open_lines', 'bom_edge', 'fg_financials'],
    writable_datasets: [],
    restricted_fields: ['unit_cost', 'unit_margin'],   // requires sensitive_data_allowed
    requires_profile: true,
  },
  [CAPABILITY_CLASS.ANALYSIS]: {
    readable_datasets: ['*'],   // any uploaded dataset
    writable_datasets: [],
    restricted_fields: [],
    requires_profile: false,
  },
  [CAPABILITY_CLASS.REPORTING]: {
    readable_datasets: ['*'],
    writable_datasets: [],
    restricted_fields: [],
    requires_profile: false,
  },
  [CAPABILITY_CLASS.SYNTHESIS]: {
    readable_datasets: [],      // works from artifacts, not raw data
    writable_datasets: [],
    restricted_fields: [],
    requires_profile: false,
  },
  [CAPABILITY_CLASS.INTEGRATION]: {
    readable_datasets: ['*'],
    writable_datasets: ['*'],   // can push to external systems
    restricted_fields: [],
    requires_profile: false,
  },
  [CAPABILITY_CLASS.CUSTOM_CODE]: {
    readable_datasets: ['*'],
    writable_datasets: [],
    restricted_fields: ['unit_cost', 'unit_margin'],
    requires_profile: false,
  },
  [CAPABILITY_CLASS.NEGOTIATION]: {
    readable_datasets: ['goods_receipt', 'po_open_lines', 'supplier_master', 'fg_financials'],
    writable_datasets: [],
    restricted_fields: [],
    requires_profile: false,
  },
  [CAPABILITY_CLASS.MONITORING]: {
    readable_datasets: ['*'],
    writable_datasets: [],
    restricted_fields: [],
    requires_profile: false,
  },
};

// ── Worker Templates ────────────────────────────────────────────────────────

/**
 * Worker template definitions.
 * Each template specifies which capability classes the worker can use.
 */
export const WORKER_TEMPLATES = {
  supply_chain_analyst: {
    id: 'supply_chain_analyst',
    name: 'Supply Chain Analyst',
    description: 'Full-scope supply chain planning, forecasting, and risk analysis',
    allowed_capabilities: [
      CAPABILITY_CLASS.PLANNING,
      CAPABILITY_CLASS.ANALYSIS,
      CAPABILITY_CLASS.REPORTING,
      CAPABILITY_CLASS.SYNTHESIS,
      CAPABILITY_CLASS.CUSTOM_CODE,
      CAPABILITY_CLASS.MONITORING,
    ],
    default_autonomy: 'A1',
    max_autonomy: 'A4',
  },
  procurement_specialist: {
    id: 'procurement_specialist',
    name: 'Procurement Specialist',
    description: 'Negotiation support, supplier analysis, and procurement workflows',
    allowed_capabilities: [
      CAPABILITY_CLASS.NEGOTIATION,
      CAPABILITY_CLASS.ANALYSIS,
      CAPABILITY_CLASS.REPORTING,
      CAPABILITY_CLASS.SYNTHESIS,
    ],
    default_autonomy: 'A1',
    max_autonomy: 'A3',
  },
  data_analyst: {
    id: 'data_analyst',
    name: 'Data Analyst',
    description: 'General-purpose data analysis, reporting, and custom tooling',
    allowed_capabilities: [
      CAPABILITY_CLASS.ANALYSIS,
      CAPABILITY_CLASS.REPORTING,
      CAPABILITY_CLASS.SYNTHESIS,
      CAPABILITY_CLASS.CUSTOM_CODE,
    ],
    default_autonomy: 'A1',
    max_autonomy: 'A4',
  },
  operations_coordinator: {
    id: 'operations_coordinator',
    name: 'Operations Coordinator',
    description: 'Integration, monitoring, and cross-system coordination',
    allowed_capabilities: [
      CAPABILITY_CLASS.INTEGRATION,
      CAPABILITY_CLASS.MONITORING,
      CAPABILITY_CLASS.REPORTING,
      CAPABILITY_CLASS.SYNTHESIS,
    ],
    default_autonomy: 'A1',
    max_autonomy: 'A3',
  },
};

// ── Capability Catalog ──────────────────────────────────────────────────────

/**
 * Build the unified capability catalog from all sources.
 * Synchronous version uses hardcoded policies (for backward compat).
 * Prefer buildCapabilityCatalogAsync() for runtime use.
 *
 * @param {Object} [policyMap] - Pre-fetched policy map (optional, defaults to hardcoded)
 * @returns {Object[]} Array of capability entries
 */
export function buildCapabilityCatalog(policyMap = CAPABILITY_POLICIES) {
  const catalog = [];

  // 1. Map builtin tools to capabilities
  for (const tool of BUILTIN_TOOLS) {
    const capClass = CATEGORY_TO_CLASS[tool.category] || CAPABILITY_CLASS.ANALYSIS;
    catalog.push({
      id: `builtin:${tool.id}`,
      name: tool.name,
      description: tool.description,
      capability_class: capClass,
      source: 'builtin',
      executor_type: 'builtin_tool',
      builtin_tool_id: tool.id,
      category: tool.category,
      tier: tool.tier,
      required_datasets: tool.required_datasets,
      output_artifacts: tool.output_artifacts,
      policy: policyMap[capClass] || CAPABILITY_POLICIES[capClass],
      data_access: DATA_ACCESS_POLICIES[capClass],
    });
  }

  // 2. Add platform executor capabilities (non-builtin)
  const platformCapabilities = [
    {
      id: 'platform:python_tool',
      name: 'Python Code Execution',
      description: 'Execute LLM-generated Python code in sandbox for data analysis',
      capability_class: CAPABILITY_CLASS.CUSTOM_CODE,
      executor_type: 'python_tool',
    },
    {
      id: 'platform:dynamic_tool',
      name: 'Dynamic Tool Generation',
      description: 'One-shot LLM-generated code execution (not saved)',
      capability_class: CAPABILITY_CLASS.CUSTOM_CODE,
      executor_type: 'dynamic_tool',
    },
    {
      id: 'platform:llm_call',
      name: 'LLM Synthesis',
      description: 'Direct LLM call for summarization, narrative, or reasoning',
      capability_class: CAPABILITY_CLASS.SYNTHESIS,
      executor_type: 'llm_call',
    },
    {
      id: 'platform:report',
      name: 'Report Generation',
      description: 'Generate structured reports from artifacts',
      capability_class: CAPABILITY_CLASS.REPORTING,
      executor_type: 'report',
    },
    {
      id: 'platform:export',
      name: 'Data Export',
      description: 'Export data in various formats (CSV, PDF, etc.)',
      capability_class: CAPABILITY_CLASS.REPORTING,
      executor_type: 'export',
    },
    {
      id: 'platform:excel',
      name: 'Excel Workbook Generation',
      description: 'Generate styled Excel workbooks with charts and formatting',
      capability_class: CAPABILITY_CLASS.REPORTING,
      executor_type: 'excel',
    },
    {
      id: 'platform:opencloud',
      name: 'OpenCloud Integration',
      description: 'Publish or import data via OpenCloud',
      capability_class: CAPABILITY_CLASS.INTEGRATION,
      executor_type: 'opencloud',
    },
  ];

  for (const cap of platformCapabilities) {
    const effectivePolicy = policyMap[cap.capability_class] || CAPABILITY_POLICIES[cap.capability_class];
    catalog.push({
      ...cap,
      source: 'platform',
      category: null,
      tier: effectivePolicy?.budget_tier || 'tier_b',
      required_datasets: [],
      output_artifacts: [],
      policy: effectivePolicy,
      data_access: DATA_ACCESS_POLICIES[cap.capability_class],
    });
  }

  return catalog;
}

/**
 * Async version of buildCapabilityCatalog that loads policies from DB first.
 * This is the preferred entry point for runtime use.
 *
 * @returns {Promise<Object[]>} Array of capability entries with DB-sourced policies
 */
export async function buildCapabilityCatalogAsync() {
  const policies = await loadAllPoliciesFromDB();
  return buildCapabilityCatalog(policies);
}

// ── Policy Resolution ───────────────────────────────────────────────────────

/**
 * Resolve the effective policy for a capability given a worker's autonomy level.
 *
 * @param {string} capabilityId   - Capability ID from catalog
 * @param {string} autonomyLevel  - Worker's current autonomy (A1-A4)
 * @param {string} [workerTemplate] - Worker template ID
 * @returns {{ allowed, approval_needed, review_needed, reason }}
 */
export async function resolvePolicy(capabilityId, autonomyLevel, workerTemplate = null) {
  const catalog = await buildCapabilityCatalogAsync();
  const capability = catalog.find(c => c.id === capabilityId);

  if (!capability) {
    return { allowed: false, approval_needed: false, review_needed: false, reason: `Unknown capability: ${capabilityId}` };
  }

  const policy = capability.policy;
  const template = workerTemplate
    ? (await getWorkerTemplateFromDB(workerTemplate).catch(() => null)) || WORKER_TEMPLATES[workerTemplate] || null
    : null;

  // Check template binding
  if (template && !template.allowed_capabilities.includes(capability.capability_class)) {
    return {
      allowed: false,
      approval_needed: false,
      review_needed: false,
      reason: `Capability class '${capability.capability_class}' not allowed for worker template '${template.name}'`,
    };
  }

  // Check minimum autonomy
  const levels = ['A0', 'A1', 'A2', 'A3', 'A4'];
  const currentIdx = levels.indexOf(autonomyLevel);
  const minIdx = levels.indexOf(policy.min_autonomy_level);
  const autoIdx = levels.indexOf(policy.auto_approve_at);

  if (currentIdx < minIdx) {
    return {
      allowed: false,
      approval_needed: false,
      review_needed: false,
      reason: `Autonomy level ${autonomyLevel} below minimum ${policy.min_autonomy_level} for this capability`,
    };
  }

  // Determine approval/review needs
  const needsApproval = policy.approval_required && currentIdx < autoIdx;
  const needsReview = policy.review_required && currentIdx < autoIdx;

  return {
    allowed: true,
    approval_needed: needsApproval,
    review_needed: needsReview,
    reason: needsApproval
      ? `Approval required (autonomy ${autonomyLevel} < auto-approve threshold ${policy.auto_approve_at})`
      : 'Capability allowed',
  };
}

/**
 * Check if a capability can access a specific dataset.
 *
 * @param {string} capabilityClass - CAPABILITY_CLASS value
 * @param {string} datasetType     - Dataset type name
 * @param {string[]} fields        - Fields being accessed
 * @returns {{ allowed, restricted_fields, reason }}
 */
export function checkDataAccess(capabilityClass, datasetType, fields = []) {
  const access = DATA_ACCESS_POLICIES[capabilityClass];
  if (!access) {
    return { allowed: false, restricted_fields: [], reason: `Unknown capability class: ${capabilityClass}` };
  }

  // Check dataset access
  const canRead = access.readable_datasets.includes('*') || access.readable_datasets.includes(datasetType);
  if (!canRead) {
    return { allowed: false, restricted_fields: [], reason: `Dataset '${datasetType}' not accessible for ${capabilityClass}` };
  }

  // Check restricted fields
  const restricted = fields.filter(f => access.restricted_fields.includes(f));
  if (restricted.length > 0) {
    return {
      allowed: true,
      restricted_fields: restricted,
      reason: `Fields [${restricted.join(', ')}] are restricted — requires sensitive_data_allowed`,
    };
  }

  return { allowed: true, restricted_fields: [], reason: 'Access granted' };
}

// ── Capability Queries ──────────────────────────────────────────────────────

/**
 * List capabilities available to a specific worker template.
 *
 * @param {string} workerTemplateId
 * @returns {Object[]}
 */
export async function listCapabilitiesForWorker(workerTemplateId) {
  const template = (await getWorkerTemplateFromDB(workerTemplateId).catch(() => null))
    || WORKER_TEMPLATES[workerTemplateId];
  if (!template) return [];

  const catalog = await buildCapabilityCatalogAsync();
  return catalog.filter(c => template.allowed_capabilities.includes(c.capability_class));
}

/**
 * Resolve capability class from an executor step.
 *
 * @param {{ tool_type: string, builtin_tool_id?: string, category?: string }} step
 * @returns {string} CAPABILITY_CLASS value
 */
export function resolveCapabilityClass(step) {
  if (step.tool_type === 'builtin_tool' && step.builtin_tool_id) {
    const tool = BUILTIN_TOOLS.find(t => t.id === step.builtin_tool_id);
    if (tool) return CATEGORY_TO_CLASS[tool.category] || CAPABILITY_CLASS.ANALYSIS;
  }

  return EXECUTOR_TO_CLASS[step.tool_type] || CAPABILITY_CLASS.ANALYSIS;
}

/**
 * Get all available worker templates.
 */
export async function listWorkerTemplates() {
  return listTemplatesFromDB().catch(() => Object.values(WORKER_TEMPLATES));
}

/**
 * Get a summary of capability coverage per worker template.
 *
 * @returns {Object[]} Array of { templateId, templateName, capabilityCount, classes }
 */
export async function getCapabilityCoverage() {
  const [catalog, templates] = await Promise.all([
    buildCapabilityCatalogAsync(),
    listTemplatesFromDB().catch(() => Object.values(WORKER_TEMPLATES)),
  ]);

  return templates.map(template => {
    const available = catalog.filter(c => template.allowed_capabilities.includes(c.capability_class));
    const classCounts = {};
    for (const cap of available) {
      classCounts[cap.capability_class] = (classCounts[cap.capability_class] || 0) + 1;
    }

    return {
      templateId: template.id,
      templateName: template.name,
      capabilityCount: available.length,
      classes: classCounts,
      allowedClasses: template.allowed_capabilities,
      maxAutonomy: template.max_autonomy,
    };
  });
}
