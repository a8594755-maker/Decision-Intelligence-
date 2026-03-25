import React, { useState, useEffect } from 'react';
import {
  DollarSign, TrendingUp, TrendingDown, AlertTriangle, Sparkles,
  Plus, Calendar, BarChart3, PieChart, Loader2, CheckCircle, X,
  AlertCircle, RefreshCw, Download, Package, Briefcase, Search,
  ChevronDown, ChevronRight, Layers, Target
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, ComposedChart, Line
} from 'recharts';
import ReactMarkdown from 'react-markdown';
import { Card, Button, Badge } from '../components/ui';
import { SimpleLineChart, SimpleBarChart } from '../components/charts';
import * as costAnalysisService from '../services/forecast/costAnalysisService';
import * as materialCostService from '../services/sap-erp/materialCostService';
import { analyzeCostAnomaly, generateCostOptimizationSuggestions, callGeminiAPI } from '../services/ai-infra/geminiAPI';

const ABC_COLORS = { A: '#ef4444', B: '#f59e0b', C: '#22c55e' };
const CHART_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#6366f1', '#f43f5e'];

/**
 * Cost Analysis View
 * Features: Daily cost recording, trend analysis, anomaly detection, AI suggestions
 */
export default function CostAnalysisView({ addNotification, user, setView }) {
  // View Mode: 'operational' or 'material'
  const [viewMode, setViewMode] = useState('material');

  // Operational Cost State
  const [loading, setLoading] = useState(false);
  const [costRecords, setCostRecords] = useState([]);
  const [trends, setTrends] = useState(null);
  const [costStructure, setCostStructure] = useState(null);
  const [anomalies, setAnomalies] = useState([]);
  const [selectedAnomaly, setSelectedAnomaly] = useState(null);
  const [aiAnalysis, setAiAnalysis] = useState('');
  const [aiOptimization, setAiOptimization] = useState('');
  const [analyzingAnomaly, setAnalyzingAnomaly] = useState(false);
  const [analyzingOptimization, setAnalyzingOptimization] = useState(false);
  const [selectedPeriod, setSelectedPeriod] = useState('30'); // 30, 60, 90 days

  // Material Cost State
  const [materialLoading, setMaterialLoading] = useState(false);
  const [materialKPIs, setMaterialKPIs] = useState(null);
  const [materialsWithPrices, setMaterialsWithPrices] = useState([]);
  const [selectedMaterial, setSelectedMaterial] = useState(null);
  const [materialTrend, setMaterialTrend] = useState(null);
  const [topMovers, setTopMovers] = useState([]);
  const [supplierComparison, setSupplierComparison] = useState([]);
  const [dataCoverage, setDataCoverage] = useState(null);
  const [materialAIOptimization, setMaterialAIOptimization] = useState('');
  const [analyzingMaterialAI, setAnalyzingMaterialAI] = useState(false);
  const [searchTerm, _setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState('all'); // 'all', 'increases', 'decreases'
  const [customRange, setCustomRange] = useState(null); // { startDate, endDate } or null
  const [showCustomRangePicker, setShowCustomRangePicker] = useState(false);
  const [priceDisplayMode, setPriceDisplayMode] = useState('price'); // 'price' or 'index'
  const [topBySpend, setTopBySpend] = useState([]);

  // Supplier Cost Analytics State
  const [spendConcentration, setSpendConcentration] = useState(null);
  const [priceAnomalies, setPriceAnomalies] = useState([]);
  const [supplierConcentration, setSupplierConcentration] = useState(null);

  // Load data based on view mode
  useEffect(() => {
    if (user?.id) {
      if (viewMode === 'operational') {
        loadOperationalData();
      } else {
        loadMaterialCostData();
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- loader functions are stable within these deps
  }, [user, selectedPeriod, customRange, viewMode]);

  // Load selected material trend when material changes
  useEffect(() => {
    if (user?.id && selectedMaterial && viewMode === 'material') {
      loadMaterialTrend();
      loadSupplierComparison();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- loader functions are stable within these deps
  }, [selectedMaterial, user, selectedPeriod, customRange, viewMode]);

  const loadOperationalData = async () => {
    setLoading(true);
    try {
      // Load cost trends
      const trendsData = await costAnalysisService.getCostTrends(user.id, parseInt(selectedPeriod));
      setTrends(trendsData);
      setCostRecords(trendsData.records || []);

      // Load today's cost structure
      const structureData = await costAnalysisService.analyzeCostStructure(user.id);
      setCostStructure(structureData);

      // Detect anomalies
      const anomaliesData = await costAnalysisService.detectCostAnomalies(user.id, 7);

      // Load stored anomalies
      const storedAnomalies = await costAnalysisService.getCostAnomalies(user.id, 'pending');
      setAnomalies(storedAnomalies);

      if (anomaliesData.length > 0) {
        addNotification(`Detected ${anomaliesData.length} cost anomalies`, 'warning');
      }
    } catch (error) {
      addNotification(`Load failed: ${error.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  const loadMaterialCostData = async () => {
    setMaterialLoading(true);
    try {
      const days = customRange ? null : parseInt(selectedPeriod);

      // Load KPIs
      const kpis = await materialCostService.getMaterialCostKPIs(user.id, days, customRange);
      setMaterialKPIs(kpis);

      // Load materials with prices
      const materials = await materialCostService.getMaterialsWithPrices(user.id, days, customRange);
      setMaterialsWithPrices(materials);

      // Load Top Movers
      const movers = await materialCostService.getTopMovers(user.id, days, customRange);
      setTopMovers(movers);

      // Load Top by Spend (if quantity data is available)
      const topSpend = await materialCostService.getTopBySpend(user.id, days, customRange, 10);
      setTopBySpend(topSpend);

      // Load ABC Spend Concentration
      const abcData = await materialCostService.getSpendConcentration(user.id, days, customRange);
      setSpendConcentration(abcData);

      // Load Price Anomalies
      const anomalyData = await materialCostService.detectPriceAnomalies(user.id, days, customRange);
      setPriceAnomalies(anomalyData);

      // Load Supplier Spend Concentration
      const supplierSpend = await materialCostService.getSupplierSpendConcentration(user.id, days, customRange);
      setSupplierConcentration(supplierSpend);

      // Load data coverage
      const coverage = await materialCostService.checkDataCoverage(user.id, days, customRange);
      setDataCoverage(coverage);

      // Auto-select first material if available
      if (materials.length > 0 && !selectedMaterial) {
        setSelectedMaterial(materials[0]);
      }
    } catch (error) {
      addNotification(`Load material cost data failed: ${error.message}`, 'error');
    } finally {
      setMaterialLoading(false);
    }
  };

  const loadMaterialTrend = async () => {
    if (!selectedMaterial) return;

    try {
      const days = customRange ? null : parseInt(selectedPeriod);
      const trend = await materialCostService.getMaterialPriceTrend(
        user.id,
        selectedMaterial.id,
        days,
        customRange
      );
      setMaterialTrend(trend);
    } catch (error) {
      addNotification(`Load material trend failed: ${error.message}`, 'error');
    }
  };

  const loadSupplierComparison = async () => {
    if (!selectedMaterial) return;

    try {
      const days = customRange ? null : parseInt(selectedPeriod);
      const comparison = await materialCostService.getSupplierComparison(
        user.id,
        selectedMaterial.id,
        days,
        customRange
      );
      setSupplierComparison(comparison);
    } catch (error) {
      addNotification(`Load supplier comparison failed: ${error.message}`, 'error');
    }
  };


  // AI analyze anomaly
  const handleAnalyzeAnomaly = async (anomaly) => {
    setSelectedAnomaly(anomaly);
    setAnalyzingAnomaly(true);
    setAiAnalysis('');

    try {
      const analysis = await analyzeCostAnomaly(anomaly, trends?.records);
      setAiAnalysis(analysis);
    } catch (error) {
      addNotification(`AI analysis failed: ${error.message}`, 'error');
      setAiAnalysis('AI analysis service temporarily unavailable, please try again later.');
    } finally {
      setAnalyzingAnomaly(false);
    }
  };

  // AI optimization suggestions - Operational Cost
  const handleGenerateOptimization = async () => {
    if (!costStructure || !trends) {
      addNotification('Insufficient data to generate optimization suggestions', 'warning');
      return;
    }

    setAnalyzingOptimization(true);
    setAiOptimization('');

    try {
      const suggestions = await generateCostOptimizationSuggestions(costStructure, trends);
      setAiOptimization(suggestions);
    } catch (error) {
      addNotification(`Generate suggestions failed: ${error.message}`, 'error');
      setAiOptimization('AI service temporarily unavailable, please try again later.');
    } finally {
      setAnalyzingOptimization(false);
    }
  };

  // AI optimization suggestions - Material Cost
  const handleGenerateMaterialOptimization = async () => {
    if (!materialKPIs || topMovers.length === 0) {
      addNotification('Insufficient material cost data to generate suggestions', 'warning');
      return;
    }

    setAnalyzingMaterialAI(true);
    setMaterialAIOptimization('');

    try {
      const days = customRange ? null : parseInt(selectedPeriod);
      console.log('Generating AI context with:', { userId: user.id, days, customRange });
      
      const context = await materialCostService.generateAIContext(user.id, days, customRange);
      console.log('AI context generated:', context);

      const prompt = `You are a material cost optimization consultant. Based on the following material cost summary, explain what is happening, which materials and suppliers need attention, and suggest cost optimization actions.

Period: ${context.period}

KPIs:
- Total Materials with Price Data: ${context.kpis.totalMaterials}
- Average Price Change: ${context.kpis.avgPriceChange.toFixed(2)}%
- High Volatility Materials: ${context.kpis.highVolatilityCount}

Top Price Increasers:
${context.topIncreasers.map((m, i) => `${i + 1}. ${m.material}: ${m.oldPrice} → ${m.newPrice} (${m.changePercent}%)`).join('\n')}

Top Price Decreasers:
${context.topDecreasers.map((m, i) => `${i + 1}. ${m.material}: ${m.oldPrice} → ${m.newPrice} (${m.changePercent}%)`).join('\n')}

High Volatility Materials:
${context.highVolatility.map((m, i) => `${i + 1}. ${m.material}: Volatility ${m.volatility}%`).join('\n')}

Please provide in Chinese (Traditional):
1. Key insights about the cost situation
2. Materials that need immediate attention
3. Specific optimization suggestions (3-5 actionable items)
4. Supplier management recommendations`;

      console.log('Calling Gemini API with prompt length:', prompt.length);
      const suggestions = await callGeminiAPI(prompt, '', {
        temperature: 0.6,
        maxOutputTokens: 8192  // Increased from 2000 to allow longer responses
      });

      console.log('Gemini API response received, length:', suggestions?.length || 0);
      console.log('Gemini API response content:', suggestions);
      
      if (!suggestions || suggestions.trim().length === 0) {
        throw new Error('Gemini API returned empty response');
      }
      
      setMaterialAIOptimization(suggestions);
      addNotification('AI suggestions generated successfully', 'success');
    } catch (error) {
      console.error('AI generation error:', error);
      addNotification(`Generate material cost suggestions failed: ${error.message}`, 'error');
      setMaterialAIOptimization(`Error: ${error.message}\n\nPlease check the console for more details.`);
    } finally {
      setAnalyzingMaterialAI(false);
    }
  };

  // Resolve anomaly
  const handleResolveAnomaly = async (anomalyId, notes) => {
    try {
      await costAnalysisService.updateAnomalyStatus(anomalyId, 'resolved', notes);
      addNotification('Anomaly marked as resolved', 'success');
      loadOperationalData();
      setSelectedAnomaly(null);
      setAiAnalysis('');
    } catch (error) {
      addNotification(`Operation failed: ${error.message}`, 'error');
    }
  };


  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-xl md:text-2xl font-bold flex items-center gap-2">
            <DollarSign className="w-6 h-6 text-green-500" />
            Cost Analysis
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            {viewMode === 'operational'
              ? 'Record daily costs, track trends, detect anomalies, AI-powered analysis'
              : 'Analyze material prices, identify cost trends, optimize supplier selection'
            }
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            icon={RefreshCw}
            onClick={viewMode === 'operational' ? loadOperationalData : loadMaterialCostData}
            disabled={loading || materialLoading}
          >
            Refresh
          </Button>
        </div>
      </div>

      {/* View Mode Tabs */}
      <div className="flex gap-2 border-b border-slate-200 dark:border-slate-700">
        <button
          onClick={() => setViewMode('material')}
          className={`px-4 py-2 font-medium text-sm flex items-center gap-2 transition border-b-2 ${
            viewMode === 'material'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
          }`}
        >
          <Package className="w-4 h-4" />
          Material Cost
        </button>
        <button
          onClick={() => setViewMode('operational')}
          className={`px-4 py-2 font-medium text-sm flex items-center gap-2 transition border-b-2 ${
            viewMode === 'operational'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
          }`}
        >
          <Briefcase className="w-4 h-4" />
          Operational Cost
        </button>
      </div>

      {/* Period selector */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-slate-500">View Period:</span>
          {['30', '90', '180', '365'].map(days => (
            <button
              key={days}
              onClick={() => {
                setSelectedPeriod(days);
                setCustomRange(null);
              }}
              className={`px-3 py-1 rounded-lg text-sm font-medium transition ${
                selectedPeriod === days && !customRange
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600'
              }`}
            >
              {days} Days
            </button>
          ))}
          <button
            onClick={() => setShowCustomRangePicker(!showCustomRangePicker)}
            className={`px-3 py-1 rounded-lg text-sm font-medium transition ${
              customRange
                ? 'bg-purple-600 text-white'
                : 'bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600'
            }`}
          >
            Custom Range
          </button>
        </div>

        {/* Custom Range Picker */}
        {showCustomRangePicker && (
          <Card className="p-4 bg-slate-50 dark:bg-slate-800">
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Start Date</label>
                <input
                  type="date"
                  defaultValue={customRange?.startDate || ''}
                  onChange={(e) => {
                    const newRange = {
                      ...customRange,
                      startDate: e.target.value
                    };
                    if (newRange.startDate && newRange.endDate) {
                      setCustomRange(newRange);
                      setSelectedPeriod(null);
                    }
                  }}
                  className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">End Date</label>
                <input
                  type="date"
                  defaultValue={customRange?.endDate || ''}
                  onChange={(e) => {
                    const newRange = {
                      ...customRange,
                      endDate: e.target.value
                    };
                    if (newRange.startDate && newRange.endDate) {
                      setCustomRange(newRange);
                      setSelectedPeriod(null);
                    }
                  }}
                  className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-sm"
                />
              </div>
              <Button
                variant="secondary"
                onClick={() => {
                  setCustomRange(null);
                  setShowCustomRangePicker(false);
                  if (!selectedPeriod) setSelectedPeriod('30');
                }}
                className="text-sm py-1.5"
              >
                Clear
              </Button>
            </div>
          </Card>
        )}

        {/* Display selected range */}
        {customRange && customRange.startDate && customRange.endDate && (
          <div className="text-xs text-slate-600 dark:text-slate-400">
            <Calendar className="w-3 h-3 inline mr-1" />
            Selected Range: {customRange.startDate} ~ {customRange.endDate}
          </div>
        )}
      </div>

      {/* Material Cost View */}
      {viewMode === 'material' && (
        <>
          {/* Material Cost KPI Cards */}
          {materialKPIs && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
              <Card className="p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-xs text-slate-500 font-semibold uppercase">Materials with Price Data</div>
                    <div className="text-2xl font-bold text-blue-600 mt-1">
                      {materialKPIs.totalMaterials}
                    </div>
                    <div className="text-xs text-slate-500 mt-1">
                      {customRange ? 'In custom range' : `Last ${selectedPeriod} days`}
                    </div>
                  </div>
                  <div className="p-2 rounded-lg bg-blue-100 dark:bg-blue-900/30">
                    <Package className="w-5 h-5 text-blue-600" />
                  </div>
                </div>
              </Card>

              <Card className="p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-xs text-slate-500 font-semibold uppercase">Avg Price Change</div>
                    <div className={`text-2xl font-bold mt-1 ${
                      materialKPIs.avgPriceChange > 0 ? 'text-red-600' : 'text-green-600'
                    }`}>
                      {materialKPIs.avgPriceChange > 0 ? '+' : ''}{materialKPIs.avgPriceChange.toFixed(2)}%
                    </div>
                    <div className="text-xs text-slate-500 mt-1">Average across all materials</div>
                  </div>
                  <div className={`p-2 rounded-lg ${
                    materialKPIs.avgPriceChange > 0
                      ? 'bg-red-100 dark:bg-red-900/30'
                      : 'bg-green-100 dark:bg-green-900/30'
                  }`}>
                    {materialKPIs.avgPriceChange > 0 ? (
                      <TrendingUp className="w-5 h-5 text-red-600" />
                    ) : (
                      <TrendingDown className="w-5 h-5 text-green-600" />
                    )}
                  </div>
                </div>
              </Card>

              <Card className="p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-xs text-slate-500 font-semibold uppercase">Top Increase</div>
                    <div className="text-2xl font-bold text-orange-600 mt-1">
                      {materialKPIs.topIncreaseMaterial
                        ? `+${materialKPIs.topIncreaseMaterial.changePercent.toFixed(1)}%`
                        : 'N/A'
                      }
                    </div>
                    <div className="text-xs text-slate-500 mt-1 truncate">
                      {materialKPIs.topIncreaseMaterial?.material_code || 'No data'}
                    </div>
                  </div>
                  <div className="p-2 rounded-lg bg-orange-100 dark:bg-orange-900/30">
                    <TrendingUp className="w-5 h-5 text-orange-600" />
                  </div>
                </div>
              </Card>

              <Card className="p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-xs text-slate-500 font-semibold uppercase">High Volatility</div>
                    <div className="text-2xl font-bold text-purple-600 mt-1">
                      {materialKPIs.highVolatilityCount}
                    </div>
                    <div className="text-xs text-slate-500 mt-1">Materials &gt; 15% volatility</div>
                  </div>
                  <div className="p-2 rounded-lg bg-purple-100 dark:bg-purple-900/30">
                    <AlertTriangle className="w-5 h-5 text-purple-600" />
                  </div>
                </div>
              </Card>

              <Card className="p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-xs text-slate-500 font-semibold uppercase">Total Material Spend</div>
                    <div className="text-2xl font-bold text-emerald-600 mt-1">
                      {materialKPIs.totalMaterialSpend !== null
                        ? `$${materialKPIs.totalMaterialSpend.toLocaleString('en-US', {maximumFractionDigits: 0})}`
                        : 'N/A'
                      }
                    </div>
                    <div className="text-xs text-slate-500 mt-1">
                      {materialKPIs.hasQuantityData ? 'In selected period' : 'Qty data missing'}
                    </div>
                  </div>
                  <div className="p-2 rounded-lg bg-emerald-100 dark:bg-emerald-900/30">
                    <DollarSign className="w-5 h-5 text-emerald-600" />
                  </div>
                </div>
              </Card>
            </div>
          )}

          {/* Data Coverage Panel */}
          {dataCoverage && (
            <Card className={`p-4 ${
              dataCoverage.hasPriceData
                ? 'bg-blue-50 dark:bg-blue-900/20'
                : 'bg-yellow-50 dark:bg-yellow-900/20'
            }`}>
              <div className="flex items-start gap-3">
                <div className={`p-2 rounded-lg ${
                  dataCoverage.hasPriceData
                    ? 'bg-blue-100 dark:bg-blue-900/30'
                    : 'bg-yellow-100 dark:bg-yellow-900/30'
                }`}>
                  {dataCoverage.hasPriceData ? (
                    <CheckCircle className="w-5 h-5 text-blue-600" />
                  ) : (
                    <AlertCircle className="w-5 h-5 text-yellow-600" />
                  )}
                </div>
                <div className="flex-1">
                  <h3 className="text-sm font-semibold mb-2">
                    {dataCoverage.hasPriceData ? 'Data Coverage Status' : 'Missing Data'}
                  </h3>
                  <div className="space-y-1">
                    {dataCoverage.recommendations.map((rec, idx) => (
                      <p key={idx} className="text-sm text-slate-600 dark:text-slate-300">
                        {rec}
                      </p>
                    ))}
                  </div>
                  {dataCoverage.hasPriceData && (
                    <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 text-xs">
                      <div>
                        <span className="text-slate-500">Material Code:</span>
                        <span className="ml-1 font-semibold">{dataCoverage.coverage.material_code.toFixed(0)}%</span>
                      </div>
                      <div>
                        <span className="text-slate-500">Supplier:</span>
                        <span className="ml-1 font-semibold">{dataCoverage.coverage.supplier_name.toFixed(0)}%</span>
                      </div>
                      <div>
                        <span className="text-slate-500">Currency:</span>
                        <span className="ml-1 font-semibold">{dataCoverage.coverage.currency.toFixed(0)}%</span>
                      </div>
                      <div>
                        <span className="text-slate-500">Quantity:</span>
                        <span className={`ml-1 font-semibold ${
                          dataCoverage.coverage.quantity > 0 ? 'text-green-600' : 'text-yellow-600'
                        }`}>
                          {dataCoverage.coverage.quantity > 0 ? `${dataCoverage.coverage.quantity.toFixed(0)}%` : 'N/A'}
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-500">Total Records:</span>
                        <span className="ml-1 font-semibold">{dataCoverage.totalRecords}</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </Card>
          )}

          {/* Material Price Trend Chart */}
          {materialsWithPrices.length > 0 && (
            <Card>
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-4">
                <div className="flex items-center gap-4">
                  <h3 className="text-lg font-semibold">Material Price Trend</h3>
                  {/* Price / Index Toggle */}
                  <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 rounded-lg p-1">
                    <button
                      onClick={() => setPriceDisplayMode('price')}
                      className={`px-2 py-1 text-xs font-medium rounded transition ${
                        priceDisplayMode === 'price'
                          ? 'bg-white dark:bg-slate-700 text-blue-600 shadow-sm'
                          : 'text-slate-600 dark:text-slate-400'
                      }`}
                    >
                      Price
                    </button>
                    <button
                      onClick={() => setPriceDisplayMode('index')}
                      className={`px-2 py-1 text-xs font-medium rounded transition ${
                        priceDisplayMode === 'index'
                          ? 'bg-white dark:bg-slate-700 text-blue-600 shadow-sm'
                          : 'text-slate-600 dark:text-slate-400'
                      }`}
                    >
                      Index (100)
                    </button>
                  </div>
                </div>
                <div className="relative w-full sm:w-64">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <select
                    value={selectedMaterial?.id || ''}
                    onChange={(e) => {
                      const mat = materialsWithPrices.find(m => m.id === e.target.value);
                      setSelectedMaterial(mat);
                    }}
                    className="w-full pl-10 pr-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                  >
                    {materialsWithPrices.map((mat, idx) => (
                      <option key={`material-${mat.id || 'unknown'}-${idx}`} value={mat.id}>
                        {mat.material_code} - {mat.material_name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {materialTrend && materialTrend.prices.length > 0 ? (
                <>
                  <SimpleLineChart
                    data={priceDisplayMode === 'index' 
                      ? materialTrend.prices.map(p => (p / materialTrend.prices[0]) * 100)
                      : materialTrend.prices
                    }
                    color="#3b82f6"
                    height={250}
                    yAxisRange={priceDisplayMode === 'price' ? materialTrend.dynamicYAxis : null}
                  />
                  <div className="mt-4 grid grid-cols-2 sm:grid-cols-5 gap-4 text-sm">
                    <div>
                      <div className="text-slate-500">Min Price</div>
                      <div className="font-bold text-green-600">
                        ${materialTrend.summary.minPrice.toFixed(2)}
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-500">Max Price</div>
                      <div className="font-bold text-red-600">
                        ${materialTrend.summary.maxPrice.toFixed(2)}
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-500">Avg Price</div>
                      <div className="font-bold text-blue-600">
                        ${materialTrend.summary.avgPrice.toFixed(2)}
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-500">Price Change</div>
                      <div className={`font-bold ${
                        materialTrend.summary.changePercent > 0 ? 'text-red-600' : 'text-green-600'
                      }`}>
                        {materialTrend.summary.changePercent > 0 ? '+' : ''}
                        {materialTrend.summary.changePercent.toFixed(2)}%
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-500">Volatility</div>
                      <div className={`font-bold ${
                        materialTrend.summary.volatility > 15 ? 'text-orange-600' : 'text-slate-600'
                      }`}>
                        {materialTrend.summary.volatility.toFixed(2)}%
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="text-center py-8 text-slate-400">
                  <p className="text-sm">No price trend data available for selected material</p>
                </div>
              )}
            </Card>
          )}

          {/* Supplier Comparison for Selected Material */}
          {selectedMaterial && supplierComparison.length > 0 && (
            <Card>
              <h3 className="text-lg font-semibold mb-4">
                Supplier Comparison for {selectedMaterial.material_code}
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-800">
                    <tr>
                      <th className="px-4 py-2 text-left">Supplier</th>
                      <th className="px-4 py-2 text-right">Latest Price</th>
                      <th className="px-4 py-2 text-right">Avg Price</th>
                      <th className="px-4 py-2 text-right">Change %</th>
                      <th className="px-4 py-2 text-right">Last Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {supplierComparison.map((supp, idx) => (
                      <tr key={`supplier-${supp.supplier_id || 'unknown'}-${idx}`} className="border-t dark:border-slate-700">
                        <td className="px-4 py-2">
                          <div className="font-medium">{supp.supplier_name}</div>
                          <div className="text-xs text-slate-500">{supp.supplier_code}</div>
                        </td>
                        <td className="px-4 py-2 text-right font-semibold">
                          {supp.currency} {supp.latestPrice.toFixed(2)}
                          {idx === 0 && (
                            <Badge type="success" className="ml-2">Lowest</Badge>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right">
                          {supp.currency} {supp.avgPrice.toFixed(2)}
                        </td>
                        <td className={`px-4 py-2 text-right font-semibold ${
                          supp.changePercent > 0 ? 'text-red-600' : 'text-green-600'
                        }`}>
                          {supp.changePercent > 0 ? '+' : ''}{supp.changePercent.toFixed(2)}%
                        </td>
                        <td className="px-4 py-2 text-right text-slate-500">
                          {supp.lastDate}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* Top Movers Table */}
          {topMovers.length > 0 && (
            <Card>
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-4">
                <h3 className="text-lg font-semibold">Top Movers</h3>
                <div className="flex gap-2">
                  <button
                    onClick={() => setFilterType('all')}
                    className={`px-3 py-1 rounded-lg text-xs font-medium transition ${
                      filterType === 'all'
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600'
                    }`}
                  >
                    All
                  </button>
                  <button
                    onClick={() => setFilterType('increases')}
                    className={`px-3 py-1 rounded-lg text-xs font-medium transition ${
                      filterType === 'increases'
                        ? 'bg-red-600 text-white'
                        : 'bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600'
                    }`}
                  >
                    Increases
                  </button>
                  <button
                    onClick={() => setFilterType('decreases')}
                    className={`px-3 py-1 rounded-lg text-xs font-medium transition ${
                      filterType === 'decreases'
                        ? 'bg-green-600 text-white'
                        : 'bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600'
                    }`}
                  >
                    Decreases
                  </button>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-800">
                    <tr>
                      <th className="px-4 py-2 text-left">Material</th>
                      <th className="px-4 py-2 text-left">Category</th>
                      <th className="px-4 py-2 text-right">Old Price</th>
                      <th className="px-4 py-2 text-right">Latest Price</th>
                      <th className="px-4 py-2 text-right">Change %</th>
                      <th className="px-4 py-2 text-right">Volatility</th>
                      <th className="px-4 py-2 text-right">Suppliers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topMovers
                      .filter(m => {
                        if (filterType === 'increases') return m.changePercent > 0;
                        if (filterType === 'decreases') return m.changePercent < 0;
                        return true;
                      })
                      .filter(m => {
                        if (!searchTerm) return true;
                        return m.material_code.toLowerCase().includes(searchTerm.toLowerCase()) ||
                               m.material_name.toLowerCase().includes(searchTerm.toLowerCase());
                      })
                      .slice(0, 20)
                      .map((mover, idx) => (
                        <tr key={`mover-${mover.material_id || 'unknown'}-${idx}`} className="border-t dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800">
                          <td className="px-4 py-2">
                            <div className="font-medium">{mover.material_code}</div>
                            <div className="text-xs text-slate-500 truncate max-w-xs">
                              {mover.material_name}
                            </div>
                          </td>
                          <td className="px-4 py-2 text-slate-600 dark:text-slate-400">
                            {mover.category || 'N/A'}
                          </td>
                          <td className="px-4 py-2 text-right">
                            {mover.currency} {mover.oldestPrice.toFixed(2)}
                          </td>
                          <td className="px-4 py-2 text-right font-semibold">
                            {mover.currency} {mover.latestPrice.toFixed(2)}
                          </td>
                          <td className={`px-4 py-2 text-right font-bold ${
                            mover.changePercent > 0 ? 'text-red-600' : 'text-green-600'
                          }`}>
                            {mover.changePercent > 0 ? '+' : ''}{mover.changePercent.toFixed(2)}%
                          </td>
                          <td className={`px-4 py-2 text-right ${
                            mover.volatility > 15 ? 'text-orange-600 font-semibold' : 'text-slate-600'
                          }`}>
                            {mover.volatility.toFixed(2)}%
                          </td>
                          <td className="px-4 py-2 text-right">
                            {mover.supplierCount}
                          </td>
                        </tr>
                      ))
                    }
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* Top Materials by Spend */}
          {topBySpend.length > 0 && (
            <Card>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold">Top Materials by Spend</h3>
                <Badge type="info">{topBySpend.length} materials</Badge>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-800">
                    <tr>
                      <th className="px-4 py-2 text-left">Material</th>
                      <th className="px-4 py-2 text-left">Category</th>
                      <th className="px-4 py-2 text-right">Total Spend</th>
                      <th className="px-4 py-2 text-right">Total Qty</th>
                      <th className="px-4 py-2 text-right">Avg Price</th>
                      <th className="px-4 py-2 text-right">Price Change %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topBySpend.map((item, idx) => (
                      <tr key={`spend-${item.material_id || 'unknown'}-${idx}`} className="border-t dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800">
                        <td className="px-4 py-2">
                          <div className="font-medium">{item.material_code}</div>
                          <div className="text-xs text-slate-500 truncate max-w-xs">
                            {item.material_name}
                          </div>
                        </td>
                        <td className="px-4 py-2 text-slate-600 dark:text-slate-400">
                          {item.category}
                        </td>
                        <td className="px-4 py-2 text-right font-bold text-emerald-600">
                          ${item.totalSpend.toLocaleString('en-US', {maximumFractionDigits: 0})}
                          {idx === 0 && <Badge type="success" className="ml-2">Highest</Badge>}
                        </td>
                        <td className="px-4 py-2 text-right">
                          {item.totalQty.toLocaleString('en-US', {maximumFractionDigits: 0})}
                        </td>
                        <td className="px-4 py-2 text-right">
                          ${item.avgPrice.toFixed(2)}
                        </td>
                        <td className={`px-4 py-2 text-right font-semibold ${
                          item.priceChangePercent > 0 ? 'text-red-600' : 'text-green-600'
                        }`}>
                          {item.priceChangePercent > 0 ? '+' : ''}{item.priceChangePercent.toFixed(2)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* ABC Spend Concentration Analysis */}
          {spendConcentration && spendConcentration.summary && (
            <Card>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold flex items-center gap-2">
                  <Layers className="w-5 h-5 text-blue-600" />
                  ABC Spend Analysis
                </h3>
                <div className="flex gap-2">
                  <Badge type="danger">A: {spendConcentration.summary.classA.count} items</Badge>
                  <Badge type="warning">B: {spendConcentration.summary.classB.count} items</Badge>
                  <Badge type="success">C: {spendConcentration.summary.classC.count} items</Badge>
                </div>
              </div>

              {/* Summary cards */}
              <div className="grid grid-cols-3 gap-4 mb-6">
                {[
                  { cls: 'A', data: spendConcentration.summary.classA, label: 'High Value',
                    bg: 'bg-red-50 dark:bg-red-900/20', text: 'text-red-600' },
                  { cls: 'B', data: spendConcentration.summary.classB, label: 'Medium Value',
                    bg: 'bg-amber-50 dark:bg-amber-900/20', text: 'text-amber-600' },
                  { cls: 'C', data: spendConcentration.summary.classC, label: 'Low Value',
                    bg: 'bg-green-50 dark:bg-green-900/20', text: 'text-green-600' }
                ].map(({ cls, data, _label, bg, text }) => (
                  <div key={cls} className={`p-3 rounded-lg ${bg} text-center`}>
                    <div className={`text-2xl font-bold ${text}`}>Class {cls}</div>
                    <div className="text-sm text-slate-600 dark:text-slate-300">
                      {data.count} materials ({data.pct.toFixed(1)}% spend)
                    </div>
                    <div className="text-xs text-slate-500 mt-1">
                      ${data.totalSpend.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                    </div>
                  </div>
                ))}
              </div>

              {/* Pareto Chart */}
              <div className="mb-6">
                <h4 className="text-sm font-medium text-slate-500 mb-2">Pareto Chart (Spend vs Cumulative %)</h4>
                <ResponsiveContainer width="100%" height={300} minWidth={1} minHeight={1}>
                  <ComposedChart data={spendConcentration.materials.slice(0, 20)}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis
                      dataKey="material_code"
                      tick={{ fontSize: 10 }}
                      interval={0}
                      angle={-45}
                      textAnchor="end"
                      height={60}
                    />
                    <YAxis yAxisId="spend" tick={{ fontSize: 11 }} />
                    <YAxis yAxisId="cumulative" orientation="right" domain={[0, 100]}
                      tick={{ fontSize: 11 }} unit="%" />
                    <Tooltip
                      formatter={(value, name) => {
                        if (name === 'Spend') return ['$' + value.toLocaleString(), name];
                        return [value.toFixed(1) + '%', name];
                      }}
                    />
                    <Bar yAxisId="spend" dataKey="totalSpend" name="Spend" radius={[4, 4, 0, 0]}>
                      {spendConcentration.materials.slice(0, 20).map((entry, i) => (
                        <Cell key={`abc-cell-${i}`} fill={ABC_COLORS[entry.abcClass]} />
                      ))}
                    </Bar>
                    <Line yAxisId="cumulative" dataKey="cumulativeShare" name="Cumulative %"
                      stroke="#8b5cf6" strokeWidth={2} dot={{ r: 3 }} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              {/* ABC Detail Table */}
              <div className="overflow-x-auto max-h-64 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-800 sticky top-0">
                    <tr>
                      <th className="px-4 py-2 text-left">Class</th>
                      <th className="px-4 py-2 text-left">Material</th>
                      <th className="px-4 py-2 text-left">Category</th>
                      <th className="px-4 py-2 text-right">Total Spend</th>
                      <th className="px-4 py-2 text-right">Share %</th>
                      <th className="px-4 py-2 text-right">Cumulative %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {spendConcentration.materials.map((mat, idx) => (
                      <tr key={`abc-${mat.material_id}-${idx}`}
                          className="border-t dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800">
                        <td className="px-4 py-2">
                          <Badge type={mat.abcClass === 'A' ? 'danger' : mat.abcClass === 'B' ? 'warning' : 'success'}>
                            {mat.abcClass}
                          </Badge>
                        </td>
                        <td className="px-4 py-2">
                          <div className="font-medium">{mat.material_code}</div>
                          <div className="text-xs text-slate-500 truncate max-w-xs">{mat.material_name}</div>
                        </td>
                        <td className="px-4 py-2 text-slate-600 dark:text-slate-400">{mat.category}</td>
                        <td className="px-4 py-2 text-right font-semibold">
                          ${mat.totalSpend.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                        </td>
                        <td className="px-4 py-2 text-right">{mat.spendShare.toFixed(1)}%</td>
                        <td className="px-4 py-2 text-right">{mat.cumulativeShare.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* Price Anomaly Detection */}
          {priceAnomalies.length > 0 && (
            <Card>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold flex items-center gap-2">
                  <AlertTriangle className="w-5 h-5 text-orange-500" />
                  Price Anomaly Detection
                </h3>
                <div className="flex gap-2">
                  <Badge type="danger">
                    {priceAnomalies.filter(a => a.severity === 'high').length} High
                  </Badge>
                  <Badge type="warning">
                    {priceAnomalies.filter(a => a.severity === 'medium').length} Medium
                  </Badge>
                  <Badge type="info">
                    {priceAnomalies.filter(a => a.severity === 'low').length} Low
                  </Badge>
                </div>
              </div>

              <div className="overflow-x-auto max-h-80 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-800 sticky top-0">
                    <tr>
                      <th className="px-4 py-2 text-left">Severity</th>
                      <th className="px-4 py-2 text-left">Material</th>
                      <th className="px-4 py-2 text-left">Supplier</th>
                      <th className="px-4 py-2 text-right">Date</th>
                      <th className="px-4 py-2 text-right">Actual Price</th>
                      <th className="px-4 py-2 text-right">Expected Price</th>
                      <th className="px-4 py-2 text-right">Deviation</th>
                      <th className="px-4 py-2 text-left">Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {priceAnomalies.slice(0, 30).map((anomaly, idx) => (
                      <tr key={`anomaly-${idx}`}
                          className={`border-t dark:border-slate-700 ${
                            anomaly.severity === 'high'
                              ? 'bg-red-50/50 dark:bg-red-900/10'
                              : ''
                          }`}>
                        <td className="px-4 py-2">
                          <Badge type={anomaly.severity === 'high' ? 'danger' : anomaly.severity === 'medium' ? 'warning' : 'info'}>
                            {anomaly.severity}
                          </Badge>
                        </td>
                        <td className="px-4 py-2">
                          <div className="font-medium">{anomaly.material_code}</div>
                          <div className="text-xs text-slate-500 truncate max-w-[150px]">{anomaly.material_name}</div>
                        </td>
                        <td className="px-4 py-2 text-slate-600 dark:text-slate-400">{anomaly.supplier_name}</td>
                        <td className="px-4 py-2 text-right text-slate-500">{anomaly.order_date}</td>
                        <td className="px-4 py-2 text-right font-semibold">
                          ${anomaly.unit_price.toFixed(2)}
                        </td>
                        <td className="px-4 py-2 text-right text-slate-500">
                          ${anomaly.expected_price.toFixed(2)}
                        </td>
                        <td className={`px-4 py-2 text-right font-bold ${
                          anomaly.deviation_pct > 0 ? 'text-red-600' : 'text-green-600'
                        }`}>
                          {anomaly.deviation_pct > 0 ? '+' : ''}{anomaly.deviation_pct.toFixed(1)}%
                        </td>
                        <td className="px-4 py-2">
                          <span className="px-2 py-0.5 rounded text-xs font-medium bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                            {anomaly.anomaly_type.replace('_', ' ')}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {priceAnomalies.length > 30 && (
                <div className="text-center mt-3 text-sm text-slate-500">
                  Showing top 30 of {priceAnomalies.length} anomalies
                </div>
              )}
            </Card>
          )}

          {/* Supplier Spend Concentration */}
          {supplierConcentration && supplierConcentration.concentration && (
            <Card>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold flex items-center gap-2">
                  <Target className="w-5 h-5 text-indigo-600" />
                  Supplier Spend Concentration
                </h3>
                <Badge type={
                  supplierConcentration.concentration.riskLevel === 'high' ? 'danger' :
                  supplierConcentration.concentration.riskLevel === 'medium' ? 'warning' : 'success'
                }>
                  HHI: {supplierConcentration.concentration.hhi} ({supplierConcentration.concentration.riskLevel} concentration)
                </Badge>
              </div>

              {/* Concentration Metrics */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
                <div className="text-center p-3 rounded-lg bg-slate-50 dark:bg-slate-800">
                  <div className="text-xl font-bold text-blue-600">
                    {supplierConcentration.concentration.top1_pct.toFixed(1)}%
                  </div>
                  <div className="text-xs text-slate-500">Top 1 Supplier Share</div>
                </div>
                <div className="text-center p-3 rounded-lg bg-slate-50 dark:bg-slate-800">
                  <div className="text-xl font-bold text-blue-600">
                    {supplierConcentration.concentration.top3_pct.toFixed(1)}%
                  </div>
                  <div className="text-xs text-slate-500">Top 3 Suppliers Share</div>
                </div>
                <div className="text-center p-3 rounded-lg bg-slate-50 dark:bg-slate-800">
                  <div className="text-xl font-bold text-blue-600">
                    {supplierConcentration.concentration.top5_pct.toFixed(1)}%
                  </div>
                  <div className="text-xs text-slate-500">Top 5 Suppliers Share</div>
                </div>
                <div className="text-center p-3 rounded-lg bg-slate-50 dark:bg-slate-800">
                  <div className={`text-xl font-bold ${
                    supplierConcentration.concentration.riskLevel === 'high' ? 'text-red-600' :
                    supplierConcentration.concentration.riskLevel === 'medium' ? 'text-amber-600' : 'text-green-600'
                  }`}>
                    {supplierConcentration.concentration.hhi}
                  </div>
                  <div className="text-xs text-slate-500">HHI Index</div>
                </div>
              </div>

              {/* Supplier Spend Bar Chart */}
              <div className="mb-6">
                <ResponsiveContainer width="100%" height={280} minWidth={1} minHeight={1}>
                  <BarChart data={supplierConcentration.suppliers.slice(0, 10)} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 11 }}
                      tickFormatter={(val) => '$' + (val >= 1000 ? (val / 1000).toFixed(0) + 'k' : val)} />
                    <YAxis dataKey="supplier_name" type="category" tick={{ fontSize: 11 }} width={120} />
                    <Tooltip
                      formatter={(value) => ['$' + value.toLocaleString(), 'Spend']}
                    />
                    <Bar dataKey="totalSpend" name="Spend" radius={[0, 4, 4, 0]}>
                      {supplierConcentration.suppliers.slice(0, 10).map((_, i) => (
                        <Cell key={`supp-cell-${i}`} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Supplier Detail Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-800">
                    <tr>
                      <th className="px-4 py-2 text-left">Supplier</th>
                      <th className="px-4 py-2 text-right">Total Spend</th>
                      <th className="px-4 py-2 text-right">Share %</th>
                      <th className="px-4 py-2 text-right">Materials</th>
                      <th className="px-4 py-2 text-right">Avg Price Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {supplierConcentration.suppliers.map((supp, idx) => (
                      <tr key={`supp-conc-${supp.supplier_id}-${idx}`}
                          className="border-t dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800">
                        <td className="px-4 py-2">
                          <div className="font-medium">{supp.supplier_name}</div>
                          <div className="text-xs text-slate-500">{supp.supplier_code}</div>
                        </td>
                        <td className="px-4 py-2 text-right font-semibold text-indigo-600">
                          ${supp.totalSpend.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                        </td>
                        <td className="px-4 py-2 text-right">{supp.spendShare.toFixed(1)}%</td>
                        <td className="px-4 py-2 text-right">{supp.materialCount}</td>
                        <td className={`px-4 py-2 text-right font-semibold ${
                          supp.avgPriceChange > 0 ? 'text-red-600' : 'text-green-600'
                        }`}>
                          {supp.avgPriceChange > 0 ? '+' : ''}{supp.avgPriceChange.toFixed(2)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* No Quantity Data Message */}
          {dataCoverage && dataCoverage.hasPriceData && !dataCoverage.hasQuantityData && topBySpend.length === 0 && (
            <Card className="p-4 bg-yellow-50 dark:bg-yellow-900/20">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
                <div>
                  <h4 className="text-sm font-semibold text-yellow-800 dark:text-yellow-300 mb-1">
                    Quantity Data Missing
                  </h4>
                  <p className="text-sm text-slate-600 dark:text-slate-400">
                    To enable spend analysis and "Top Materials by Spend", please upload data that includes a quantity field 
                    (e.g., <code className="px-1 py-0.5 bg-slate-200 dark:bg-slate-700 rounded text-xs">Quantity</code>, 
                    <code className="px-1 py-0.5 bg-slate-200 dark:bg-slate-700 rounded text-xs mx-1">Qty</code>, or 
                    <code className="px-1 py-0.5 bg-slate-200 dark:bg-slate-700 rounded text-xs">OrderQty</code>).
                  </p>
                </div>
              </div>
            </Card>
          )}

          {/* Material Cost AI Optimization */}
          <Card className="bg-gradient-to-br from-purple-50 to-pink-50 dark:from-purple-900/20 dark:to-pink-900/20">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-purple-600" />
                AI Cost Optimization
              </h3>
              <Button
                variant="magic"
                onClick={handleGenerateMaterialOptimization}
                disabled={analyzingMaterialAI || !materialKPIs}
                className="text-sm py-1 px-3"
              >
                {analyzingMaterialAI ? 'Analyzing...' : 'Generate'}
              </Button>
            </div>

            {/* Scrollable content area */}
            <div className="max-h-80 overflow-y-auto pr-2">
              {analyzingMaterialAI && (
                <div className="flex items-center gap-2 text-purple-600 py-4">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-sm">Analyzing your materials and suppliers…</span>
                </div>
              )}

              {materialAIOptimization && !analyzingMaterialAI && (
                <div className={`prose prose-sm max-w-none dark:prose-invert ${
                  materialAIOptimization.startsWith('Error:') ? 'text-red-600 dark:text-red-400' : ''
                }`}>
                  {materialAIOptimization.startsWith('Error:') ? (
                    <div className="whitespace-pre-line text-sm leading-relaxed">
                      {materialAIOptimization}
                    </div>
                  ) : (
                    <ReactMarkdown>{materialAIOptimization}</ReactMarkdown>
                  )}
                </div>
              )}

              {!materialAIOptimization && !analyzingMaterialAI && (
                <div className="text-center py-8 text-slate-400">
                  <Sparkles className="w-12 h-12 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">Click Generate to get AI suggestions based on your current Material Cost data.</p>
                </div>
              )}
            </div>
          </Card>

          {/* Empty State for Material Cost */}
          {!materialLoading && (!dataCoverage || !dataCoverage.hasPriceData) && (
            <Card className="text-center py-12">
              <Package className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-slate-600 dark:text-slate-400 mb-2">
                No Material Cost Data Yet
              </h3>
              <p className="text-slate-500 mb-4">
                Please go to Data Upload page to upload material price history
              </p>
              <p className="text-sm text-slate-400 mb-4">
                Required columns: MaterialCode, SupplierName, OrderDate, UnitPrice, Currency
              </p>
              <Button
                variant="primary"
                icon={ChevronRight}
                onClick={() => setView?.('external')}
              >
                Go to Data Upload
              </Button>
            </Card>
          )}
        </>
      )}

      {/* Operational Cost View (existing code) */}
      {viewMode === 'operational' && (
        <>
          {/* KPI Cards */}
      {trends && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card className="p-4">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-xs text-slate-500 font-semibold uppercase">Avg Total Cost</div>
                <div className="text-2xl font-bold text-blue-600 mt-1">
                  ${trends.averages.avgTotalCost.toLocaleString('en-US', {maximumFractionDigits: 0})}
                </div>
                <div className="text-xs text-slate-500 mt-1">Last {selectedPeriod} days</div>
              </div>
              <div className="p-2 rounded-lg bg-blue-100 dark:bg-blue-900/30">
                <BarChart3 className="w-5 h-5 text-blue-600" />
              </div>
            </div>
          </Card>

          <Card className="p-4">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-xs text-slate-500 font-semibold uppercase">Avg Unit Cost</div>
                <div className="text-2xl font-bold text-purple-600 mt-1">
                  ${trends.averages.avgUnitCost.toFixed(2)}
                </div>
                <div className="text-xs text-slate-500 mt-1">Per unit</div>
              </div>
              <div className="p-2 rounded-lg bg-purple-100 dark:bg-purple-900/30">
                <PieChart className="w-5 h-5 text-purple-600" />
              </div>
            </div>
          </Card>

          <Card className="p-4">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-xs text-slate-500 font-semibold uppercase">Days Recorded</div>
                <div className="text-2xl font-bold text-emerald-600 mt-1">
                  {costRecords.length}
                </div>
                <div className="text-xs text-slate-500 mt-1">Of {selectedPeriod} days</div>
              </div>
              <div className="p-2 rounded-lg bg-emerald-100 dark:bg-emerald-900/30">
                <Calendar className="w-5 h-5 text-emerald-600" />
              </div>
            </div>
          </Card>

          <Card className="p-4">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-xs text-slate-500 font-semibold uppercase">Pending Anomalies</div>
                <div className="text-2xl font-bold text-red-600 mt-1">
                  {anomalies.length}
                </div>
                <div className="text-xs text-slate-500 mt-1">Needs attention</div>
              </div>
              <div className="p-2 rounded-lg bg-red-100 dark:bg-red-900/30">
                <AlertTriangle className="w-5 h-5 text-red-600" />
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Cost Trend Chart */}
      {trends && trends.dates.length > 0 && (
        <Card>
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-semibold">Cost Trends</h3>
            <div className="flex gap-2">
              <Badge type="info">Total</Badge>
              <Badge type="success">Direct</Badge>
              <Badge type="warning">Indirect</Badge>
            </div>
          </div>
          <SimpleLineChart
            data={trends.totalCosts}
            color="#3b82f6"
            height={250}
          />
          <div className="mt-4 text-xs text-slate-500 text-center">
            Date range: {trends.dates[0]} to {trends.dates[trends.dates.length - 1]}
          </div>
        </Card>
      )}

      {/* Cost Structure & AI Optimization */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Cost Structure */}
        {costStructure && (
          <Card>
            <h3 className="text-lg font-semibold mb-4">Today's Cost Structure</h3>
            <div className="space-y-3">
              {[
                { label: 'Direct Labor', value: costStructure.breakdown.directLabor, percent: costStructure.percentages.directLabor, color: 'bg-blue-500' },
                { label: 'Indirect Labor', value: costStructure.breakdown.indirectLabor, percent: costStructure.percentages.indirectLabor, color: 'bg-purple-500' },
                { label: 'Material Cost', value: costStructure.breakdown.material, percent: costStructure.percentages.material, color: 'bg-amber-500' },
                { label: 'Overhead', value: costStructure.breakdown.overhead, percent: costStructure.percentages.overhead, color: 'bg-emerald-500' }
              ].map((item, idx) => (
                <div key={idx}>
                  <div className="flex justify-between text-sm mb-1">
                    <span>{item.label}</span>
                    <span className="font-semibold">${item.value.toLocaleString()} ({item.percent.toFixed(1)}%)</span>
                  </div>
                  <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2">
                    <div
                      className={`${item.color} h-2 rounded-full transition-all`}
                      style={{ width: `${item.percent}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 pt-4 border-t">
              <div className="flex justify-between items-center">
                <span className="font-semibold">Total Cost</span>
                <span className="text-xl font-bold text-green-600">
                  ${costStructure.totalCost.toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between items-center mt-2 text-sm text-slate-500">
                <span>Unit Cost</span>
                <span>${costStructure.costPerUnit.toFixed(2)} / pc</span>
              </div>
            </div>
          </Card>
        )}

        {/* AI Optimization Suggestions */}
        <Card className="bg-gradient-to-br from-purple-50 to-pink-50 dark:from-purple-900/20 dark:to-pink-900/20">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-purple-600" />
              AI Optimization
            </h3>
            <Button
              variant="magic"
              onClick={handleGenerateOptimization}
              disabled={analyzingOptimization || !costStructure}
              className="text-sm py-1 px-3"
            >
              {analyzingOptimization ? 'Analyzing...' : 'Generate'}
            </Button>
          </div>

          {analyzingOptimization && (
            <div className="flex items-center gap-2 text-purple-600">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-sm">AI is analyzing your cost data...</span>
            </div>
          )}

          {aiOptimization && !analyzingOptimization && (
            <div className="prose prose-sm max-w-none dark:prose-invert">
              <ReactMarkdown>{aiOptimization}</ReactMarkdown>
            </div>
          )}

          {!aiOptimization && !analyzingOptimization && (
            <div className="text-center py-8 text-slate-400">
              <Sparkles className="w-12 h-12 mx-auto mb-2 opacity-50" />
              <p className="text-sm">Click 'Generate' to get AI cost optimization suggestions</p>
            </div>
          )}
        </Card>
      </div>

      {/* Cost Anomalies List */}
      {anomalies.length > 0 && (
        <Card>
          <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-red-500" />
            Cost Anomalies ({anomalies.length})
          </h3>
          <div className="space-y-3">
            {anomalies.map((anomaly) => (
              <div
                key={anomaly.id}
                className="p-4 rounded-lg border-l-4 border-red-500 bg-red-50 dark:bg-red-900/20 cursor-pointer hover:bg-red-100 dark:hover:bg-red-900/30 transition"
                onClick={() => handleAnalyzeAnomaly(anomaly)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge type="danger">{anomaly.severity}</Badge>
                      <span className="text-sm font-semibold">{anomaly.anomaly_date}</span>
                    </div>
                    <p className="text-sm text-slate-700 dark:text-slate-300">
                      {anomaly.description}
                    </p>
                    <div className="text-xs text-slate-500 mt-1">
                      Deviation: {anomaly.deviation_percent}% |
                      Detected: ${anomaly.detected_value} |
                      Expected: ${anomaly.expected_value}
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleResolveAnomaly(anomaly.id, 'User marked as resolved');
                    }}
                    className="p-2 hover:bg-red-200 dark:hover:bg-red-800 rounded-lg transition"
                    title="Mark as resolved"
                  >
                    <CheckCircle className="w-4 h-4 text-green-600" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* AI Anomaly Analysis Modal */}
      {selectedAnomaly && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <Card className="max-w-2xl w-full max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-purple-600" />
                AI Anomaly Analysis
              </h3>
              <button
                onClick={() => {
                  setSelectedAnomaly(null);
                  setAiAnalysis('');
                }}
                className="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="mb-4 p-4 bg-red-50 dark:bg-red-900/20 rounded-lg">
              <div className="text-sm font-semibold mb-1">{selectedAnomaly.anomaly_date}</div>
              <div className="text-sm text-slate-700 dark:text-slate-300">{selectedAnomaly.description}</div>
              <div className="text-xs text-slate-500 mt-2">
                Deviation: {selectedAnomaly.deviation_percent}% |
                Detected: ${selectedAnomaly.detected_value} |
                Expected: ${selectedAnomaly.expected_value}
              </div>
            </div>

            {analyzingAnomaly && (
              <div className="flex items-center gap-2 text-purple-600 mb-4">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">AI is performing deep analysis...</span>
              </div>
            )}

            {aiAnalysis && !analyzingAnomaly && (
              <div className="prose prose-sm max-w-none dark:prose-invert">
                <ReactMarkdown>{aiAnalysis}</ReactMarkdown>
              </div>
            )}

            <div className="flex gap-2 justify-end mt-6">
              <Button
                variant="secondary"
                onClick={() => {
                  setSelectedAnomaly(null);
                  setAiAnalysis('');
                }}
              >
                Close
              </Button>
              <Button
                variant="success"
                onClick={() => handleResolveAnomaly(selectedAnomaly.id, aiAnalysis)}
              >
                Mark Resolved
              </Button>
            </div>
          </Card>
        </div>
      )}


          {/* Empty State */}
          {!loading && costRecords.length === 0 && (
            <Card className="text-center py-12">
              <DollarSign className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-slate-600 dark:text-slate-400 mb-2">
                No Operational Cost Data Yet
              </h3>
              <p className="text-slate-500 mb-4">
                Please go to Data Upload page to upload operational cost data
              </p>
              <p className="text-sm text-slate-400 mb-4">
                Required columns: CostDate, DirectLaborHours, DirectLaborRate, ProductionOutput
              </p>
              <Button
                variant="primary"
                icon={ChevronRight}
                onClick={() => setView?.('external')}
              >
                Go to Data Upload
              </Button>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
