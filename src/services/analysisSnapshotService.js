// analysisSnapshotService.js
// ─────────────────────────────────────────────────────────────────────────────
// Persists structured AgentBrief snapshots to `analysis_snapshots` for the
// Insights Hub dashboard. Each snapshot is a lightweight extract that enables
// filtering, searching, and cross-report trend analysis without scanning
// raw conversation JSON.
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from './supabaseClient';

// ── Tag inference (zero-LLM) ────────────────────────────────────────────────

const TAG_PATTERNS = {
  revenue:    /revenue|營收|receita|faturamento|sales|銷售/i,
  cost:       /cost|成本|custo|despesa|expense|費用/i,
  customer:   /customer|客戶|cliente|user base|用戶/i,
  churn:      /churn|流失|cancelamento|attrition/i,
  inventory:  /inventory|stock|庫存|estoque|warehouse/i,
  forecast:   /forecast|predict|預測|previsão|projection/i,
  trend:      /trend|趨勢|tendência|over time|時間/i,
  comparison: /compare|比較|comparação|vs\b|versus/i,
  anomaly:    /anomal|異常|outlier|spike|deviation/i,
  supplier:   /supplier|vendor|供應商|fornecedor/i,
};

/**
 * Infer tags from brief headline + query text using regex patterns.
 * Supports EN, ZH, PT keywords.
 */
export function inferTags(brief, query) {
  const tags = new Set();
  const text = `${query || ''} ${brief?.headline || ''} ${brief?.summary || ''}`.toLowerCase();

  for (const [tag, pattern] of Object.entries(TAG_PATTERNS)) {
    if (pattern.test(text)) tags.add(tag);
  }

  return [...tags];
}

/**
 * Persist an AgentBrief snapshot to `analysis_snapshots`.
 *
 * Designed as fire-and-forget — callers should NOT await this in the critical path.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.conversationId
 * @param {number} params.messageIndex
 * @param {object} params.brief - AgentBrief object
 * @param {string} [params.query] - Original user question
 * @param {string} [params.toolCallsSummary] - Summary of tools used
 * @returns {Promise<string|null>} Snapshot id or null on failure
 */
export async function saveSnapshot({ userId, conversationId, messageIndex, brief, query, toolCallsSummary }) {
  if (!brief?.headline || !userId || !conversationId) return null;

  try {
    const row = {
      user_id: userId,
      conversation_id: conversationId,
      message_index: messageIndex,
      headline: brief.headline,
      summary: brief.summary || null,
      executive_summary: brief.executive_summary || null,
      metric_pills: brief.metric_pills || [],
      chart_specs: (brief.charts || []).map(c => ({
        type: c.type,
        data: (c.data || []).slice(0, 100),
        xKey: c.xKey,
        yKey: c.yKey,
        title: c.title,
        series: c.series,
        referenceLines: c.referenceLines,
        xAxisLabel: c.xAxisLabel,
        yAxisLabel: c.yAxisLabel,
      })),
      table_specs: brief.tables || [],
      key_findings: brief.key_findings || [],
      implications: brief.implications || [],
      caveats: brief.caveats || [],
      next_steps: brief.next_steps || [],
      tags: inferTags(brief, query),
      data_timestamp: new Date().toISOString(),
      query_text: query || null,
      tool_calls_summary: toolCallsSummary || null,
    };

    const { data, error } = await supabase
      .from('analysis_snapshots')
      .upsert(row, { onConflict: 'conversation_id,message_index' })
      .select('id')
      .single();

    if (error) {
      console.warn('[snapshot] save failed:', error.message);
      return null;
    }
    return data?.id || null;
  } catch (err) {
    console.warn('[snapshot] save error:', err?.message || err);
    return null;
  }
}

/**
 * Fetch snapshots for a user, most recent first.
 *
 * @param {string} userId
 * @param {object} [options]
 * @param {number} [options.limit=50]
 * @param {number} [options.offset=0]
 * @param {boolean} [options.pinnedOnly=false]
 * @param {string[]} [options.tags] - Filter by tags (AND logic)
 * @param {string} [options.search] - Full-text search query
 * @param {string} [options.since] - ISO date string, e.g. '2026-03-01'
 * @param {string} [options.until] - ISO date string
 * @returns {Promise<{data: object[], count: number}>}
 */
