import React, { useState, useEffect } from 'react';
import {
  DollarSign, TrendingUp, TrendingDown, AlertTriangle, Sparkles,
  Plus, Calendar, BarChart3, PieChart, Loader2, CheckCircle, X,
  AlertCircle, RefreshCw, Download
} from 'lucide-react';
import { Card, Button, Badge } from '../components/ui';
import { SimpleLineChart } from '../components/charts';
import * as costAnalysisService from '../services/costAnalysisService';
import { analyzeCostAnomaly, generateCostOptimizationSuggestions } from '../services/geminiAPI';

/**
 * Cost Analysis View
 * Features: Daily cost recording, trend analysis, anomaly detection, AI suggestions
 */
export default function CostAnalysisView({ addNotification, user }) {
  // State management
  const [loading, setLoading] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
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

  // Form data
  const [formData, setFormData] = useState({
    cost_date: new Date().toISOString().split('T')[0],
    direct_labor_hours: '',
    direct_labor_rate: '',
    indirect_labor_hours: '',
    indirect_labor_rate: '',
    production_output: '',
    production_unit: 'pcs',
    material_cost: '0',
    overhead_cost: '0',
    notes: ''
  });

  // Load data
  useEffect(() => {
    if (user?.id) {
      loadAllData();
    }
  }, [user, selectedPeriod]);

  const loadAllData = async () => {
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

  // Submit cost record
  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!formData.direct_labor_hours || !formData.direct_labor_rate) {
      addNotification('Please fill in required fields', 'error');
      return;
    }

    setLoading(true);
    try {
      await costAnalysisService.recordDailyCost(user.id, formData);
      addNotification('Cost record saved successfully', 'success');
      setShowAddModal(false);
      resetForm();
      loadAllData();
    } catch (error) {
      addNotification(`Save failed: ${error.message}`, 'error');
    } finally {
      setLoading(false);
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

  // AI optimization suggestions
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

  // Resolve anomaly
  const handleResolveAnomaly = async (anomalyId, notes) => {
    try {
      await costAnalysisService.updateAnomalyStatus(anomalyId, 'resolved', notes);
      addNotification('Anomaly marked as resolved', 'success');
      loadAllData();
      setSelectedAnomaly(null);
      setAiAnalysis('');
    } catch (error) {
      addNotification(`Operation failed: ${error.message}`, 'error');
    }
  };

  const resetForm = () => {
    setFormData({
      cost_date: new Date().toISOString().split('T')[0],
      direct_labor_hours: '',
      direct_labor_rate: '',
      indirect_labor_hours: '',
      indirect_labor_rate: '',
      production_output: '',
      production_unit: 'pcs',
      material_cost: '0',
      overhead_cost: '0',
      notes: ''
    });
  };

  // Calculate cost preview
  const calculatePreview = () => {
    const directCost = (parseFloat(formData.direct_labor_hours) || 0) *
                      (parseFloat(formData.direct_labor_rate) || 0);
    const indirectCost = (parseFloat(formData.indirect_labor_hours) || 0) *
                        (parseFloat(formData.indirect_labor_rate) || 0);
    const totalCost = directCost + indirectCost +
                     (parseFloat(formData.material_cost) || 0) +
                     (parseFloat(formData.overhead_cost) || 0);
    const output = parseFloat(formData.production_output) || 0;
    const unitCost = output > 0 ? (totalCost / output).toFixed(2) : '0.00';

    return { directCost, indirectCost, totalCost, unitCost };
  };

  const preview = calculatePreview();

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
            Record daily costs, track trends, detect anomalies, AI-powered analysis
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            icon={RefreshCw}
            onClick={loadAllData}
            disabled={loading}
          >
            Refresh
          </Button>
          <Button
            variant="primary"
            icon={Plus}
            onClick={() => setShowAddModal(true)}
          >
            Record Cost
          </Button>
        </div>
      </div>

      {/* Period selector */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-slate-500">View Period:</span>
        {['30', '60', '90'].map(days => (
          <button
            key={days}
            onClick={() => setSelectedPeriod(days)}
            className={`px-3 py-1 rounded-lg text-sm font-medium transition ${
              selectedPeriod === days
                ? 'bg-blue-600 text-white'
                : 'bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600'
            }`}
          >
            {days} Days
          </button>
        ))}
      </div>

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
              <div className="whitespace-pre-line text-sm leading-relaxed">
                {aiOptimization}
              </div>
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
                <div className="whitespace-pre-line text-sm leading-relaxed">
                  {aiAnalysis}
                </div>
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

      {/* Record Cost Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <Card className="max-w-3xl w-full my-8">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-lg font-semibold">Record Daily Cost</h3>
              <button
                onClick={() => {
                  setShowAddModal(false);
                  resetForm();
                }}
                className="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Date */}
                <div>
                  <label className="block text-sm font-medium mb-1">
                    Date <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="date"
                    value={formData.cost_date}
                    onChange={(e) => setFormData({ ...formData, cost_date: e.target.value })}
                    className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
                    required
                  />
                </div>

                {/* Direct Labor Hours */}
                <div>
                  <label className="block text-sm font-medium mb-1">
                    Direct Labor Hours <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={formData.direct_labor_hours}
                    onChange={(e) => setFormData({ ...formData, direct_labor_hours: e.target.value })}
                    className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
                    placeholder="e.g., 160"
                    required
                  />
                </div>

                {/* Direct Labor Rate */}
                <div>
                  <label className="block text-sm font-medium mb-1">
                    Direct Labor Rate ($/hr) <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={formData.direct_labor_rate}
                    onChange={(e) => setFormData({ ...formData, direct_labor_rate: e.target.value })}
                    className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
                    placeholder="e.g., 25"
                    required
                  />
                </div>

                {/* Indirect Labor Hours */}
                <div>
                  <label className="block text-sm font-medium mb-1">
                    Indirect Labor Hours
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={formData.indirect_labor_hours}
                    onChange={(e) => setFormData({ ...formData, indirect_labor_hours: e.target.value })}
                    className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
                    placeholder="e.g., 80"
                  />
                </div>

                {/* Indirect Labor Rate */}
                <div>
                  <label className="block text-sm font-medium mb-1">
                    Indirect Labor Rate ($/hr)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={formData.indirect_labor_rate}
                    onChange={(e) => setFormData({ ...formData, indirect_labor_rate: e.target.value })}
                    className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
                    placeholder="e.g., 20"
                  />
                </div>

                {/* Production Output */}
                <div>
                  <label className="block text-sm font-medium mb-1">
                    Production Output <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={formData.production_output}
                    onChange={(e) => setFormData({ ...formData, production_output: e.target.value })}
                    className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
                    placeholder="e.g., 1000"
                    required
                  />
                </div>

                {/* Material Cost */}
                <div>
                  <label className="block text-sm font-medium mb-1">
                    Material Cost ($)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={formData.material_cost}
                    onChange={(e) => setFormData({ ...formData, material_cost: e.target.value })}
                    className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
                    placeholder="e.g., 5000"
                  />
                </div>

                {/* Overhead Cost */}
                <div>
                  <label className="block text-sm font-medium mb-1">
                    Overhead Cost ($)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={formData.overhead_cost}
                    onChange={(e) => setFormData({ ...formData, overhead_cost: e.target.value })}
                    className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
                    placeholder="e.g., 2000"
                  />
                </div>

                {/* Notes */}
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium mb-1">
                    Notes
                  </label>
                  <textarea
                    value={formData.notes}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                    className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
                    rows="2"
                    placeholder="Additional notes..."
                  />
                </div>
              </div>

              {/* Cost Preview */}
              <div className="mt-6 p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                <h4 className="text-sm font-semibold mb-3">Cost Preview</h4>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <div className="text-slate-500">Direct Labor</div>
                    <div className="font-bold text-blue-600">${preview.directCost.toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-slate-500">Indirect Labor</div>
                    <div className="font-bold text-purple-600">${preview.indirectCost.toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-slate-500">Total Cost</div>
                    <div className="font-bold text-green-600">${preview.totalCost.toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-slate-500">Unit Cost</div>
                    <div className="font-bold text-orange-600">${preview.unitCost}</div>
                  </div>
                </div>
              </div>

              {/* Buttons */}
              <div className="flex gap-2 justify-end mt-6">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setShowAddModal(false);
                    resetForm();
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={loading}>
                  {loading ? 'Saving...' : 'Save'}
                </Button>
              </div>
            </form>
          </Card>
        </div>
      )}

      {/* Empty State */}
      {!loading && costRecords.length === 0 && (
        <Card className="text-center py-12">
          <DollarSign className="w-16 h-16 text-slate-300 mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-slate-600 dark:text-slate-400 mb-2">
            No Cost Records Yet
          </h3>
          <p className="text-slate-500 mb-4">
            Start recording daily costs to track operational efficiency
          </p>
          <Button
            variant="primary"
            icon={Plus}
            onClick={() => setShowAddModal(true)}
          >
            Record First Cost
          </Button>
        </Card>
      )}
    </div>
  );
}
