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

export function useDecisionOverview(userId) {
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function fetchOverview() {
      setLoading(true);
      const result = {
        coverage_level: null,
        missing_datasets: [],
        capabilities_summary: null,
        top_risks: [],
        estimated_ratio: null,
        import_quality: null,
        open_actions_count: 0,
      };

      try {
        // 1. Latest data quality report artifact
        const { data: dqArtifacts } = await supabase
          .from('di_artifacts')
          .select('payload')
          .eq('user_id', userId)
          .eq('artifact_type', 'data_quality_report')
          .order('created_at', { ascending: false })
          .limit(1);

        if (dqArtifacts?.[0]?.payload) {
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

        // 2. Latest plan run to get risk context
        const { data: planRuns } = await supabase
          .from('di_runs')
          .select('id, kpi_snapshot')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(1);

        // 3. Open action items count
        const { count } = await supabase
          .from('di_action_items')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .in('status', ['open', 'in_progress']);

        result.open_actions_count = count || 0;
      } catch (err) {
        // Non-blocking — return partial data
        console.warn('[useDecisionOverview] Partial load:', err.message);
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