export async function fetchSnapshots(userId, options = {}) {
  const { limit = 50, offset = 0, pinnedOnly = false, tags, search, since, until } = options;

  let query = supabase
    .from('analysis_snapshots')
    .select('*', { count: 'exact' })
    .eq('user_id', userId)
    .eq('archived', false)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (pinnedOnly) query = query.eq('pinned', true);
  if (tags?.length) query = query.contains('tags', tags);
  if (since) query = query.gte('created_at', since);
  if (until) query = query.lte('created_at', until);
  if (search) {
    // FTS index covers headline || summary, but Supabase .textSearch() only targets one column.
    // Use .or() with ilike as a pragmatic workaround to search both columns.
    const pattern = `%${search}%`;
    query = query.or(`headline.ilike.${pattern},summary.ilike.${pattern}`);
  }

  const { data, count, error } = await query;
  if (error) {
    console.warn('[snapshot] fetch failed:', error.message);
    return { data: [], count: 0 };
  }
  return { data: data || [], count: count || 0 };
}

/**
 * Toggle the pinned state of a snapshot.
 */
export async function togglePin(snapshotId, pinned) {
  const { error } = await supabase
    .from('analysis_snapshots')
    .update({ pinned })
    .eq('id', snapshotId);

  if (error) console.warn('[snapshot] togglePin failed:', error.message);
  return !error;
}

/**
 * Archive a snapshot (soft delete).
 */
export async function archiveSnapshot(snapshotId) {
  const { error } = await supabase
    .from('analysis_snapshots')
    .update({ archived: true })
    .eq('id', snapshotId);

  if (error) console.warn('[snapshot] archive failed:', error.message);
  return !error;
}

/**
 * Backfill snapshots from existing conversations (client-side, uses current user session).
 * Scans all conversations for agent_response messages with briefs.
 *
 * @param {string} userId
 * @param {function} [onProgress] - Called with { scanned, created, total }
 * @returns {Promise<{ created: number, skipped: number }>}
 */
/**
 * Synthesize a brief from plain-text AI message content.
 * Extracts headline, summary, key findings, and metrics from unstructured text.
 */
