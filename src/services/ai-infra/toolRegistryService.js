// @product: ai-employee
//
// toolRegistryService.js
// ─────────────────────────────────────────────────────────────────────────────
// Persistent tool registry for AI-generated code that has been approved by a
// human reviewer. Tools are stored in `tool_registry` (Supabase) with
// localStorage fallback. Each tool carries its source code, I/O schemas, and
// a quality score derived from AI reviews.
//
// Reuse flow:
//   chatTaskDecomposer → findToolByHint() → if match, use 'registered_tool'
//   workflow_type instead of 'dynamic_tool', skipping code generation.
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from '../infra/supabaseClient';

// ── Constants ────────────────────────────────────────────────────────────────

const LOCAL_TOOLS_KEY = 'tool_registry_v1';
const MAX_LOCAL_TOOLS = 200;

export const TOOL_CATEGORIES = {
  SOLVER:    'solver',
  ML_MODEL:  'ml_model',
  TRANSFORM: 'transform',
  REPORT:    'report',
  ANALYSIS:  'analysis',
  CUSTOM:    'custom',
};

export const TOOL_STATUS = {
  DRAFT:      'draft',
  ACTIVE:     'active',
  DEPRECATED: 'deprecated',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function now() { return new Date().toISOString(); }

function uuid() {
  return `local-tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function trySupabase(fn) {
  try {
    if (!supabase) return null;
    return await fn();
  } catch (err) {
    console.warn('[toolRegistryService] Supabase call failed:', err?.message || err);
    return null;
  }
}

function getLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_TOOLS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveLocal(tools) {
  try {
    const trimmed = tools.slice(0, MAX_LOCAL_TOOLS);
    localStorage.setItem(LOCAL_TOOLS_KEY, JSON.stringify(trimmed));
  } catch { /* quota */ }
}

// ── Hash ─────────────────────────────────────────────────────────────────────

export async function hashCode(code) {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf = new TextEncoder().encode(code);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // Fallback: simple string hash
  let h = 0;
  for (let i = 0; i < code.length; i++) {
    h = ((h << 5) - h + code.charCodeAt(i)) | 0;
  }
  return `hash-${Math.abs(h).toString(36)}`;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Register a new tool (initially as 'draft').
 */
export async function registerTool({
  name, description, category, code, inputSchema, outputSchema,
  taskId = null, approvedBy = null, tags = [],
}) {
  const codeHash = await hashCode(code);

  const row = {
    name,
    description: description || '',
    category: category || TOOL_CATEGORIES.CUSTOM,
    code,
    code_hash: codeHash,
    input_schema: inputSchema || {},
    output_schema: outputSchema || {},
    created_by_task_id: taskId,
    approved_by: approvedBy,
    approved_at: approvedBy ? now() : null,
    usage_count: 0,
    quality_score: 0,
    status: approvedBy ? TOOL_STATUS.ACTIVE : TOOL_STATUS.DRAFT,
    tags,
    created_at: now(),
    updated_at: now(),
  };

  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('tool_registry')
      .insert(row)
      .select()
      .single();
    if (error) throw error;
    return data;
  });

  if (sbResult) return sbResult;

  // localStorage fallback
  const local = getLocal();
  const entry = { id: uuid(), ...row };
  local.unshift(entry);
  saveLocal(local);
  return entry;
}

/**
 * Find a tool by fuzzy hint + category match.
 * Returns the best-matching active tool, or null.
 */
export async function findToolByHint(hint, category = null) {
  if (!hint) return null;
  const keywords = hint.toLowerCase().split(/\s+/).filter(Boolean);

  const sbResult = await trySupabase(async () => {
    let q = supabase
      .from('tool_registry')
      .select('*')
      .eq('status', 'active')
      .gte('quality_score', 0.7)
      .order('quality_score', { ascending: false })
      .limit(20);
    if (category) q = q.eq('category', category);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  });

  const candidates = sbResult || getLocal().filter(t =>
    t.status === 'active' && (t.quality_score || 0) >= 0.7 &&
    (!category || t.category === category)
  );

  if (!candidates.length) return null;

  // Score each candidate by keyword overlap
  let best = null;
  let bestScore = 0;
  for (const tool of candidates) {
    const text = `${tool.name} ${tool.description} ${(tool.tags || []).join(' ')}`.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (text.includes(kw)) score++;
    }
    if (score > bestScore) { bestScore = score; best = tool; }
  }

  return bestScore > 0 ? best : null;
}

/**
 * Get tool by ID.
 */
export async function getToolById(toolId) {
  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('tool_registry')
      .select('*')
      .eq('id', toolId)
      .single();
    if (error) throw error;
    return data;
  });

  if (sbResult) return sbResult;
  return getLocal().find(t => t.id === toolId) || null;
}

/**
 * List tools with optional filter.
 */
export async function listTools({ category, status } = {}) {
  const sbResult = await trySupabase(async () => {
    let q = supabase.from('tool_registry').select('*').order('updated_at', { ascending: false });
    if (category) q = q.eq('category', category);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    return data;
  });

  if (sbResult) return sbResult;

  let tools = getLocal();
  if (category) tools = tools.filter(t => t.category === category);
  if (status) tools = tools.filter(t => t.status === status);
  return tools;
}

/**
 * Approve a draft tool → active.
 */
export async function approveTool(toolId, approvedBy, qualityScore = null) {
  const updates = {
    status: TOOL_STATUS.ACTIVE,
    approved_by: approvedBy,
    approved_at: now(),
    updated_at: now(),
  };
  if (qualityScore != null) updates.quality_score = qualityScore;

  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('tool_registry')
      .update(updates)
      .eq('id', toolId)
      .select()
      .single();
    if (error) throw error;
    return data;
  });

  if (sbResult) return sbResult;

  const tools = getLocal();
  const idx = tools.findIndex(t => t.id === toolId);
  if (idx >= 0) { Object.assign(tools[idx], updates); saveLocal(tools); return tools[idx]; }
  return null;
}

/**
 * Deprecate a tool.
 */
export async function deprecateTool(toolId) {
  const updates = { status: TOOL_STATUS.DEPRECATED, updated_at: now() };

  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('tool_registry')
      .update(updates)
      .eq('id', toolId)
      .select()
      .single();
    if (error) throw error;
    return data;
  });

  if (sbResult) return sbResult;

  const tools = getLocal();
  const idx = tools.findIndex(t => t.id === toolId);
  if (idx >= 0) { Object.assign(tools[idx], updates); saveLocal(tools); return tools[idx]; }
  return null;
}

/**
 * Increment usage count.
 */
export async function incrementUsage(toolId) {
  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .rpc('increment_tool_usage', { tool_id: toolId });
    if (error) {
      // Fallback: read-modify-write
      const { data: tool } = await supabase.from('tool_registry').select('usage_count').eq('id', toolId).single();
      if (tool) {
        await supabase.from('tool_registry').update({
          usage_count: (tool.usage_count || 0) + 1,
          updated_at: now(),
        }).eq('id', toolId);
      }
    }
    return data;
  });

  if (!sbResult) {
    const tools = getLocal();
    const idx = tools.findIndex(t => t.id === toolId);
    if (idx >= 0) { tools[idx].usage_count = (tools[idx].usage_count || 0) + 1; saveLocal(tools); }
  }
}

/**
 * Update quality score for a tool.
 */
export async function updateQualityScore(toolId, score) {
  const clamped = Math.max(0, Math.min(1, score));
  const updates = { quality_score: clamped, updated_at: now() };

  await trySupabase(async () => {
    await supabase.from('tool_registry').update(updates).eq('id', toolId);
  });

  const tools = getLocal();
  const idx = tools.findIndex(t => t.id === toolId);
  if (idx >= 0) { Object.assign(tools[idx], updates); saveLocal(tools); }
}
