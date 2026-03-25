/**
 * Policy Ingestion Service
 *
 * Manages company/team policies, glossaries, KPI definitions,
 * naming conventions, and SOPs. These form the "handbook" knowledge
 * that a Digital Worker must follow.
 *
 * Supports:
 *   - Manual policy creation (admin enters rules)
 *   - Handbook upload (extract policies from documents via LLM)
 *   - Structured policy types with search
 */
import { supabase } from '../../infra/supabaseClient.js';

const TABLE = 'style_policies';

// ─── Policy Types ────────────────────────────────────────────

export const POLICY_TYPES = {
  GLOSSARY:          'glossary',           // term → definition
  NAMING_CONVENTION: 'naming_convention',  // how to name things (columns, sheets, files)
  KPI_DEFINITION:    'kpi_definition',     // KPI name, formula, target, unit
  FORMATTING_RULE:   'formatting_rule',    // color codes, fonts, number formats
  TONE_GUIDE:        'tone_guide',         // language, formality, voice
  PROHIBITED_TERMS:  'prohibited_terms',   // words/phrases never to use
  SOP:               'sop',               // step-by-step procedure
  TEMPLATE_RULE:     'template_rule',      // report structure requirements
  CUSTOM:            'custom',
};

// ─── CRUD ────────────────────────────────────────────────────

/**
 * Create a new policy entry.
 */
export async function createPolicy({ employeeId, teamId, policyType, title, content, structured, appliesToDocTypes, priority, source, sourceFile, createdBy }) {
  const row = {
    employee_id: employeeId,
    team_id: teamId || null,
    policy_type: policyType,
    title,
    content,
    structured: structured || {},
    applies_to_doc_types: appliesToDocTypes || [],
    priority: priority || 0,
    source: source || 'manual',
    source_file: sourceFile || null,
    created_by: createdBy || null,
  };

  const { data, error } = await supabase.from(TABLE).insert(row).select().single();
  if (error) throw new Error(`createPolicy failed: ${error.message}`);
  return data;
}

/**
 * Update an existing policy.
 */
export async function updatePolicy(policyId, updates) {
  const allowed = ['title', 'content', 'structured', 'applies_to_doc_types', 'priority', 'active', 'policy_type'];
  const filtered = Object.fromEntries(Object.entries(updates).filter(([k]) => allowed.includes(k)));

  const { data, error } = await supabase.from(TABLE).update(filtered).eq('id', policyId).select().single();
  if (error) throw new Error(`updatePolicy failed: ${error.message}`);
  return data;
}

/**
 * Deactivate a policy (soft delete).
 */
export async function deactivatePolicy(policyId) {
  return updatePolicy(policyId, { active: false });
}

/**
 * Delete a policy permanently.
 */
export async function deletePolicy(policyId) {
  const { error } = await supabase.from(TABLE).delete().eq('id', policyId);
  if (error) throw new Error(`deletePolicy failed: ${error.message}`);
}

/**
 * List policies for an employee, optionally filtered by type and doc_type.
 */
export async function listPolicies(employeeId, { policyType, docType, activeOnly = true } = {}) {
  let query = supabase
    .from(TABLE)
    .select('*')
    .eq('employee_id', employeeId)
    .order('priority', { ascending: false })
    .order('created_at', { ascending: false });

  if (activeOnly) query = query.eq('active', true);
  if (policyType) query = query.eq('policy_type', policyType);
  if (docType) query = query.or(`applies_to_doc_types.cs.{${docType}},applies_to_doc_types.eq.{}`);

  const { data, error } = await query;
  if (error) throw new Error(`listPolicies failed: ${error.message}`);
  return data || [];
}

/**
 * Get all policies relevant to a specific doc type, sorted by priority.
 */
export async function getPoliciesForDocType(employeeId, docType) {
  const all = await listPolicies(employeeId, { activeOnly: true });
  return all.filter(p => {
    if (!p.applies_to_doc_types?.length) return true; // applies to all
    return p.applies_to_doc_types.includes(docType);
  });
}

// ─── Handbook Upload & Extraction ────────────────────────────