function synthesizeBriefFromText(content) {
  if (!content || typeof content !== 'string') return null;
  const text = content.trim();

  // Skip short utility messages (step completed, errors, etc.)
  if (text.length < 150) return null;
  // Skip obvious non-analysis messages
  if (/^(Step |Task |Reuse |Blueprint |Negotiation option |No dataset|Could not|Please confirm)/i.test(text)) return null;

  // ── Headline: first meaningful line or sentence ──
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let headline = '';
  for (const line of lines) {
    // Skip markdown headers markers, but use their text
    const cleaned = line.replace(/^#{1,4}\s*/, '').replace(/^\*{1,2}/, '').replace(/\*{1,2}$/, '').trim();
    if (cleaned.length >= 10 && cleaned.length <= 120) {
      headline = cleaned;
      break;
    }
  }
  if (!headline) {
    // Fallback: first sentence
    const firstSentence = text.match(/^[^.!?\n]{10,120}[.!?]/);
    headline = firstSentence ? firstSentence[0] : text.slice(0, 80) + '...';
  }

  // ── Summary: first 2-3 meaningful sentences ──
  const sentences = text.match(/[^.!?\n]{15,}[.!?]/g) || [];
  const summary = sentences.slice(0, 3).join(' ').slice(0, 500) || text.slice(0, 500);

  // ── Key findings: lines that look like bullet points or numbered items ──
  const findings = [];
  for (const line of lines) {
    const match = line.match(/^[-•*]\s+(.{15,200})/) || line.match(/^\d+[.)]\s+(.{15,200})/);
    if (match) findings.push(match[1]);
    if (findings.length >= 5) break;
  }

  // ── Metric pills: extract "label: number" or "label = number" patterns ──
  const pills = [];
  const metricPatterns = [
    /(?:^|\s)([A-Za-z\u4e00-\u9fff]{2,20})\s*[:=：]\s*([R$€¥]?\s?[\d,.]+%?(?:\s?[KMBkm])?)/g,
    /(?:^|\s)(mean|median|avg|total|count|sum|max|min|p\d+|gini|std|stdev)\s*[:=：]\s*([\d,.]+%?)/gi,
  ];
  for (const pattern of metricPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null && pills.length < 6) {
      const label = match[1].trim();
      const value = match[2].trim();
      // Skip generic words that aren't metrics
      if (/^(the|and|for|with|from|this|that|have|will|can|but)$/i.test(label)) continue;
      if (value.length > 0 && label.length <= 30) {
        pills.push({ label, value });
      }
    }
  }

  // ── Implications / caveats / next steps from text patterns ──
  const implications = [];
  const caveats = [];
  const nextSteps = [];
  for (const line of lines) {
    const clean = line.replace(/^[-•*]\s*/, '').trim();
    if (/^(implication|this (means|suggests|indicates)|therefore)/i.test(clean) && clean.length > 20) {
      implications.push(clean.slice(0, 200));
    } else if (/^(caveat|limitation|note:|warning|however|keep in mind)/i.test(clean) && clean.length > 20) {
      caveats.push(clean.slice(0, 200));
    } else if (/^(next|recommend|suggest|consider|follow[- ]up|action item|todo)/i.test(clean) && clean.length > 15) {
      nextSteps.push(clean.slice(0, 200));
    }
  }

  return {
    headline,
    summary,
    metric_pills: pills,
    key_findings: findings,
    implications: implications.slice(0, 3),
    caveats: caveats.slice(0, 3),
    next_steps: nextSteps.slice(0, 3),
    charts: [],
    tables: [],
  };
}

/**
 * Backfill snapshots from existing conversations (client-side, uses current user session).
 * Handles both structured (agent_response with brief) and plain-text AI messages.
 *
 * @param {string} userId
 * @param {function} [onProgress] - Called with { scanned, created, total }
 * @returns {Promise<{ created: number, skipped: number }>}
 */
export async function backfillFromConversations(userId, onProgress) {
  const { data: conversations, error } = await supabase
    .from('conversations')
    .select('id, messages')
    .eq('user_id', userId);

  if (error) {
    console.warn('[snapshot] backfill: failed to fetch conversations:', error.message);
    return { created: 0, skipped: 0 };
  }

  const total = conversations?.length || 0;
  console.info(`[snapshot] backfill: found ${total} conversations`);

  let created = 0;
  let skipped = 0;

  for (let ci = 0; ci < total; ci++) {
    const conv = conversations[ci];
    const messages = conv.messages || [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== 'ai' && msg.role !== 'assistant') continue;

      // Strategy 1: structured agent_response with brief
      let brief = null;
      if (msg.type === 'agent_response' && msg.payload?.brief?.headline) {
        brief = msg.payload.brief;
      } else if (msg.payload?.headline) {
        brief = msg.payload;
      } else if (msg.payload?.candidates?.[0]?.brief?.headline) {
        brief = msg.payload.candidates[0].brief;
      }

      // Strategy 2: synthesize brief from plain text content
      if (!brief?.headline && typeof msg.content === 'string') {
        brief = synthesizeBriefFromText(msg.content);
      }

      if (!brief?.headline) continue;

      // Find the preceding user message as query
      const prevMsg = messages[i - 1];
      const queryText = (prevMsg?.role === 'user' || prevMsg?.role === 'human')
        ? (typeof prevMsg.content === 'string' ? prevMsg.content : '')
        : '';

      const result = await saveSnapshot({
        userId,
        conversationId: conv.id,
        messageIndex: i,
        brief,
        query: queryText,
      });

      if (result) created++;
      else skipped++;
    }

    onProgress?.({ scanned: ci + 1, created, total });
  }

  console.info(`[snapshot] backfill complete: ${total} conversations, ${created} created, ${skipped} skipped`);
  return { created, skipped };
}
