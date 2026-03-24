#!/usr/bin/env node
// backfillSnapshots.js
// ─────────────────────────────────────────────────────────────────────────────
// One-time script to backfill analysis_snapshots from existing conversations.
// Scans all conversations for assistant messages containing AgentBrief payloads
// and writes a snapshot row for each.
//
// Usage: node scripts/backfillSnapshots.js [--user-id <uuid>] [--dry-run]
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY env vars');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Tag inference (duplicated from analysisSnapshotService for standalone use) ──

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

function inferTags(brief, query) {
  const tags = new Set();
  const text = `${query || ''} ${brief?.headline || ''} ${brief?.summary || ''}`.toLowerCase();
  for (const [tag, pattern] of Object.entries(TAG_PATTERNS)) {
    if (pattern.test(text)) tags.add(tag);
  }
  return [...tags];
}

/**
 * Extract AgentBrief from an assistant message.
 * Handles both agent_response (payload.brief) and raw brief objects.
 */
function extractBrief(msg) {
  if (msg.type === 'agent_response' && msg.payload?.brief) {
    return msg.payload.brief;
  }
  if (msg.payload?.headline) {
    return msg.payload;
  }
  return null;
}

async function backfill({ userId, dryRun }) {
  let query = supabase
    .from('conversations')
    .select('id, user_id, messages')
    .eq('workspace', 'di');

  if (userId) query = query.eq('user_id', userId);

  const { data: conversations, error } = await query;
  if (error) {
    console.error('Failed to fetch conversations:', error.message);
    process.exit(1);
  }

  console.log(`Found ${conversations.length} conversations to scan.`);
  let created = 0;
  let skipped = 0;

  for (const conv of conversations) {
    const messages = conv.messages || [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== 'ai' && msg.role !== 'assistant') continue;

      const brief = extractBrief(msg);
      if (!brief?.headline) continue;

      const prevMsg = messages[i - 1];
      const queryText = (prevMsg?.role === 'user' || prevMsg?.role === 'human')
        ? (typeof prevMsg.content === 'string' ? prevMsg.content : '')
        : '';

      const row = {
        user_id: conv.user_id,
        conversation_id: conv.id,
        message_index: i,
        headline: brief.headline,
        summary: brief.summary || null,
        executive_summary: brief.executive_summary || null,
        metric_pills: brief.metric_pills || [],
        chart_specs: (brief.charts || []).map(c => ({
          type: c.type,
          data: (c.data || []).slice(0, 100),
          xKey: c.xKey, yKey: c.yKey,
          title: c.title, series: c.series,
          referenceLines: c.referenceLines,
          xAxisLabel: c.xAxisLabel,
          yAxisLabel: c.yAxisLabel,
        })),
        table_specs: brief.tables || [],
        key_findings: brief.key_findings || [],
        implications: brief.implications || [],
        caveats: brief.caveats || [],
        next_steps: brief.next_steps || [],
        tags: inferTags(brief, queryText),
        data_timestamp: msg.timestamp || new Date().toISOString(),
        query_text: queryText || null,
      };

      if (dryRun) {
        console.log(`[DRY RUN] Would save: conv=${conv.id} msg=${i} headline="${brief.headline}"`);
        created++;
        continue;
      }

      const { error: upsertError } = await supabase
        .from('analysis_snapshots')
        .upsert(row, { onConflict: 'conversation_id,message_index' });

      if (upsertError) {
        console.warn(`  SKIP conv=${conv.id} msg=${i}: ${upsertError.message}`);
        skipped++;
      } else {
        created++;
      }
    }
  }

  console.log(`\nBackfill complete: ${created} snapshots ${dryRun ? 'would be ' : ''}created, ${skipped} skipped.`);
}

// ── CLI ──

const args = process.argv.slice(2);
const userId = args.includes('--user-id') ? args[args.indexOf('--user-id') + 1] : null;
const dryRun = args.includes('--dry-run');

backfill({ userId, dryRun });