/**
 * Extract policies from a text document (handbook, SOP, style guide).
 * Uses LLM to parse natural language into structured policies.
 *
 * @param {string} text - full text of the handbook/document
 * @param {object} meta - { employeeId, teamId, sourceFile, createdBy }
 * @param {Function} llmFn - async (prompt) => string
 * @returns {Array<Policy>} created policies
 */
export async function extractPoliciesFromText(text, meta, llmFn) {
  if (!llmFn) throw new Error('LLM function required for policy extraction');

  const truncated = text.slice(0, 8000); // limit context

  const prompt = `You are a policy extraction assistant. Extract all actionable policies, rules, and definitions from the following company document.

For each policy, return a JSON array of objects with:
- policy_type: one of "glossary", "naming_convention", "kpi_definition", "formatting_rule", "tone_guide", "prohibited_terms", "sop", "template_rule", "custom"
- title: short title for the policy (max 80 chars)
- content: the policy rule in natural language
- structured: optional JSON object with structured data (e.g. for glossary: {"term": "...", "definition": "..."}, for kpi: {"name": "...", "formula": "...", "target": "...", "unit": "..."})
- priority: 0 (low) to 10 (critical)

Document:
${truncated}

Respond ONLY with a valid JSON array. If no policies found, return [].`;

  try {
    const raw = await llmFn(prompt);
    const parsed = JSON.parse(raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
    if (!Array.isArray(parsed)) return [];

    const created = [];
    for (const p of parsed) {
      if (!p.title || !p.content) continue;
      const policy = await createPolicy({
        employeeId: meta.employeeId,
        teamId: meta.teamId,
        policyType: p.policy_type || 'custom',
        title: p.title,
        content: p.content,
        structured: p.structured || {},
        priority: p.priority || 0,
        source: 'handbook_upload',
        sourceFile: meta.sourceFile,
        createdBy: meta.createdBy,
      });
      created.push(policy);
    }
    return created;
  } catch (err) {
    console.error('[PolicyIngestion] extraction failed:', err);
    return [];
  }
}

// ─── Batch Import ────────────────────────────────────────────

/**
 * Import a batch of structured policies (e.g. from a CSV/JSON glossary).
 */
export async function importPoliciesBatch(employeeId, policies, createdBy) {
  const rows = policies.map(p => ({
    employee_id: employeeId,
    team_id: p.team_id || null,
    policy_type: p.policy_type || 'custom',
    title: p.title,
    content: p.content,
    structured: p.structured || {},
    applies_to_doc_types: p.applies_to_doc_types || [],
    priority: p.priority || 0,
    source: 'batch_import',
    created_by: createdBy,
  }));

  const { data, error } = await supabase.from(TABLE).insert(rows).select();
  if (error) throw new Error(`importPoliciesBatch failed: ${error.message}`);
  return data || [];
}

// ─── Search ──────────────────────────────────────────────────

/** Escape PostgREST filter special chars to prevent filter injection. */
function _sanitizeFilterValue(val) {
  return String(val).replace(/[,.()"\\]/g, '');
}

/**
 * Search policies by keyword (title + content).
 */
export async function searchPolicies(employeeId, keyword) {
  const safe = _sanitizeFilterValue(keyword);
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('employee_id', employeeId)
    .eq('active', true)
    .or(`title.ilike.%${safe}%,content.ilike.%${safe}%`)
    .order('priority', { ascending: false })
    .limit(20);

  if (error) throw new Error(`searchPolicies failed: ${error.message}`);
  return data || [];
}

/**
 * Build a policy summary string for injection into LLM context.
 * Groups by type and formats as a readable block.
 */
export function buildPolicySummary(policies) {
  if (!policies.length) return '';

  const grouped = {};
  for (const p of policies) {
    const type = p.policy_type || 'custom';
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push(p);
  }

  const lines = ['=== Company Policies ==='];
  for (const [type, items] of Object.entries(grouped)) {
    lines.push(`\n## ${type.replace(/_/g, ' ').toUpperCase()}`);
    for (const item of items) {
      lines.push(`- ${item.title}: ${item.content}`);
    }
  }

  return lines.join('\n');
}
