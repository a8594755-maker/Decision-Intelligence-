/**
 * useDecisionOverview
 *
 * Fetches and consolidates the "Today's Decision Overview" data:
 * - Latest data quality report
 * - Latest risk scores (top 5)
 * - Latest import batch quality
 * - Open action item count
 */

import { useState, useEffect } from 'react';
import { supabase } from '../services/supabaseClient';

/* ── circuit-breaker: skip tables that returned 404 / schema-cache miss ── */
const TABLE_BLACKLIST_TTL_MS = 5 * 60 * 1000; // 5 minutes
const _unavailableTables = new Map(); // tableName → timestamp

function markTableUnavailable(table) {
  _unavailableTables.set(table, Date.now());
}

function isTableUnavailable(table) {
  const ts = _unavailableTables.get(table);
  if (ts == null) return false;
  if (Date.now() - ts > TABLE_BLACKLIST_TTL_MS) {
    _unavailableTables.delete(table);
    return false;
  }
  return true;
}

function isTableMissing(error) {
  if (!error) return false;
  const msg = (error.message || '').toLowerCase();
  const code = error.code || '';
  return (
    code === '42P01' ||
    code === 'PGRST204' ||
    code === 'PGRST205' ||
    msg.includes('schema cache') ||
    msg.includes('does not exist') ||
    msg.includes('not found') ||
    msg.includes('relation')
  );
}

function isColumnMissing(error) {
  if (!error) return false;
  const msg = (error.message || '').toLowerCase();
  const code = error.code || '';
  return code === '42703' || msg.includes('column') || msg.includes('does not exist');
}

export function useDecisionOverview(userId) {
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(() => Boolean(userId));

  useEffect(() => {
    let cancelled = false;

    if (!userId) {
      queueMicrotask(() => {
        if (!cancelled) {
          setOverview(null);
          setLoading(false);
        }
      });
      return () => { cancelled = true; };
    }

    queueMicrotask(() => {
      if (!cancelled) {
        setLoading(true);
      }
    });

    async function fetchOverview() {
      const result = {
        coverage_level: null,
        missing_datasets: [],
        capabilities_summary: null,
        top_risks: [],
        estimated_ratio: null,
        import_quality: null,
        open_actions_count: 0,
      };

      // 1. Latest data quality report artifact
      if (!isTableUnavailable('di_artifacts')) {
        try {
          const { data: dqArtifacts, error } = await supabase
            .from('di_artifacts')
            .select('payload')
            .eq('user_id', userId)
            .eq('artifact_type', 'data_quality_report')
            .order('created_at', { ascending: false })
            .limit(1);

          if (error && isTableMissing(error)) {
            markTableUnavailable('di_artifacts');
          } else if (dqArtifacts?.[0]?.payload) {
            const dq = typeof dqArtifacts[0].payload === 'string'
              ? JSON.parse(dqArtifacts[0].payload)
              : dqArtifacts[0].payload;
            result.coverage_level = dq.coverage_level;
            result.missing_datasets = dq.missing_datasets || [];
            result.capabilities_summary = dq.capabilities;
            if (dq.row_stats) {
              const total = dq.row_stats.total || 0;
              const withFallback = dq.row_stats.with_fallback || 0;
              result.estimated_ratio = total > 0
                ? { estimated: withFallback, verified: total - withFallback, total }
                : null;
            }
            result.import_quality = dq.import_quality;
          }
        } catch {
          markTableUnavailable('di_artifacts');
        }
      }

      // 2. Latest plan run to get risk context
      if (!isTableUnavailable('di_runs')) {
        try {
          const { error } = await supabase
            .from('di_runs')
            .select('id')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(1);

          if (error && (isTableMissing(error) || isColumnMissing(error))) {
            markTableUnavailable('di_runs');
          }
        } catch {
          markTableUnavailable('di_runs');
        }
      }

      // 3. Open action items count
      if (!isTableUnavailable('di_action_items')) {
        try {
          const { count, error } = await supabase
            .from('di_action_items')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId)
            .in('status', ['open', 'in_progress']);

          if (error && isTableMissing(error)) {
            markTableUnavailable('di_action_items');
          } else {
            result.open_actions_count = count || 0;
          }
        } catch {
          markTableUnavailable('di_action_items');
        }
      }

      if (!cancelled) {
        setOverview(result);
        setLoading(false);
      }
    }

    fetchOverview();
    return () => { cancelled = true; };
  }, [userId]);

  return { overview, loading };
}
