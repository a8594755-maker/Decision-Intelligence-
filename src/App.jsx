import React, { useState, useEffect, useRef } from 'react';
import * as XLSX from 'xlsx';
import {
  LayoutDashboard, Database, Activity, AlertTriangle, BarChart3, Bot, Settings, LogOut,
  Search, User, Upload, RefreshCw, CheckCircle, AlertCircle, FileText, TrendingUp,
  Menu, X, ChevronRight, Download, Moon, Sun, Send, Sparkles, Loader2, Building2, ChevronDown,
  DollarSign
} from 'lucide-react';

// --- Import UI Components ---
import { Card, Button, Badge } from './components/ui';
import { SimpleLineChart, SimpleBarChart } from './components/charts';

// --- Import Services ---
import { supabase } from './services/supabaseClient';
import { callGeminiAPI } from './services/geminiAPI';

// --- Import Utils ---
import { extractSuppliers } from './utils/dataProcessing';

// --- Import Views ---
import SupplierManagementView from './views/SupplierManagementView';
import CostAnalysisView from './views/CostAnalysisView';

// Mock Data
const MOCK_ALERTS = [{ id: 1, category: "Material Shortage", item: "Lithium Batteries", supplier: "Voltaic Supplies", risk: "High", impact: "Production Stop Risk", rootCause: "Supplier strike.", recommendation: "Activate backup supplier." }, { id: 2, category: "Delivery Delay", item: "Circuit Boards", supplier: "TechTronix", risk: "Medium", impact: "2 Day Delay", rootCause: "Port congestion.", recommendation: "Expedite Air Freight." }, { id: 3, category: "Quantity Mismatch", item: "Steel Casings", supplier: "MetalWorks", risk: "Low", impact: "Inventory Discrepancy", rootCause: "Packing error.", recommendation: "Request credit note." }];
const MOCK_KPI_CONTEXT = { healthIndex: "94%", goodsReceipt: "98%", productionRate: "87%", onTimeShipment: "92%", activeDelays: 3, riskItems: 12 };

