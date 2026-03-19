/**
 * useForecastData — Data hook for ForecastWidget live mode.
 *
 * Extracts the core forecast data pipeline from ForecastsView:
 * - Load forecast runs (from forecastRunsService)
 * - Load component demands for selected batch/run
 * - Provide material filtering and run selection
 *
 * The BOM explosion action itself stays in chat/DSV — this hook
 * only handles the *viewing* of forecast results.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';

/**
 * @param {object} opts
 * @param {object} opts.user - { id }
 */
export default function useForecastData({ user } = {}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Runs & batches
  const [forecastRuns, setForecastRuns] = useState([]);
  const [selectedRunId, setSelectedRunId] = useState(null);

  // Materials
  const [materials, setMaterials] = useState([]);
  const [selectedMaterial, setSelectedMaterial] = useState(null);

  // Forecast data
  const [componentDemands, setComponentDemands] = useState([]);
  const [traceRecords, setTraceRecords] = useState([]);

  // Tab state
  const [activeTab, setActiveTab] = useState('results');

  const loadRuns = useCallback(async () => {
    if (!user?.id) return;
    try {
      const { forecastRunsService } = await import('../../services/supabaseClient');
      const runs = await forecastRunsService.listRuns(user.id, { limit: 20 });
      setForecastRuns(runs || []);
      if (runs?.length) {
        setSelectedRunId(prev => prev || runs[0].id);
      }
    } catch (err) {
      console.error('useForecastData: failed to load runs:', err);
    }
  }, [user?.id]);

  const loadRunData = useCallback(async () => {
    if (!user?.id || !selectedRunId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);

    try {
      const { componentDemandService } = await import('../../services/supabaseClient');

      // Load component demands for this run
      const result = await componentDemandService.getComponentDemandsByForecastRun(
        user.id, selectedRunId, { limit: 2000 }
      );

      const demands = result?.data || result || [];
      setComponentDemands(demands);

      // Extract unique materials
      const mats = [...new Set(demands.map(d => d.material_code).filter(Boolean))].sort();
      setMaterials(mats);
      if (mats.length) {
        setSelectedMaterial(prev => (prev && mats.includes(prev) ? prev : mats[0]));
      }

      // Load trace records
      try {
        const { supabase } = await import('../../services/supabaseClient');
        const { data: traces } = await supabase
          .from('bom_explosion_trace')
          .select('*')
          .eq('user_id', user.id)
          .eq('forecast_run_id', selectedRunId)
          .order('created_at', { ascending: false })
          .limit(500);
        setTraceRecords(traces || []);
      } catch (_) {
        setTraceRecords([]);
      }
    } catch (err) {
      console.error('useForecastData: failed to load run data:', err);
      setError(err?.message || 'Failed to load forecast data');
    } finally {
      setLoading(false);
    }
  }, [user?.id, selectedRunId]);

  useEffect(() => { loadRuns(); }, [loadRuns]);
  useEffect(() => { loadRunData(); }, [loadRunData]);

  // Derive series for selected material (for chart display)
  const seriesData = useMemo(() => {
    if (!selectedMaterial || !componentDemands.length) return [];
    return componentDemands
      .filter(d => d.material_code === selectedMaterial)
      .map(d => ({
        period: d.time_bucket,
        p50: d.quantity || d.demand_qty || 0,
        p10: d.quantity_p10 || null,
        p90: d.quantity_p90 || null,
        plant_id: d.plant_id,
      }))
      .sort((a, b) => String(a.period).localeCompare(String(b.period)));
  }, [componentDemands, selectedMaterial]);

  // Summary metrics
  const metrics = useMemo(() => {
    const total = componentDemands.reduce((s, d) => s + (d.quantity || d.demand_qty || 0), 0);
    return {
      totalDemands: componentDemands.length,
      uniqueMaterials: materials.length,
      totalQuantity: total,
      traceCount: traceRecords.length,
    };
  }, [componentDemands, materials, traceRecords]);

  // Get active run metadata
  const activeRun = useMemo(() => {
    return forecastRuns.find(r => r.id === selectedRunId) || null;
  }, [forecastRuns, selectedRunId]);

  return {
    loading, error,
    // Runs
    forecastRuns, selectedRunId, setSelectedRunId, activeRun,
    // Materials
    materials, selectedMaterial, setSelectedMaterial,
    // Data
    componentDemands, traceRecords, seriesData, metrics,
    // Tabs
    activeTab, setActiveTab,
    // Actions
    refetch: loadRunData,
  };
}
