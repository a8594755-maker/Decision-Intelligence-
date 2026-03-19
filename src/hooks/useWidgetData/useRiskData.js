/**
 * useRiskData — Data hook for RiskWidget live mode.
 *
 * Extracts the full risk data pipeline from RiskDashboardView:
 * 1. Load forecast runs, PO, inventory, financials, safety stock, suppliers
 * 2. Normalize PO, aggregate component demand
 * 3. Calculate coverage risk, inventory risk, profit-at-risk
 * 4. Map to UI format with action recommendations
 *
 * Returns ready-to-render data for RiskWidget in live mode.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';

const HORIZON_BUCKETS = 3;
const DEFAULT_LEAD_TIME_DAYS = 7;

/**
 * @param {object} opts
 * @param {object} opts.user - { id }
 * @param {string} [opts.globalDataSource] - 'sap' | 'local'
 */
export default function useRiskData({ user, globalDataSource } = {}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [uiRows, setUiRows] = useState([]);

  // Forecast run selection
  const [forecastRunsList, setForecastRunsList] = useState([]);
  const [selectedForecastRunId, setSelectedForecastRunId] = useState(null);
  const [activeForecastRun, setActiveForecastRun] = useState(null);

  // Filtering
  const [plants, setPlants] = useState(['all']);
  const [selectedPlant, setSelectedPlant] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRiskLevel, setSelectedRiskLevel] = useState('all');

  // Details
  const [selectedRow, setSelectedRow] = useState(null);

  // View mode
  const [viewMode, setViewMode] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('riskDashboardView');
      if (['table', 'grid', 'list'].includes(saved)) return saved;
    }
    return 'table';
  });

  // Profit summary
  const [profitSummary, setProfitSummary] = useState({
    totalProfitAtRisk: 0,
    criticalProfitAtRisk: 0,
    warningProfitAtRisk: 0,
    itemsWithRealFinancials: 0,
    itemsWithAssumption: 0,
    usingFallback: false,
  });

  // Diagnostics
  const [diagnostics, setDiagnostics] = useState({
    inventoryPairs: 0, poPairs: 0, unionPairs: 0, matchedPairs: 0,
    inboundPairsInHorizon: 0, demandKeysWithoutRiskRow: 0, riskRowsWithoutDemand: 0,
  });

  const loadRiskData = useCallback(async () => {
    if (!user?.id) { setLoading(false); return; }

    setLoading(true);
    setError(null);

    let cancelled = false;
    const timeoutId = setTimeout(() => {
      cancelled = true;
      setLoading(false);
      setError({ type: 'error', message: 'Connection timed out', hint: 'Supabase may be paused.' });
    }, 15000);

    try {
      // Dynamic imports to avoid bundling in artifact mode
      const [
        { supabase, forecastRunsService, componentDemandService },
        { calculateSupplyCoverageRiskBatch },
        { calculateInventoryRisk },
        { calculateProfitAtRiskBatch },
        { mapSupplyCoverageToUI },
        { normalizeOpenPOBatch },
        { aggregateComponentDemandToDaily, normalizeKey },
      ] = await Promise.all([
        import('../../services/supabaseClient'),
        import('../../domains/risk/coverageCalculator.js'),
        import('../../domains/inventory/calculator.js'),
        import('../../domains/risk/profitAtRiskCalculator.js'),
        import('../../components/risk/mapDomainToUI'),
        import('../../utils/poNormalizer'),
        import('../../utils/componentDemandAggregator'),
      ]);

      // Step 0: Forecast Runs
      let runsList = [];
      try {
        runsList = await forecastRunsService.listRuns(user.id, { limit: 30 });
        setForecastRunsList(runsList || []);
      } catch (e) {
        console.warn('useRiskData: failed to load forecast runs:', e);
      }

      const runId = selectedForecastRunId || runsList?.[0]?.id || null;
      const runMeta = runId ? runsList.find(r => r.id === runId) || { id: runId } : null;
      setActiveForecastRun(runMeta);

      // Step 0.5: Component demand aggregation
      let componentDemandAggregated = {};
      if (runId) {
        try {
          const runParams = runMeta?.parameters || {};
          const timeBucketsFromRun = Array.isArray(runParams.time_buckets) ? runParams.time_buckets : null;
          const demandRows = await componentDemandService.getComponentDemandsByForecastRun(user.id, runId, {
            timeBuckets: timeBucketsFromRun || undefined,
          });
          componentDemandAggregated = aggregateComponentDemandToDaily(demandRows, HORIZON_BUCKETS, {
            timeBuckets: timeBucketsFromRun,
            horizonBuckets: timeBucketsFromRun ? undefined : HORIZON_BUCKETS,
            daysPerBucket: 7,
          });
        } catch (e) {
          console.warn('useRiskData: failed to load component_demand:', e);
        }
      }

      // Step 1: Open PO
      let poQuery = supabase.from('po_open_lines').select('*').eq('user_id', user.id);
      if (globalDataSource === 'sap') poQuery = poQuery.eq('source', 'sap_sync');
      else poQuery = poQuery.or('source.is.null,source.neq.sap_sync');
      poQuery = poQuery.order('time_bucket', { ascending: true });
      const { data: rawPoData, error: poError } = await poQuery;
      if (poError) throw new Error(`PO load failed: ${poError.message}`);
      if (!rawPoData?.length) throw new Error('EMPTY_PO_DATA');

      // Step 2: Inventory snapshots
      let inventoryData = [];
      let invQuery = supabase.from('material_stock_snapshots').select('*').eq('user_id', user.id);
      if (globalDataSource === 'sap') invQuery = invQuery.eq('source', 'sap_sync');
      else invQuery = invQuery.or('source.is.null,source.neq.sap_sync');
      const { data: invData } = await invQuery.order('snapshot_at', { ascending: false });
      inventoryData = invData || [];

      // Step 2.3: Safety stock
      const safetyStockMap = {};
      try {
        const { data: isData } = await supabase
          .from('inventory_snapshots').select('material_code, plant_id, safety_stock, onhand_qty').eq('user_id', user.id);
        (isData || []).forEach(row => {
          const key = normalizeKey(row.material_code, row.plant_id);
          if (key && key !== '|') safetyStockMap[key] = { safety_stock: parseFloat(row.safety_stock || 0), onhand_qty: parseFloat(row.onhand_qty || 0) };
        });
      } catch (_) { /* fallback to 0 */ }

      // Step 2.5: Financials
      let financialsData = [];
      const { data: finData } = await supabase.from('fg_financials').select('*').eq('user_id', user.id);
      financialsData = finData || [];

      // Normalize PO
      const normalizedPOData = normalizeOpenPOBatch(rawPoData);
      if (!normalizedPOData.length) throw new Error('PO data empty after normalization');

      // Step 2.6: Suppliers for lead time
      let supplierIdToLeadDays = {};
      try {
        const { data: suppData } = await supabase.from('suppliers').select('id, lead_time_days').eq('user_id', user.id);
        (suppData || []).forEach(s => {
          const lt = parseFloat(s.lead_time_days);
          if (!isNaN(lt) && lt >= 0) supplierIdToLeadDays[s.id] = lt;
        });
      } catch (_) { /* use default */ }

      const keyToLeadTime = {};
      normalizedPOData.forEach(po => {
        const key = normalizeKey(po.item, po.factory);
        if (!key || key === '|' || keyToLeadTime[key]) return;
        const sid = po.supplierId || po._raw?.supplier_id;
        const days = sid ? supplierIdToLeadDays[sid] : undefined;
        keyToLeadTime[key] = typeof days === 'number' && days >= 0
          ? { leadTimeDays: days, source: 'supplier' }
          : { leadTimeDays: DEFAULT_LEAD_TIME_DAYS, source: 'fallback' };
      });

      // Step 3: Coverage risk calculation
      const domainResults = calculateSupplyCoverageRiskBatch({
        openPOs: normalizedPOData,
        inventorySnapshots: inventoryData.map(inv => {
          const key = normalizeKey(inv.material_code, inv.plant_id);
          const ssInfo = safetyStockMap[key];
          return {
            material_code: inv.material_code, plant_id: inv.plant_id,
            on_hand_qty: inv.qty, safety_stock: ssInfo?.safety_stock || 0,
            snapshot_date: inv.snapshot_at,
          };
        }),
        horizonBuckets: HORIZON_BUCKETS,
      });

      // Step 3.5: Inventory risk (daysToStockout / P(stockout))
      domainResults.forEach(row => {
        const itemKey = normalizeKey(row.material_code || row.item, row.plant_id || row.factory);
        const demandInfo = componentDemandAggregated[itemKey];
        const dailyDemand = demandInfo?.dailyDemand;
        const onHand = row.onHand ?? 0;
        const safetyStock = row.safetyStock ?? 0;
        const ltInfo = keyToLeadTime[itemKey] || { leadTimeDays: DEFAULT_LEAD_TIME_DAYS, source: 'fallback' };
        row.leadTimeDaysUsed = ltInfo.leadTimeDays;
        row.leadTimeDaysSource = ltInfo.source;

        if (typeof dailyDemand === 'number' && dailyDemand > 0) {
          try {
            const invRisk = calculateInventoryRisk({ currentStock: onHand, safetyStock, dailyDemand, leadTimeDays: ltInfo.leadTimeDays, demandVolatility: 0.1 });
            row.daysToStockout = invRisk.daysToStockout;
            row.stockoutProbability = invRisk.probability;
          } catch (_) { /* skip */ }
        }
      });

      // Step 4: Profit at risk
      const { rows: rowsWithProfit, summary: profitSummaryData } = calculateProfitAtRiskBatch({
        riskRows: domainResults, financials: financialsData, useFallback: true,
      });

      // Step 5: Map to UI format
      const warnings = [];
      const calculatedRows = rowsWithProfit.map(dr => {
        const rw = [];
        const uiRow = mapSupplyCoverageToUI(dr, rw);
        warnings.push(...rw);
        return uiRow;
      });

      setProfitSummary({ ...profitSummaryData, usingFallback: financialsData.length === 0 || profitSummaryData.itemsWithAssumption > 0 });

      // Extract unique plants
      const uniquePlants = new Set();
      calculatedRows.forEach(r => { if (r.plantId) uniquePlants.add(r.plantId); });
      setPlants(['all', ...Array.from(uniquePlants).sort()]);

      // Diagnostics
      const invPairs = new Set(), poPairs = new Set();
      inventoryData.forEach(inv => { const k = normalizeKey(inv.material_code || inv.item, inv.plant_id || inv.factory); if (k && k !== '|') invPairs.add(k); });
      normalizedPOData.forEach(po => { const k = normalizeKey(po.material_code || po.item, po.plant_id || po.factory); if (k && k !== '|') poPairs.add(k); });
      const matched = new Set([...poPairs].filter(k => invPairs.has(k)));
      const demandKeys = new Set(Object.keys(componentDemandAggregated));
      const union = new Set([...invPairs, ...poPairs]);
      setDiagnostics({
        inventoryPairs: invPairs.size, poPairs: poPairs.size, unionPairs: union.size,
        matchedPairs: matched.size, inboundPairsInHorizon: 0,
        demandKeysWithoutRiskRow: [...demandKeys].filter(k => !union.has(k)).length,
        riskRowsWithoutDemand: [...union].filter(k => !demandKeys.has(k)).length,
      });

      if (cancelled) return;
      setUiRows(calculatedRows);
    } catch (err) {
      if (cancelled) return;
      if (err.message === 'EMPTY_PO_DATA') {
        setError({ type: 'empty', message: 'No Open PO data', hint: 'Upload po_open_lines.xlsx' });
      } else {
        setError({ type: 'error', message: err.message || 'Loading failed' });
      }
    } finally {
      clearTimeout(timeoutId);
      if (!cancelled) setLoading(false);
    }
  }, [user?.id, selectedForecastRunId, globalDataSource]);

  useEffect(() => { loadRiskData(); }, [loadRiskData]);

  // Filtered + enriched rows
  const filteredRows = useMemo(() => {
    let rows = [...uiRows];
    if (selectedPlant !== 'all') rows = rows.filter(r => r.plantId === selectedPlant);
    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      rows = rows.filter(r => (r.item || '').toLowerCase().includes(term) || (r.materialCode || '').toLowerCase().includes(term));
    }
    if (selectedRiskLevel !== 'all') rows = rows.filter(r => r.riskLevel === selectedRiskLevel);
    return rows;
  }, [uiRows, selectedPlant, searchTerm, selectedRiskLevel]);

  // KPIs
  const kpis = useMemo(() => {
    const critical = filteredRows.filter(r => r.riskLevel === 'critical').length;
    const warning = filteredRows.filter(r => r.riskLevel === 'warning').length;
    return { criticalCount: critical, warningCount: warning, shortageWithinHorizon: critical + warning, totalItems: filteredRows.length };
  }, [filteredRows]);

  const handleViewModeChange = useCallback((mode) => {
    setViewMode(mode);
    localStorage.setItem('riskDashboardView', mode);
  }, []);

  const clearFilters = useCallback(() => {
    setSelectedPlant('all');
    setSearchTerm('');
    setSelectedRiskLevel('all');
  }, []);

  return {
    loading, error, uiRows, filteredRows, kpis, profitSummary, diagnostics,
    // Forecast run selection
    forecastRunsList, selectedForecastRunId, setSelectedForecastRunId, activeForecastRun,
    // Filtering
    plants, selectedPlant, setSelectedPlant,
    searchTerm, setSearchTerm,
    selectedRiskLevel, setSelectedRiskLevel,
    clearFilters,
    // View mode
    viewMode, setViewMode: handleViewModeChange,
    // Details
    selectedRow, setSelectedRow,
    // Actions
    refetch: loadRiskData,
  };
}