// --- Main App ---
export default function SmartOpsApp() {
  const [view, setView] = useState('login');
  const [session, setSession] = useState(null); 
  const [darkMode, setDarkMode] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [excelData, setExcelData] = useState(null);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false); // Mobile Menu State
  const [showDataDropdown, setShowDataDropdown] = useState(false); // Data Management Dropdown
  const dropdownRef = useRef(null);

  const addNotification = (msg, type = 'info') => {
    const id = Date.now();
    setNotifications(prev => [...prev, { id, msg, type }]);
    setTimeout(() => setNotifications(prev => prev.filter(n => n.id !== id)), 3000);
  };

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session) {
        setView('home');
        fetchUserData(session.user.id);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (session) {
        setView('home');
        fetchUserData(session.user.id);
      } else {
        setView('login');
        setExcelData(null);
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (darkMode) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }, [darkMode]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setShowDataDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const fetchUserData = async (userId) => {
    const { data, error } = await supabase.from('user_files').select('data').eq('user_id', userId).order('created_at', { ascending: false }).limit(1);
    if (data && data.length > 0) {
      const restored = data[0].data;
      const rows = Array.isArray(restored) ? restored : restored?.rows;
      if (Array.isArray(rows)) {
        setExcelData(rows);
        addNotification("Data restored from cloud.", "success");
      }
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) addNotification(error.message, "error");
    else addNotification("Login Successful", "success");
    setLoading(false);
  };

  const handleSignUp = async () => {
    setLoading(true);
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) addNotification(error.message, "error");
    else addNotification("Signup success! Please login.", "info");
    setLoading(false);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    addNotification("Logged out", "info");
  };

  const handleExcelUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      const bstr = evt.target.result;
      const wb = XLSX.read(bstr, { type: 'binary' });
      const wsname = wb.SheetNames[0];
      const data = XLSX.utils.sheet_to_json(wb.Sheets[wsname]);
      setExcelData(data);
      addNotification(`Loaded ${data.length} rows.`, "info");
      if (session) {
        await supabase.from('user_files').insert([{ user_id: session.user.id, filename: file.name, data: data }]);
        addNotification("Saved to cloud!", "success");
      }
    };
    reader.readAsBinaryString(file);
  };

  const renderView = () => {
    switch (view) {
      case 'home': return <HomeView setView={setView} />;
      case 'external': return <ExternalSystemsView addNotification={addNotification} excelData={excelData} setExcelData={setExcelData} user={session?.user} />;
      case 'suppliers': return <SupplierManagementView addNotification={addNotification} />;
      case 'cost-analysis': return <CostAnalysisView addNotification={addNotification} user={session?.user} />;
      case 'integration': return <DataIntegrationView addNotification={addNotification} />;
      case 'alerts': return <SmartAlertsView addNotification={addNotification} excelData={excelData} />;
      case 'dashboard': return <OperationsDashboardView excelData={excelData} />;
      case 'analytics': return <AnalyticsCenterView excelData={excelData} />;
      case 'decision': return <DecisionSupportView excelData={excelData} user={session?.user} addNotification={addNotification} />;
      case 'settings': return <SettingsView darkMode={darkMode} setDarkMode={setDarkMode} user={session?.user} addNotification={addNotification} />;
      default: return <HomeView setView={setView} />;
    }
  };

  if (!session) {
    return (
      <div className={`min-h-screen flex items-center justify-center p-4 transition-colors duration-300 ${darkMode ? 'bg-slate-900 text-white' : 'bg-slate-50 text-slate-900'}`}>
        <div className="fixed top-4 right-4 z-50 space-y-2">
          {notifications.map(n => (<div key={n.id} className={`flex items-center p-4 rounded-lg shadow-lg text-white ${n.type === 'error' ? 'bg-red-600' : 'bg-blue-600'}`}>{n.msg}</div>))}
        </div>
        <div className="max-w-md w-full bg-white dark:bg-slate-800 rounded-2xl shadow-xl p-8 border border-slate-200 dark:border-slate-700">
          <div className="flex justify-center mb-8"><div className="bg-blue-600 p-3 rounded-lg"><Activity className="w-8 h-8 text-white" /></div></div>
          <h1 className="text-3xl font-bold text-center mb-2">SmartOps</h1>
          <p className="text-center text-slate-500 dark:text-slate-400 mb-8">Supply Chain Operations Platform</p>
          <form onSubmit={handleLogin} className="space-y-4">
            <div><label className="block text-sm font-medium mb-1">Email</label><input type="email" required className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            <div><label className="block text-sm font-medium mb-1">Password</label><input type="password" required className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
            <button type="submit" disabled={loading} className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg font-medium transition-colors">{loading ? "Processing..." : "Log In"}</button>
            <button type="button" onClick={handleSignUp} disabled={loading} className="w-full bg-transparent border border-blue-600 text-blue-600 hover:bg-blue-50 py-2.5 rounded-lg font-medium transition-colors">Sign Up</button>
          </form>
        </div>
      </div>
    );
  }

  const navItems = [
    { id: 'home', label: 'Home', icon: LayoutDashboard },
    { id: 'dashboard', label: 'Dashboard', icon: BarChart3 },
    { id: 'cost-analysis', label: 'Cost Analysis', icon: DollarSign },
    { id: 'alerts', label: 'Alerts', icon: AlertTriangle },
    { id: 'analytics', label: 'Analytics', icon: TrendingUp },
    { id: 'decision', label: 'Decision AI', icon: Bot }
  ];

  const dataManagementItems = [
    { id: 'external', label: 'External Systems', icon: Database },
    { id: 'suppliers', label: 'Supplier Management', icon: Building2 }
  ];

  return (
    <div className={`min-h-screen flex flex-col transition-colors duration-300 ${darkMode ? 'bg-slate-900 text-slate-100' : 'bg-slate-50 text-slate-900'}`}>
      <div className="fixed top-4 right-4 z-50 space-y-2">{notifications.map(n => (<div key={n.id} className={`flex items-center p-4 rounded-lg shadow-lg text-white ${n.type === 'error' ? 'bg-red-600' : n.type === 'success' ? 'bg-emerald-600' : 'bg-blue-600'}`}>{n.msg}</div>))}</div>
      
      {/* Responsive Header */}
      <header className="sticky top-0 z-40 bg-white/80 dark:bg-slate-800/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-700">
        <div className="max-w-7xl mx-auto px-4 md:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3 cursor-pointer" onClick={() => setView('home')}>
            <div className="bg-blue-600 p-1.5 rounded-lg"><Activity className="w-6 h-6 text-white" /></div>
            <span className="text-xl font-bold">SmartOps</span>
          </div>
          
          {/* Desktop Nav */}
          <nav className="hidden md:flex items-center space-x-1">
            {navItems.map(item => (
              <button key={item.id} onClick={() => setView(item.id)} className={`flex items-center px-3 py-2 rounded-lg text-sm font-medium transition-colors ${view === item.id ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300'}`}>
                <item.icon className="w-4 h-4 mr-2" />{item.label}
              </button>
            ))}

            {/* Data Management Dropdown */}
            <div className="relative" ref={dropdownRef}>
              <button
                onClick={() => setShowDataDropdown(!showDataDropdown)}
                className={`flex items-center px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  dataManagementItems.some(item => view === item.id)
                    ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                    : 'hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300'
                }`}
              >
                <Database className="w-4 h-4 mr-2" />
                Data Management
                <ChevronDown className={`w-4 h-4 ml-1 transition-transform ${showDataDropdown ? 'rotate-180' : ''}`} />
              </button>

              {showDataDropdown && (
                <div className="absolute top-full mt-1 left-0 bg-white dark:bg-slate-800 rounded-lg shadow-lg border border-slate-200 dark:border-slate-700 py-1 min-w-[200px] z-50">
                  {dataManagementItems.map(item => (
                    <button
                      key={item.id}
                      onClick={() => {
                        setView(item.id);
                        setShowDataDropdown(false);
                      }}
                      className={`w-full flex items-center px-4 py-2 text-sm font-medium transition-colors ${
                        view === item.id
                          ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      <item.icon className="w-4 h-4 mr-2" />
                      {item.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </nav>

          <div className="flex items-center space-x-2 md:space-x-4">
            <button onClick={() => setDarkMode(!darkMode)} className="p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-full">{darkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}</button>
            <div className="hidden md:flex items-center space-x-3">
              <div className="text-right"><div className="text-sm font-medium">{session.user.email.split('@')[0]}</div></div>
              <button onClick={handleLogout} className="p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-full"><LogOut className="w-5 h-5" /></button>
            </div>
            {/* Mobile Menu Button */}
            <button onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)} className="md:hidden p-2 text-slate-500"><Menu className="w-6 h-6" /></button>
          </div>
        </div>
      </header>

      {/* Mobile Menu Dropdown */}
      {isMobileMenuOpen && (
        <div className="md:hidden bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 p-4">
          <div className="grid grid-cols-2 gap-2">
            {navItems.map(item => (
              <button key={item.id} onClick={() => { setView(item.id); setIsMobileMenuOpen(false); }} className={`flex items-center p-3 rounded-lg text-sm font-medium ${view === item.id ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'bg-slate-50 dark:bg-slate-700 text-slate-600 dark:text-slate-300'}`}>
                <item.icon className="w-4 h-4 mr-2" />{item.label}
              </button>
            ))}
            {dataManagementItems.map(item => (
              <button key={item.id} onClick={() => { setView(item.id); setIsMobileMenuOpen(false); }} className={`flex items-center p-3 rounded-lg text-sm font-medium ${view === item.id ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'bg-slate-50 dark:bg-slate-700 text-slate-600 dark:text-slate-300'}`}>
                <item.icon className="w-4 h-4 mr-2" />{item.label}
              </button>
            ))}
            <button onClick={handleLogout} className="flex items-center p-3 rounded-lg text-sm font-medium bg-red-50 dark:bg-red-900/20 text-red-600 col-span-2 justify-center"><LogOut className="w-4 h-4 mr-2" />Logout</button>
          </div>
        </div>
      )}

      <main className="flex-1 w-full max-w-7xl mx-auto p-4 md:p-6 lg:p-8">
        {renderView()}
      </main>
    </div>
  );
}

// ... (Sub-components with Grid Fixes) ...


const HomeView = ({ setView }) => {
  const modules = [{ id: 'external', title: "External Systems", desc: "Data sources.", icon: Database, color: "text-blue-500" },{ id: 'integration', title: "Data Integration", desc: "ETL pipelines.", icon: RefreshCw, color: "text-purple-500" },{ id: 'alerts', title: "Smart Alerts", desc: "Real-time alerts.", icon: AlertTriangle, color: "text-red-500" },{ id: 'dashboard', title: "Dashboard", desc: "KPIs & charts.", icon: LayoutDashboard, color: "text-emerald-500" },{ id: 'analytics', title: "Analytics", desc: "Insights.", icon: TrendingUp, color: "text-indigo-500" },{ id: 'decision', title: "Decision AI", desc: "AI Assistant.", icon: Bot, color: "text-amber-500" },{ id: 'settings', title: "Settings", desc: "Preferences.", icon: Settings, color: "text-slate-500" },];
  return (
    <div className="animate-fade-in w-full">
      <h2 className="text-xl md:text-2xl font-bold mb-2">Welcome Back</h2>
      <p className="text-slate-500 dark:text-slate-400 mb-8">Select a module to manage your supply chain.</p>
      {/* Smart Grid System */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 md:gap-6">
        {modules.map((m) => (
          <Card key={m.id} onClick={() => setView(m.id)} hoverEffect className="group">
            <div className="flex items-start justify-between mb-4">
              <div className={`p-3 rounded-lg bg-slate-100 dark:bg-slate-700/50 ${m.color} group-hover:bg-white transition-colors`}><m.icon className="w-6 h-6" /></div>
              <ChevronRight className="w-5 h-5 text-slate-300 group-hover:text-slate-500 transition-colors" />
            </div>
            <h3 className="text-lg font-semibold mb-1">{m.title}</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400">{m.desc}</p>
          </Card>
        ))}
      </div>
    </div>
  );
};

const ExternalSystemsView = ({ addNotification, excelData, setExcelData, user }) => {
  const [loading, setLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [fileName, setFileName] = useState('');
  const [fileStats, setFileStats] = useState(null);
  const [sortColumn, setSortColumn] = useState(null);
  const [sortDirection, setSortDirection] = useState('asc');
  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [stagedRows, setStagedRows] = useState([]);
  const [aiPreview, setAiPreview] = useState(null);
  const [aiStatus, setAiStatus] = useState('idle'); // idle | analyzing | ready | error
  const [aiError, setAiError] = useState('');
  const [saving, setSaving] = useState(false);
  const [versionId, setVersionId] = useState('');
  const [supplierPreview, setSupplierPreview] = useState([]);
  const [supplierError, setSupplierError] = useState('');
  const fileInputRef = useRef(null);
  const rowsPerPage = 10;
  const activeData = stagedRows.length ? stagedRows : (excelData || []);

  // Calculate file statistics
  useEffect(() => {
    if (activeData && activeData.length > 0) {
      const stats = {
        totalRows: activeData.length,
        totalColumns: Object.keys(activeData[0]).length,
        columns: Object.keys(activeData[0]),
        emptyFields: 0,
        uniqueValues: {}
      };

      // Count empty fields and collect unique values per column
      activeData.forEach(row => {
        Object.entries(row).forEach(([key, value]) => {
          if (!value || value === '' || value === null || value === undefined) {
            stats.emptyFields++;
          }
          if (!stats.uniqueValues[key]) {
            stats.uniqueValues[key] = new Set();
          }
          stats.uniqueValues[key].add(String(value));
        });
      });

      setFileStats(stats);
    } else {
      setFileStats(null);
    }
  }, [excelData, activeData]);

  const handleFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const lower = file.name.toLowerCase();
    const isExcel = lower.endsWith('.xlsx') || lower.endsWith('.xls');
    const isCsv = lower.endsWith('.csv');

    // Validate file type
    if (!isExcel && !isCsv) {
      addNotification("Invalid file type. Please upload CSV or Excel files (.csv, .xlsx, .xls)", "error");
      return;
    }

    // Validate file size (max 10MB)
    if (file.size > 10 * 1024 * 1024) {
      addNotification("File too large. Maximum size is 10MB", "error");
      return;
    }

    setFileName(file.name);
    setUploadProgress(10);
    setLoading(true);
    setAiStatus('idle');
    setAiPreview(null);
    setAiError('');
    setVersionId('');
    setSupplierPreview([]);
    setSupplierError('');

    // Simulate upload progress
    const progressInterval = setInterval(() => {
      setUploadProgress(prev => {
        if (prev >= 90) {
          clearInterval(progressInterval);
          return 90;
        }
        return prev + 10;
      });
    }, 200);

    try {
      const rows = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (evt) => {
          try {
            const bstr = evt.target.result;
            const wb = XLSX.read(bstr, { type: 'binary' });
            const wsname = wb.SheetNames[0];
            const data = XLSX.utils.sheet_to_json(wb.Sheets[wsname], { defval: '' });
            resolve(data);
          } catch (err) {
            reject(err);
          }
        };
        reader.onerror = reject;
        reader.readAsBinaryString(file);
      });

      setStagedRows(rows);
      setUploadProgress(100);
      addNotification(`已載入 ${rows.length} 筆資料，等待 AI 分析`, "success");
      const suppliers = extractSuppliers(rows);
      setSupplierPreview(suppliers);
      if (!suppliers.length) {
        setSupplierError('未偵測到供應商欄位，請確認資料包含供應商名稱。');
      }
      setCurrentPage(1);
      setSearchTerm('');
      if (rows.length > 0) {
        await runAiAnalysis(rows);
      } else {
        addNotification("檔案為空，無法分析", "error");
        setAiStatus('error');
      }
    } catch (error) {
      addNotification(`Upload failed: ${error.message}`, "error");
      setUploadProgress(0);
      setFileName('');
      setStagedRows([]);
      setAiStatus('error');
      setAiError(error.message || 'Parse failed');
    } finally {
      setLoading(false);
      setTimeout(() => setUploadProgress(0), 1000);
    }
  };


  const extractAiJson = (text) => {
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (_) {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch (_err) {
          return {};
        }
      }
      return {};
    }
  };

  const runAiAnalysis = async (rows) => {
    try {
      setAiStatus('analyzing');
      setAiError('');
      const sample = rows.slice(0, 30);
      const prompt = `You are a data profiler. Given JSON rows, infer field names, data quality issues, and errors. Return JSON {"fields": ["field1", ...], "quality": "Chinese quality summary", "summary": "Chinese content summary"}. Sample rows: ${JSON.stringify(sample).slice(0, 12000)}`;
      const aiText = await callGeminiAPI(prompt);
      const parsed = extractAiJson(aiText);
      const fields = Array.isArray(parsed.fields) && parsed.fields.length > 0
        ? parsed.fields
        : Object.keys(sample[0] || {});
      setAiPreview({
        fields,
        quality: parsed.quality || 'AI did not return a quality summary',
        summary: parsed.summary || 'AI did not return a content summary',
        raw: aiText
      });
      setAiStatus('ready');
    } catch (err) {
      setAiStatus('error');
      setAiError(err.message || 'AI analysis failed');
    }
  };
      const handleAccept = async () => {
    if (!stagedRows.length) return;
    const version = `v-${Date.now()}`;
    setSaving(true);
    setVersionId(version);
    try {
      const payload = {
        user_id: user?.id,
        filename: fileName || 'upload',
        data: { rows: stagedRows, version }
      };
      const { error } = await supabase.from('user_files').insert([payload]);
      if (error) throw new Error(error.message);
      if (supplierPreview.length > 0) {
        const { error: supplierErrorInsert } = await supabase.from('suppliers').insert(supplierPreview);
        if (supplierErrorInsert) throw new Error(`Supplier save failed: ${supplierErrorInsert.message}`);
      }
      setExcelData(stagedRows);
      addNotification(`Data saved (${version})`, "success");
      setStagedRows([]);
      setAiStatus('idle');
      setSupplierPreview([]);
    } catch (err) {
      addNotification(`Save failed: ${err.message}`, "error");
    } finally {
      setSaving(false);
    }
  };

  const handleReject = () => {
    setStagedRows([]);
    setAiPreview(null);
    setAiStatus('idle');
    setAiError('');
    setVersionId('');
    setFileName('');
    setSupplierPreview([]);
    setSupplierError('');
    addNotification("Cleared staged upload data", "info");
  };

  const handleSync = () => {
    setLoading(true);
    setTimeout(() => {
      setLoading(false);
      addNotification("Data synchronized successfully!", "success");
    }, 2000);
  };

  const handleSort = (column) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  const handleClearData = () => {
    setShowDeleteConfirm(false);
    setFileName('');
    setFileStats(null);
    setSearchTerm('');
    setCurrentPage(1);
    setStagedRows([]);
    setAiPreview(null);
    setAiStatus('idle');
    setVersionId('');
    setExcelData?.(null);
    addNotification("Data cleared", "info");
  };

  const handleExportData = () => {
    if (!activeData || activeData.length === 0) return;

    const ws = XLSX.utils.json_to_sheet(activeData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Data");
    XLSX.writeFile(wb, `exported_${fileName || 'data.xlsx'}`);
    addNotification("Data exported successfully!", "success");
  };

  // Filter and sort data
  const processedData = React.useMemo(() => {
    if (!activeData) return [];

    let filtered = activeData;

    // Search filter
    if (searchTerm) {
      filtered = filtered.filter(row =>
        Object.values(row).some(val =>
          String(val).toLowerCase().includes(searchTerm.toLowerCase())
        )
      );
    }

    // Sort
    if (sortColumn) {
      filtered = [...filtered].sort((a, b) => {
        const aVal = a[sortColumn];
        const bVal = b[sortColumn];

        if (aVal === bVal) return 0;
        if (aVal === null || aVal === undefined) return 1;
        if (bVal === null || bVal === undefined) return -1;

        const comparison = aVal < bVal ? -1 : 1;
        return sortDirection === 'asc' ? comparison : -comparison;
      });
    }

    return filtered;
  }, [activeData, searchTerm, sortColumn, sortDirection]);

  // Pagination
  const totalPages = Math.ceil(processedData.length / rowsPerPage);
  const paginatedData = processedData.slice(
    (currentPage - 1) * rowsPerPage,
    currentPage * rowsPerPage
  );

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-xl md:text-2xl font-bold flex items-center gap-2">
            <Database className="w-6 h-6 text-blue-500" />
            External Systems
          </h2>
          {fileName && (
            <p className="text-sm text-slate-500 mt-1">Current file: {fileName}</p>
          )}
        </div>
        <div className="flex gap-2 w-full sm:w-auto">
          <div className="relative flex-1 sm:flex-none">
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx, .xls, .csv"
              onChange={handleFileChange}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
            <Button variant="secondary" icon={Upload} className="w-full" disabled={loading}>
              Upload CSV / Excel
            </Button>
          </div>
          {activeData && activeData.length > 0 && (
            <>
              <Button onClick={handleExportData} variant="secondary" icon={Download} className="hidden sm:flex">
                Export
              </Button>
              <Button onClick={() => setShowDeleteConfirm(true)} variant="danger" icon={X} className="hidden sm:flex">
                Clear
              </Button>
            </>
          )}
          <Button onClick={handleSync} disabled={loading} icon={RefreshCw} className="flex-1 sm:flex-none">
            {loading ? "Syncing..." : "Sync"}
          </Button>
        </div>
      </div>

      {/* Upload Progress */}
      {uploadProgress > 0 && uploadProgress < 100 && (
        <Card className="bg-blue-50 dark:bg-blue-900/20">
          <div className="flex items-center gap-3 mb-2">
            <Upload className="w-5 h-5 text-blue-600 animate-pulse" />
            <span className="text-sm font-medium">Uploading {fileName}...</span>
            <span className="ml-auto text-sm font-bold">{uploadProgress}%</span>
          </div>
          <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2">
            <div
              className="bg-blue-600 h-2 rounded-full transition-all duration-300"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
        </Card>
      )}

      {/* AI Analysis & Preview */}
      {stagedRows.length > 0 && (
        <Card className="border-blue-200 dark:border-blue-800 bg-blue-50/60 dark:bg-slate-800/40">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <h3 className="font-semibold flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-blue-600" />
                  AI 資料預覽
                </h3>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  已載入 {stagedRows.length} 筆資料，AI 先分析 30 筆樣本。
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  onClick={runAiAnalysis.bind(null, stagedRows)}
                  disabled={aiStatus === 'analyzing' || stagedRows.length === 0}
                >
                  {aiStatus === 'analyzing' ? "AI 分析中..." : "重新分析"}
                </Button>
                <Button variant="secondary" onClick={handleReject}>
                  捨棄
                </Button>
                <Button
                  variant="success"
                  onClick={handleAccept}
                  disabled={aiStatus !== 'ready' || saving}
                >
                  {saving ? "儲存中..." : "接受並儲存"}
                </Button>
              </div>
            </div>

            {aiStatus === 'analyzing' && (
              <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
                <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                AI 解析中，請稍候...
              </div>
            )}

            {aiStatus === 'error' && (
              <div className="flex items-center gap-2 text-sm text-red-600">
                <AlertCircle className="w-4 h-4" />
                {aiError || 'AI 分析失敗'}
              </div>
            )}

            {aiPreview && aiStatus === 'ready' && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="md:col-span-2 space-y-2">
                  <div className="text-sm text-slate-500">AI 摘要</div>
                  <p className="text-sm leading-relaxed whitespace-pre-line">{aiPreview.summary}</p>
                  <div className="text-sm text-slate-500 mt-3">品質檢查</div>
                  <p className="text-sm leading-relaxed whitespace-pre-line">{aiPreview.quality}</p>
                  {versionId && (
                    <Badge type="success">版本 {versionId}</Badge>
                  )}
                </div>
                <div className="space-y-2">
                  <div className="text-sm text-slate-500">欄位</div>
                  <div className="flex flex-wrap gap-2">
                    {aiPreview.fields && aiPreview.fields.length > 0 ? aiPreview.fields.map((f) => (
                      <Badge key={f} type="info">{f}</Badge>
                    )) : <span className="text-xs text-slate-400">AI 無法識別欄位</span>}
                  </div>
                  <div className="text-xs text-slate-400 mt-2">
                    AI 原始輸出（供除錯）：<br />{aiPreview.raw?.slice(0, 200)}{aiPreview.raw && aiPreview.raw.length > 200 ? '…' : ''}
                  </div>
                </div>
              </div>
            )}

            {supplierPreview.length > 0 && (
              <div className="mt-2">
                <div className="flex items-center gap-2 mb-2">
                  <Database className="w-4 h-4 text-emerald-500" />
                  <span className="text-sm font-semibold">偵測到的供應商資料（去重後）</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse min-w-[600px]">
                    <thead className="bg-emerald-50 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-100">
                      <tr>
                        <th className="px-3 py-2 text-left">名稱</th>
                        <th className="px-3 py-2 text-left">聯絡方式</th>
                        <th className="px-3 py-2 text-left">地址</th>
                        <th className="px-3 py-2 text-left">產品類別</th>
                        <th className="px-3 py-2 text-left">付款條件</th>
                        <th className="px-3 py-2 text-left">交貨時間</th>
                      </tr>
                    </thead>
                    <tbody>
                      {supplierPreview.slice(0, 5).map((s, idx) => (
                        <tr key={idx} className="border-b border-emerald-100 dark:border-emerald-900/40">
                          <td className="px-3 py-2">{s.supplier_name || '-'}</td>
                          <td className="px-3 py-2">{s.contact_info || '-'}</td>
                          <td className="px-3 py-2">{s.address || '-'}</td>
                          <td className="px-3 py-2">{s.product_category || '-'}</td>
                          <td className="px-3 py-2">{s.payment_terms || '-'}</td>
                          <td className="px-3 py-2">{s.delivery_time || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {supplierPreview.length > 5 && (
                    <div className="text-xs text-slate-500 mt-1">僅顯示前 5 筆，共 {supplierPreview.length} 筆供應商</div>
                  )}
                </div>
              </div>
            )}
            {supplierError && !supplierPreview.length && (
              <div className="text-sm text-amber-600 flex items-center gap-2">
                <AlertCircle className="w-4 h-4" />
                {supplierError}
              </div>
            )}
          </div>
        </Card>
      )}

      {/* System Connections */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 md:gap-6">
        {[
          { name: 'ERP (SAP)', status: 'Connected', lastSync: '2 mins ago', icon: 'E' },
          { name: 'MES (Siemens)', status: 'Connected', lastSync: '5 mins ago', icon: 'M' },
          { name: 'WMS (Oracle)', status: 'Connected', lastSync: '1 min ago', icon: 'W' }
        ].map((sys, i) => (
          <Card key={i} className="hover:shadow-md transition-shadow">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center font-bold text-emerald-600">
                  {sys.icon}
                </div>
                <div>
                  <h4 className="font-semibold text-sm md:text-base">{sys.name}</h4>
                  <p className="text-xs text-emerald-500 flex items-center gap-1">
                    <CheckCircle className="w-3 h-3" />
                    {sys.status}
                  </p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-xs text-slate-400">{sys.lastSync}</p>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* File Statistics */}
      {fileStats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Card className="text-center">
            <div className="text-2xl font-bold text-blue-600">{fileStats.totalRows}</div>
            <div className="text-sm text-slate-500 mt-1">Total Rows</div>
          </Card>
          <Card className="text-center">
            <div className="text-2xl font-bold text-purple-600">{fileStats.totalColumns}</div>
            <div className="text-sm text-slate-500 mt-1">Columns</div>
          </Card>
          <Card className="text-center">
            <div className="text-2xl font-bold text-amber-600">{fileStats.emptyFields}</div>
            <div className="text-sm text-slate-500 mt-1">Empty Fields</div>
          </Card>
          <Card className="text-center">
            <div className="text-2xl font-bold text-emerald-600">
              {Math.round((1 - fileStats.emptyFields / (fileStats.totalRows * fileStats.totalColumns)) * 100)}%
            </div>
            <div className="text-sm text-slate-500 mt-1">Data Quality</div>
          </Card>
        </div>
      )}

      {/* Data Table */}
      <Card>
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-4">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-lg">Data Preview</h3>
            {activeData && activeData.length > 0 && <Badge type="success">{processedData.length} Rows</Badge>}
          </div>
          {activeData && activeData.length > 0 && (
            <div className="relative w-full sm:w-64">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="Search data..."
                value={searchTerm}
                onChange={(e) => {
                  setSearchTerm(e.target.value);
                  setCurrentPage(1);
                }}
                className="w-full pl-10 pr-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent text-sm focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
          )}
        </div>

        <div className="overflow-x-auto">
          {activeData && activeData.length > 0 ? (
            <>
              <table className="w-full text-sm text-left border-collapse min-w-[600px]">
                <thead className="text-xs uppercase bg-slate-50 dark:bg-slate-700/50">
                  <tr>
                    <th className="px-4 py-3 border-b text-slate-500">#</th>
                    {Object.keys(activeData[0]).map((key) => (
                      <th
                        key={key}
                        className="px-4 py-3 border-b cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-600 transition-colors"
                        onClick={() => handleSort(key)}
                      >
                        <div className="flex items-center gap-2">
                          {key}
                          {sortColumn === key && (
                            <span className="text-blue-600">
                              {sortDirection === 'asc' ? '^' : 'v'}
                            </span>
                          )}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {paginatedData.map((row, i) => (
                    <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors">
                      <td className="px-4 py-3 border-b text-slate-400 font-mono text-xs">
                        {(currentPage - 1) * rowsPerPage + i + 1}
                      </td>
                      {Object.values(row).map((val, j) => (
                        <td key={j} className="px-4 py-3 border-b">
                          {val !== null && val !== undefined && val !== '' ? (
                            <span>{String(val)}</span>
                          ) : (
                            <span className="text-slate-300 dark:text-slate-600 italic">empty</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex justify-between items-center mt-4 pt-4 border-t">
                  <div className="text-sm text-slate-500">
                    Showing {(currentPage - 1) * rowsPerPage + 1} to {Math.min(currentPage * rowsPerPage, processedData.length)} of {processedData.length} rows
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                      className="px-3 py-1 text-sm"
                    >
                      Previous
                    </Button>
                    <div className="flex items-center gap-1">
                      {[...Array(Math.min(5, totalPages))].map((_, i) => {
                        let pageNum;
                        if (totalPages <= 5) {
                          pageNum = i + 1;
                        } else if (currentPage <= 3) {
                          pageNum = i + 1;
                        } else if (currentPage >= totalPages - 2) {
                          pageNum = totalPages - 4 + i;
                        } else {
                          pageNum = currentPage - 2 + i;
                        }

                        return (
                          <button
                            key={i}
                            onClick={() => setCurrentPage(pageNum)}
                            className={`px-3 py-1 text-sm rounded ${
                              currentPage === pageNum
                                ? 'bg-blue-600 text-white'
                                : 'bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600'
                            }`}
                          >
                            {pageNum}
                          </button>
                        );
                      })}
                    </div>
                    <Button
                      variant="secondary"
                      onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                      disabled={currentPage === totalPages}
                      className="px-3 py-1 text-sm"
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="text-center py-12">
              <Upload className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-slate-600 dark:text-slate-400 mb-2">
                No Data Loaded
              </h3>
              <p className="text-slate-500 mb-4">
                Upload an Excel file (.xlsx, .xls) to get started
              </p>
              <Button
                variant="primary"
                icon={Upload}
                onClick={() => fileInputRef.current?.click()}
              >
                Upload File
              </Button>
            </div>
          )}
        </div>
      </Card>

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <Card className="max-w-md w-full">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                <AlertTriangle className="w-6 h-6 text-red-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold">Clear Data?</h3>
                <p className="text-sm text-slate-500">This action cannot be undone.</p>
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="secondary" onClick={() => setShowDeleteConfirm(false)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={handleClearData}>
                Clear Data
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
};

const DataIntegrationView = ({ addNotification }) => {
  const [etlProgress, setEtlProgress] = useState(0);
  const runEtl = () => { setEtlProgress(10); const interval = setInterval(() => { setEtlProgress(prev => { if (prev >= 100) { clearInterval(interval); addNotification("ETL Completed", "success"); return 100; } return prev + 10; }); }, 200); };
  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex justify-between items-center"><h2 className="text-xl md:text-2xl font-bold flex items-center gap-2"><RefreshCw className="w-6 h-6 text-purple-500" />Data Integration</h2><Button onClick={runEtl} disabled={etlProgress > 0 && etlProgress < 100}>Run ETL</Button></div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6"><Card><div className="text-slate-500 text-sm mb-1">Raw</div><div className="text-3xl font-bold">14,205</div></Card><Card><div className="text-slate-500 text-sm mb-1">Cleaned</div><div className="text-3xl font-bold text-blue-600">14,180</div></Card><Card><div className="text-slate-500 text-sm mb-1">Errors</div><div className="text-3xl font-bold text-red-500">25</div></Card></div>
      {etlProgress > 0 && (<Card className="bg-slate-50 dark:bg-slate-800/50"><div className="flex justify-between text-sm font-medium mb-2"><span>Progress</span><span>{etlProgress}%</span></div><div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2.5"><div className="bg-purple-600 h-2.5 rounded-full transition-all duration-300" style={{ width: `${etlProgress}%` }}></div></div></Card>)}
    </div>
  );
};

const SmartAlertsView = ({ addNotification, excelData }) => {
  const [selectedAlert, setSelectedAlert] = useState(null);
  const [aiAnalysis, setAiAnalysis] = useState(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  
  const generateDeepDive = async () => {
    if (!selectedAlert) return;
    setIsAnalyzing(true); setAiAnalysis(null);
    const context = excelData ? `USER DATA: ${JSON.stringify(excelData.slice(0, 5))}...` : "No data.";
    const prompt = `Analyze alert: ${selectedAlert.category} for ${selectedAlert.item}. Context: ${context}. Suggest mitigation.`;
    const result = await callGeminiAPI(prompt);
    setAiAnalysis(result); setIsAnalyzing(false);
  };

  return (
    <div className="flex flex-col lg:flex-row gap-6 animate-fade-in h-[calc(100vh-140px)]">
      <div className={`${selectedAlert ? 'hidden lg:block lg:w-1/3' : 'w-full'} space-y-4 overflow-y-auto`}>
        <h2 className="text-xl md:text-2xl font-bold flex items-center gap-2 mb-4"><AlertTriangle className="w-6 h-6 text-red-500" />Alerts</h2>
        {MOCK_ALERTS.map(alert => (
          <Card key={alert.id} onClick={() => setSelectedAlert(alert)} className={`cursor-pointer border-l-4 ${selectedAlert?.id === alert.id ? 'ring-2 ring-blue-500' : ''} ${alert.risk === 'High' ? 'border-l-red-500' : 'border-l-amber-500'}`}>
            <div className="flex justify-between items-start mb-2"><span className="font-semibold">{alert.category}</span><Badge type={alert.risk === 'High' ? 'danger' : 'warning'}>{alert.risk}</Badge></div>
            <p className="text-sm text-slate-500 mb-1">{alert.item}</p>
          </Card>
        ))}
      </div>
      {selectedAlert ? (
        <div className="flex-1 animate-slide-in overflow-y-auto pb-20 lg:pb-0">
          <Card className="h-full">
            <button onClick={() => setSelectedAlert(null)} className="lg:hidden absolute top-4 right-4 text-slate-400"><X className="w-6 h-6" /></button>
            <div className="mb-6"><div className="flex items-center gap-2 mb-1"><Badge type="danger">{selectedAlert.risk}</Badge></div><h2 className="text-2xl font-bold">{selectedAlert.category}</h2><p className="text-lg text-slate-600 mt-2">{selectedAlert.item}</p></div>
            <div className="space-y-6">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4"><div className="bg-slate-50 dark:bg-slate-700/50 p-4 rounded-lg"><span className="text-xs uppercase font-semibold">Impact</span><p className="font-medium mt-1">{selectedAlert.impact}</p></div><div className="bg-slate-50 dark:bg-slate-700/50 p-4 rounded-lg"><span className="text-xs uppercase font-semibold">Supplier</span><p className="font-medium mt-1">{selectedAlert.supplier}</p></div></div>
              <div className="bg-purple-50 dark:bg-purple-900/10 p-5 rounded-xl border border-purple-100 dark:border-purple-900">
                <div className="flex items-center justify-between mb-3"><div className="flex items-center gap-2 text-purple-700 font-semibold"><Sparkles className="w-5 h-5" /> AI Analysis</div>{!aiAnalysis && !isAnalyzing && (<Button variant="magic" onClick={generateDeepDive} className="text-xs py-1 px-3">Analyze</Button>)}</div>
                {isAnalyzing && <div className="flex items-center gap-2 text-slate-500"><Loader2 className="w-4 h-4 animate-spin" /> Thinking...</div>}
                {aiAnalysis && <div className="text-slate-700 dark:text-slate-300 text-sm leading-relaxed whitespace-pre-line">{aiAnalysis}</div>}
              </div>
            </div>
          </Card>
        </div>
      ) : (<div className="hidden lg:flex flex-1 items-center justify-center text-slate-400 border-2 border-dashed border-slate-200 rounded-xl"><p>Select an alert</p></div>)}
    </div>
  );
};

const OperationsDashboardView = ({ excelData }) => {
  const [range, setRange] = useState('7d');
  const ranges = [
    { id: '7d', label: '7d' },
    { id: '30d', label: '30d' },
    { id: '90d', label: '90d' }
  ];

  const hasData = Array.isArray(excelData) && excelData.length > 0;
  const columns = hasData ? Object.keys(excelData[0]) : [];
  const totalCells = hasData ? excelData.length * columns.length : 0;

  let emptyFields = 0;
  if (hasData) {
    excelData.forEach(row => {
      columns.forEach(col => {
        const value = row[col];
        if (value === null || value === undefined || value === '') {
          emptyFields += 1;
        }
      });
    });
  }

  const fillRate = totalCells ? Math.round(((totalCells - emptyFields) / totalCells) * 100) : 0;
  const numericColumns = hasData ? columns.filter(col => excelData.some(row => typeof row[col] === 'number' && !Number.isNaN(row[col]))) : [];
  const stringColumns = hasData ? columns.filter(col => typeof excelData[0][col] === 'string') : [];
  const firstNumeric = numericColumns[0];
  const categoryColumn = stringColumns[0] || columns[0];

  const lineChartData = hasData && firstNumeric
    ? excelData.slice(0, Math.min(12, excelData.length)).map(row => Number(row[firstNumeric]) || 0)
    : [65, 78, 80, 85, 70, 88, 92];

  const categoryCounts = hasData && categoryColumn ? excelData.reduce((acc, row) => {
    const key = row[categoryColumn] ? String(row[categoryColumn]) : 'Unspecified';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {}) : {};

  const topCategories = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const barChartData = topCategories.length
    ? {
        labels: topCategories.map(([label]) => label),
        values: topCategories.map(([, count]) => Math.round((count / excelData.length) * 100))
      }
    : { labels: ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'], values: [95, 82, 88, 75, 98] };

  const shortages = topCategories.length
    ? topCategories.map(([label, count], i) => ({
        label,
        percent: Math.min(100, Math.round((count / excelData.length) * 100)),
        color: ['bg-blue-500', 'bg-purple-500', 'bg-amber-500', 'bg-emerald-500', 'bg-rose-500'][i % 5]
      }))
    : [
        { label: 'Materials', percent: 45, color: 'bg-blue-500' },
        { label: 'Packing', percent: 30, color: 'bg-purple-500' },
        { label: 'Chips', percent: 25, color: 'bg-amber-500' }
      ];

  const kpis = hasData ? [
    { label: "Rows", value: excelData.length.toLocaleString(), delta: `${columns.length} columns`, color: "text-emerald-500", icon: Activity },
    { label: "Completeness", value: `${fillRate}%`, delta: `${emptyFields} empty cells`, color: "text-blue-500", icon: CheckCircle },
    { label: "Numeric Fields", value: numericColumns.length || '0', delta: firstNumeric ? `Charting ${firstNumeric}` : "No numeric columns detected", color: "text-amber-500", icon: TrendingUp },
    { label: "Top Category", value: topCategories[0]?.[0] || 'N/A', delta: topCategories[0] ? `${topCategories[0][1]} rows` : "Upload data to populate", color: "text-red-500", icon: AlertTriangle }
  ] : [
    { label: "Health", value: MOCK_KPI_CONTEXT.healthIndex, delta: "+2.1%", color: "text-emerald-500", icon: Activity },
    { label: "On-Time", value: MOCK_KPI_CONTEXT.onTimeShipment, delta: "+1.4%", color: "text-blue-500", icon: CheckCircle },
    { label: "Production", value: MOCK_KPI_CONTEXT.productionRate, delta: "-0.8%", color: "text-amber-500", icon: TrendingUp },
    { label: "Delays", value: MOCK_KPI_CONTEXT.activeDelays, delta: "3 open", color: "text-red-500", icon: AlertTriangle }
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-xl md:text-2xl font-bold flex items-center gap-2">
            <LayoutDashboard className="w-6 h-6 text-emerald-500" />
            Operations Dashboard
          </h2>
          <p className="text-slate-500 text-sm">Supply chain health and short-term trends</p>
        </div>
        <div className="flex items-center gap-2">
          {ranges.map(r => (
            <button
              key={r.id}
              onClick={() => setRange(r.id)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition ${range === r.id ? 'bg-blue-600 text-white border-blue-600' : 'border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300'}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {hasData ? (
        <Badge type="success">Using {excelData.length} uploaded rows</Badge>
      ) : (
        <Badge type="warning">Upload an Excel file in External Systems to populate this dashboard</Badge>
      )}

      {/* KPI Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {kpis.map((k, i) => (
          <Card key={i} className="p-4 flex items-start justify-between">
            <div>
              <div className="text-xs uppercase text-slate-500 font-semibold">{k.label}</div>
              <div className={`text-2xl font-bold ${k.color} mt-1`}>{k.value}</div>
              <div className="text-xs text-emerald-600 dark:text-emerald-400 mt-1">{k.delta}</div>
            </div>
            <div className="p-2 rounded-lg bg-slate-100 dark:bg-slate-700/50">
              <k.icon className={`w-5 h-5 ${k.color}`} />
            </div>
          </Card>
        ))}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold">Production Trend</h3>
            <span className="text-xs text-slate-400">Range: {range.toUpperCase()}</span>
          </div>
          <SimpleLineChart data={lineChartData} />
        </Card>
        <Card>
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold">{hasData ? 'Top Categories' : 'On-Time Delivery'}</h3>
            <Badge type="info">{hasData ? 'Share of rows' : 'Top lanes'}</Badge>
          </div>
          <SimpleBarChart data={barChartData.values} labels={barChartData.labels} colorClass="bg-indigo-500" />
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold">Delay Heatmap</h3>
            <span className="text-xs text-slate-400">Working days</span>
          </div>
          <div className="grid grid-cols-7 gap-1 md:gap-2">
            {['M','T','W','T','F','S','S'].map(d => <div key={d} className="text-center text-xs text-slate-500">{d}</div>)}
            {[0, 2, 5, 1, 0, 8, 3, 2, 4, 1, 6, 2, 0, 1].map((val, i) => (
              <div key={i} className={`h-8 md:h-12 rounded flex items-center justify-center text-xs font-medium text-white ${val === 0 ? 'bg-slate-100 dark:bg-slate-800 text-slate-400' : val < 3 ? 'bg-emerald-400' : val < 6 ? 'bg-amber-400' : 'bg-red-500'}`}>{val > 0 ? val : ''}</div>
            ))}
          </div>
        </Card>
        <Card>
          <h3 className="font-semibold mb-4">Shortages</h3>
          <div className="flex flex-col gap-4">
            {shortages.map((item, i) => (
              <div key={i}>
                <div className="flex justify-between text-sm mb-1">
                  <span>{item.label}</span>
                  <span>{item.percent}%</span>
                </div>
                <div className="w-full bg-slate-200 h-2 rounded-full">
                  <div className={`h-full ${item.color}`} style={{ width: `${item.percent}%` }}></div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
};

const AnalyticsCenterView = ({ excelData }) => {
  const [activeTab, setActiveTab] = useState('cost');
  const [report, setReport] = useState(null);
  const [generating, setGenerating] = useState(false);
  const generateReport = async () => { setReport(null); setGenerating(true); const result = await callGeminiAPI("Summarize analytics."); setReport(result); setGenerating(false); };
  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <h2 className="text-xl md:text-2xl font-bold flex items-center gap-2"><TrendingUp className="w-6 h-6 text-indigo-500" />Analytics</h2>
        <Button variant="magic" icon={Sparkles} onClick={generateReport} disabled={generating}>{generating ? "..." : "AI Summary"}</Button>
      </div>
      {report && <Card className="bg-indigo-50 dark:bg-indigo-900/20"><p className="text-indigo-900 dark:text-indigo-200 text-sm whitespace-pre-line">{report}</p></Card>}
      <div className="flex border-b border-slate-200 overflow-x-auto"><button className="px-6 py-3 text-sm font-medium border-b-2 border-indigo-500 text-indigo-600">Cost Analysis</button></div>
      <Card><h3 className="font-semibold mb-6">Monthly Costs</h3><SimpleLineChart data={[40, 35, 55, 45, 60, 55, 70]} color='#ef4444' /></Card>
    </div>
  );
};

const DecisionSupportView = ({ excelData, user, addNotification }) => {
  const [input, setInput] = useState('');
  const [conversations, setConversations] = useState([]);
  const [currentConversationId, setCurrentConversationId] = useState(null);
  const [isTyping, setIsTyping] = useState(false);
  const [showNewChatConfirm, setShowNewChatConfirm] = useState(false);
  const scrollRef = useRef(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [conversations, currentConversationId]);

  // Load conversations from Supabase
  useEffect(() => {
    if (!user?.id) return;
    let active = true;

    const loadConversations = async () => {
      const { data, error } = await supabase
        .from('conversations')
        .select('*')
        .eq('user_id', user.id)
        .order('updated_at', { ascending: false });

      if (active && !error && data) {
        setConversations(data);
        // Set current conversation to the most recent one
        if (data.length > 0 && !currentConversationId) {
          setCurrentConversationId(data[0].id);
        }
      }
    };

    loadConversations();
    return () => { active = false; };
  }, [user?.id]);

  // Get current conversation
  const currentConversation = conversations.find(c => c.id === currentConversationId);
  const currentMessages = currentConversation?.messages || [];

  // Create new conversation
  const handleNewConversation = async () => {
    if (!user?.id) {
      addNotification?.("Please sign in before starting a new conversation.", "error");
      return;
    }
    setShowNewChatConfirm(false);

    const newConversation = {
      id: Date.now().toString(),
      user_id: user.id,
      title: 'New Conversation',
      messages: [{ role: 'ai', content: 'Hello! I am your SmartOps Decision Assistant. How can I help you today?' }],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    // Optimistically add so chatting keeps working even if Supabase insert fails
    setConversations(prev => [newConversation, ...prev]);
    setCurrentConversationId(newConversation.id);

    const { error } = await supabase
      .from('conversations')
      .insert([newConversation]);

    if (error) {
      console.error("Failed to create conversation in Supabase", error);
      addNotification?.("Conversation could not sync to the cloud; keeping a local copy.", "error");
      return;
    }

    addNotification?.("New conversation ready.", "success");
  };

  // Delete conversation
  const handleDeleteConversation = async (convId) => {
    if (!user?.id) return;

    const { error } = await supabase
      .from('conversations')
      .delete()
      .eq('id', convId)
      .eq('user_id', user.id);

    if (!error) {
      const newConversations = conversations.filter(c => c.id !== convId);
      setConversations(newConversations);

      // If deleted current conversation, switch to another
      if (convId === currentConversationId) {
        setCurrentConversationId(newConversations.length > 0 ? newConversations[0].id : null);
      }
    }
  };

  // Send message
  const handleSend = async (e) => {
    e.preventDefault();
    if (!input.trim() || !currentConversationId) return;

    const userMsg = { role: 'user', content: input, timestamp: new Date().toISOString() };
    setInput('');
    setIsTyping(true);

    // Update messages immediately for UI
    const updatedMessages = [...currentMessages, userMsg];
    setConversations(prev => prev.map(c =>
      c.id === currentConversationId
        ? { ...c, messages: updatedMessages, updated_at: new Date().toISOString() }
        : c
    ));

    // Call AI
    const context = excelData ? `USER DATA: ${JSON.stringify(excelData.slice(0, 5))}` : "No data available.";
    const result = await callGeminiAPI(input, context);

    const aiMsg = { role: 'ai', content: result, timestamp: new Date().toISOString() };
    const finalMessages = [...updatedMessages, aiMsg];

    // Update title based on first user message
    const newTitle = currentMessages.length <= 1 ? input.slice(0, 50) : currentConversation.title;

    // Update conversation
    const updatedConversation = {
      ...currentConversation,
      title: newTitle,
      messages: finalMessages,
      updated_at: new Date().toISOString()
    };

    // Save to Supabase
    const { error: updateError } = await supabase
      .from('conversations')
      .update({
        title: newTitle,
        messages: finalMessages,
        updated_at: new Date().toISOString()
      })
      .eq('id', currentConversationId)
      .eq('user_id', user.id);

    if (updateError) {
      console.error("Failed to save messages to Supabase", updateError);
      addNotification?.("Message kept locally; cloud save failed.", "error");
    }

    // Update local state
    setConversations(prev => prev.map(c =>
      c.id === currentConversationId ? updatedConversation : c
    ));

    setIsTyping(false);
  };

  // Format timestamp
  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
    return date.toLocaleDateString();
  };

  return (
    <div className="h-[calc(100vh-140px)] flex flex-col md:flex-row gap-6 animate-fade-in">
      {/* Conversations Sidebar */}
      <Card className="md:w-80 w-full h-full max-h-[calc(100vh-180px)] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between border-b p-4">
          <h3 className="font-semibold flex items-center gap-2">
            <Bot className="w-4 h-4" />
            Conversations
          </h3>
          <Button
            variant="primary"
            onClick={() => conversations.length > 0 ? setShowNewChatConfirm(true) : handleNewConversation()}
            className="px-3 py-1 text-xs"
          >
            + New
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto divide-y">
          {conversations.length === 0 ? (
            <div className="p-8 text-center">
              <Bot className="w-12 h-12 text-slate-300 mx-auto mb-3" />
              <p className="text-sm text-slate-400 mb-4">No conversations yet</p>
              <Button variant="primary" onClick={handleNewConversation} className="text-xs">
                Start Chatting
              </Button>
            </div>
          ) : (
            conversations.map((conv) => (
              <div
                key={conv.id}
                className={`p-3 hover:bg-slate-50 dark:hover:bg-slate-700 cursor-pointer transition group ${
                  currentConversationId === conv.id ? 'bg-blue-50 dark:bg-blue-900/20 border-l-4 border-l-blue-600' : ''
                }`}
                onClick={() => setCurrentConversationId(conv.id)}
              >
                <div className="flex items-start justify-between mb-1">
                  <h4 className="font-medium text-sm line-clamp-1 flex-1">
                    {conv.title || 'New Conversation'}
                  </h4>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteConversation(conv.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-100 dark:hover:bg-red-900/30 rounded transition"
                  >
                    <X className="w-3 h-3 text-red-600" />
                  </button>
                </div>
                <div className="flex items-center justify-between">
                  <p className="text-xs text-slate-400 line-clamp-1 flex-1">
                    {conv.messages[conv.messages.length - 1]?.content.slice(0, 40)}...
                  </p>
                  <span className="text-xs text-slate-400 ml-2">
                    {formatTime(conv.updated_at)}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <Badge type="info">{conv.messages.length} msgs</Badge>
                </div>
              </div>
            ))
          )}
        </div>
      </Card>

      {/* Chat Area */}
      <Card className="flex-1 flex flex-col overflow-hidden p-0 h-full">
        {currentConversation ? (
          <>
            <div className="bg-slate-50 dark:bg-slate-800 border-b p-4 flex items-center justify-between">
              <div>
                <h3 className="font-semibold">{currentConversation.title}</h3>
                <p className="text-xs text-slate-500">
                  {currentMessages.length} messages - Updated {formatTime(currentConversation.updated_at)}
                </p>
              </div>
              <button
                onClick={() => setShowNewChatConfirm(true)}
                className="p-2 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition"
                title="New conversation"
              >
                <FileText className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4" ref={scrollRef}>
              {currentMessages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} animate-fade-in`}>
                  <div className={`max-w-[85%] rounded-2xl p-3 md:p-4 ${
                    msg.role === 'user'
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-100 dark:bg-slate-700 text-slate-900 dark:text-slate-100'
                  }`}>
                    <div className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</div>
                    {msg.timestamp && (
                      <div className={`text-xs mt-2 ${msg.role === 'user' ? 'text-blue-100' : 'text-slate-400'}`}>
                        {formatTime(msg.timestamp)}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {isTyping && (
                <div className="flex justify-start">
                  <div className="bg-slate-100 dark:bg-slate-700 rounded-2xl p-4">
                    <div className="flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                      <span className="text-sm text-slate-600 dark:text-slate-300">AI is thinking...</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="p-4 border-t bg-white dark:bg-slate-800">
              <form onSubmit={handleSend} className="relative">
                <input
                  type="text"
                  className="w-full pl-4 pr-12 py-3 rounded-xl border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="Ask AI anything..."
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  disabled={isTyping}
                />
                <button
                  type="submit"
                  disabled={isTyping || !input.trim()}
                  className="absolute right-2 top-2 p-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Send className="w-4 h-4" />
                </button>
              </form>
              {excelData && (
                <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                  <Database className="w-3 h-3" />
                  <span>Using {excelData.length} rows of data for context</span>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <Bot className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-slate-600 dark:text-slate-400 mb-2">
                No Conversation Selected
              </h3>
              <p className="text-slate-500 mb-4">
                Start a new conversation to chat with the AI
              </p>
              <Button variant="primary" onClick={handleNewConversation}>
                Start New Conversation
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* New Chat Confirmation Modal */}
      {showNewChatConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <Card className="max-w-md w-full">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                <FileText className="w-6 h-6 text-blue-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold">Start New Conversation?</h3>
                <p className="text-sm text-slate-500">Current conversation will be saved</p>
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="secondary" onClick={() => setShowNewChatConfirm(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={handleNewConversation}>
                New Conversation
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
};

const SettingsView = ({ darkMode, setDarkMode, user, addNotification }) => {
  const [apiKey, setApiKey] = useState(localStorage.getItem('gemini_api_key') || '');
  const [showApiKey, setShowApiKey] = useState(false);

  const handleSaveApiKey = () => {
    if (apiKey.trim()) {
      localStorage.setItem('gemini_api_key', apiKey.trim());
      addNotification("API key saved!", "success");
    } else {
      localStorage.removeItem('gemini_api_key');
      addNotification("API key cleared", "info");
    }
  };

  const handleClearApiKey = () => {
    setApiKey('');
    localStorage.removeItem('gemini_api_key');
    addNotification("API key cleared", "info");
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6 animate-fade-in">
      <h2 className="text-2xl font-bold">Settings</h2>

      {/* Profile Card */}
      <Card>
        <h3 className="font-semibold mb-4 flex items-center gap-2">
          <User className="w-5 h-5" />
          Profile
        </h3>
        <p className="text-slate-500">Email: {user.email}</p>
      </Card>

      {/* API Configuration Card */}
      <Card>
        <h3 className="font-semibold mb-4 flex items-center gap-2">
          <Bot className="w-5 h-5 text-purple-500" />
          AI API Configuration
        </h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2">
              Google Gemini API Key
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type={showApiKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Enter your API key"
                  className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
                />
                <button
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  {showApiKey ? "Hide" : "Show"}
                </button>
              </div>
            </div>
            <p className="text-xs text-slate-500 mt-2">
              Get a free API key: <a href="https://ai.google.dev/" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">https://ai.google.dev/</a>
            </p>
          </div>

          <div className="flex gap-2">
            <Button onClick={handleSaveApiKey} variant="primary">
              Save key
            </Button>
            <Button onClick={handleClearApiKey} variant="secondary">
              Clear key
            </Button>
          </div>

          {/* API Status */}
          <div className="bg-blue-50 dark:bg-blue-900/20 p-4 rounded-lg border border-blue-200 dark:border-blue-800">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-5 h-5 text-blue-600 mt-0.5" />
              <div className="text-sm text-blue-900 dark:text-blue-200">
                <p className="font-medium mb-1">Usage notes:</p>
                <ul className="list-disc list-inside space-y-1 text-xs">
                  <li>Free API tiers have daily quotas</li>
                  <li>If the quota is exhausted, wait for reset or use a new key</li>
                  <li>API keys are stored locally in your browser, never uploaded</li>
                  <li>Recommended model: gemini-2.5-flash</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* Theme Settings */}
      <Card>
        <h3 className="font-semibold mb-4 flex items-center gap-2">
          {darkMode ? <Moon className="w-5 h-5" /> : <Sun className="w-5 h-5" />}
          Theme Settings
        </h3>
        <div className="flex items-center justify-between">
          <span className="text-slate-600 dark:text-slate-300">Dark mode</span>
          <button
            onClick={() => setDarkMode(!darkMode)}
            className={`relative w-14 h-7 rounded-full transition-colors ${darkMode ? 'bg-blue-600' : 'bg-slate-300'}`}
          >
            <div className={`absolute top-1 w-5 h-5 bg-white rounded-full transition-transform ${darkMode ? 'translate-x-8' : 'translate-x-1'}`} />
          </button>
        </div>
      </Card>
    </div>
  );
};






