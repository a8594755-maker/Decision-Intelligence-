import React, { useState, useEffect, useRef } from 'react';
import * as XLSX from 'xlsx';
import {
  Target, Search, Calculator, Zap, BarChart3, Bot, Settings, LogOut,
  Search as SearchIcon, User, Upload, RefreshCw, CheckCircle, AlertCircle, FileText, TrendingUp,
  Menu, X, ChevronRight, ChevronLeft, Download, Moon, Sun, Send, Sparkles, Loader2, Building2, ChevronDown,
  DollarSign, History, LayoutDashboard, Activity, AlertTriangle, Database, Cloud
} from 'lucide-react';

// --- Import UI Components ---
import { Card, Button, Badge } from './components/ui';
import { SimpleLineChart, SimpleBarChart } from './components/charts';

// --- Import Services ---
import { supabase } from './services/supabaseClient';
import { callGeminiAPI } from './services/geminiAPI';

// --- Import Utils ---
import { extractSuppliers } from './utils/dataProcessing';
import { viewToPath, pathToView } from './utils/router';

// --- Import Views ---
import SupplierManagementView from './views/SupplierManagementView';
import CostAnalysisView from './views/CostAnalysisView';
import EnhancedExternalSystemsView from './views/EnhancedExternalSystemsView';
import ImportHistoryView from './views/ImportHistoryView';
import BOMDataView from './views/BOMDataView';
import ForecastsView from './views/ForecastsView';
import RiskDashboardView from './views/RiskDashboardView';
import AdminLogicControlCenter from './views/AdminLogicControlCenter';
import AdminJobControlCenter from './views/AdminJobControlCenter';
import DecisionSupportView from './views/DecisionSupportView';
import DashboardView from './views/DashboardView';
import { APP_NAME, APP_TAGLINE } from './config/branding';


/** Sync view state with URL (pushState) and handle Back/Forward (popstate). Only active when session exists. */
function useSyncViewWithHistory(view, setView, session) {
  const isNavigatingRef = useRef(false);

  useEffect(() => {
    if (!session) return;
    if (isNavigatingRef.current) {
      isNavigatingRef.current = false;
      return;
    }
    const nextPath = viewToPath(view);
    const currentPath = window.location.pathname;
    if (nextPath && nextPath !== currentPath) {
      window.history.pushState({ view }, '', nextPath);
      try {
        sessionStorage.setItem('lastVisitedPath', nextPath);
      } catch (_) {}
    }
  }, [view, session]);

  useEffect(() => {
    if (!session) return;
    const handlePopState = () => {
      const currentPath = window.location.pathname;
      const targetView = pathToView(currentPath);
      if (targetView && targetView !== view) {
        isNavigatingRef.current = true;
        setView(targetView);
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [view, setView, session]);
}

/** When user returns to tab, re-sync view from URL so we don’t stay on wrong page (e.g. after bfcache). */
function useVisibilitySync(setView, session) {
  useEffect(() => {
    if (!session) return;
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      const pathname = window.location.pathname;
      const targetView = pathToView(pathname);
      if (targetView) setView(targetView);
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [setView, session]);
}

// --- Main App ---
export default function DecisionIntelligenceApp() {
  const [view, setView] = useState('login');
  const [session, setSession] = useState(null); 
  const [darkMode, setDarkMode] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('viewer'); // Role selection: viewer/editor/approver/publisher/admin
  const [loading, setLoading] = useState(false);
  const [excelData, setExcelData] = useState(null);
  
  // Global data source state for all views
  const [globalDataSource, setGlobalDataSource] = useState('local'); // 'local' | 'sap'

  const addNotification = (msg, type = 'info') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    setNotifications(prev => [...prev, { id, msg, type }]);
    setTimeout(() => setNotifications(prev => prev.filter(n => n.id !== id)), 3000);
  };

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session) {
        const currentPath = window.location.pathname;
        const restoredView = pathToView(currentPath);
        if (restoredView) {
          setView(restoredView);
        } else {
          const lastPath = sessionStorage.getItem('lastVisitedPath');
          const fallbackView = lastPath ? pathToView(lastPath) : null;
          setView(fallbackView || 'decision');
        }
        fetchUserData(session.user.id);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session);
      if (session) {
        if (event === 'SIGNED_IN') {
          setView('decision');
          window.history.replaceState({ view: 'decision' }, '', '/');
          sessionStorage.removeItem('returnUrl');
        }
        fetchUserData(session.user.id);
      } else {
        try {
          sessionStorage.setItem('returnUrl', window.location.pathname + window.location.search);
        } catch (_) {}
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

  useSyncViewWithHistory(view, setView, session);
  useVisibilitySync(setView, session);

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
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      addNotification(error.message, "error");
    } else {
      // Set/update user role after successful login
      try {
        const { error: upsertError } = await supabase
          .from('user_profiles')
          .upsert({ 
            user_id: data.user.id, 
            role: role,
            updated_at: new Date().toISOString()
          }, { onConflict: 'user_id' });
        if (upsertError) {
          console.error('Failed to update role:', upsertError);
        }
      } catch (err) {
        console.error('Role update error:', err);
      }
      addNotification(`Login Successful (Role: ${role})`, "success");
    }
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
    return <DecisionSupportView excelData={excelData} user={session?.user} addNotification={addNotification} />;
  };

  if (!session) {
    return (
      <div className={`min-h-screen flex items-center justify-center p-4 transition-colors duration-300 ${darkMode ? 'bg-slate-900 text-white' : 'bg-slate-50 text-slate-900'}`}>
        <div className="fixed top-4 right-4 z-50 space-y-2">
          {notifications.map(n => (<div key={n.id} className={`flex items-center p-4 rounded-lg shadow-lg text-white ${n.type === 'error' ? 'bg-red-600' : 'bg-blue-600'}`}>{n.msg}</div>))}
        </div>
        <div className="max-w-md w-full bg-white dark:bg-slate-800 rounded-2xl shadow-xl p-8 border border-slate-200 dark:border-slate-700">
          <div className="flex justify-center mb-8"><div className="bg-blue-600 p-3 rounded-lg"><Activity className="w-8 h-8 text-white" /></div></div>
          <h1 className="text-3xl font-bold text-center mb-2">{APP_NAME}</h1>
          <p className="text-center text-slate-500 dark:text-slate-400 mb-8">{APP_TAGLINE}</p>
          <form onSubmit={handleLogin} className="space-y-4">
            <div><label className="block text-sm font-medium mb-1">Email</label><input type="email" required className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            <div><label className="block text-sm font-medium mb-1">Password</label><input type="password" required className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
            <div>
              <label className="block text-sm font-medium mb-1">Role (for testing)</label>
              <select 
                value={role} 
                onChange={(e) => setRole(e.target.value)}
                className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
              >
                <option value="viewer">Viewer (Read-only)</option>
                <option value="logic_editor">Logic Editor (Edit)</option>
                <option value="logic_approver">Logic Approver (Approve)</option>
                <option value="logic_publisher">Logic Publisher (Publish)</option>
                <option value="admin">Admin (Full Access)</option>
              </select>
            </div>
            <button type="submit" disabled={loading} className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg font-medium transition-colors">{loading ? "Processing..." : "Log In"}</button>
            <button type="button" onClick={handleSignUp} disabled={loading} className="w-full bg-transparent border border-blue-600 text-blue-600 hover:bg-blue-50 py-2.5 rounded-lg font-medium transition-colors">Sign Up</button>
          </form>
        </div>
      </div>
    );
  }

  // Chat-first mode: keep only DecisionSupportView exposed in UI.

  return (
    <div className={`h-screen overflow-hidden flex flex-col transition-colors duration-300 ${darkMode ? 'bg-slate-900 text-slate-100' : 'bg-slate-50 text-slate-900'}`}>
      <div className="fixed top-4 right-4 z-50 space-y-2">{notifications.map(n => (<div key={n.id} className={`flex items-center p-4 rounded-lg shadow-lg text-white ${n.type === 'error' ? 'bg-red-600' : n.type === 'success' ? 'bg-emerald-600' : 'bg-blue-600'}`}>{n.msg}</div>))}</div>

      {/* Responsive Header */}
      <header className="flex-shrink-0 z-40 bg-white/80 dark:bg-slate-800/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-700">
        <div className="w-full px-4 md:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3 cursor-pointer" onClick={() => setView('decision')}>
            <div className="bg-blue-600 p-1.5 rounded-lg"><Activity className="w-6 h-6 text-white" /></div>
            <span className="text-xl font-bold">{APP_NAME}</span>
          </div>

          <div className="flex items-center space-x-2 md:space-x-4">
            <button onClick={() => setDarkMode(!darkMode)} className="p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-full">{darkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}</button>
            <div className="flex items-center space-x-3">
              <div className="text-right"><div className="text-sm font-medium">{session.user.email.split('@')[0]}</div></div>
              <button onClick={handleLogout} className="p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-full"><LogOut className="w-5 h-5" /></button>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 min-h-0 h-full overflow-hidden bg-gray-50 dark:bg-slate-900">
        {renderView()}
      </main>
    </div>
  );
}

// ... (Sub-components with Grid Fixes) ...


// Universal Module Card Component
const ModuleCard = ({ id, title, description, icon: Icon, color, onClick }) => {
  return (
    <Card 
      onClick={() => onClick(id)} 
      hoverEffect 
      className="group cursor-pointer h-full"
    >
      <div className="flex flex-col h-full">
        <div className="flex items-start justify-between mb-3">
          <div className={`p-2.5 rounded-lg bg-slate-100 dark:bg-slate-700/50 ${color} group-hover:scale-110 transition-transform`}>
            <Icon className="w-5 h-5" />
          </div>
          <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-blue-600 group-hover:translate-x-1 transition-all" />
        </div>
        <h3 className="text-base font-semibold mb-1.5 group-hover:text-blue-600 transition-colors">
          {title}
        </h3>
        <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
          {description}
        </p>
      </div>
    </Card>
  );
};

// Refactored Home View Component
const HomeView = ({ setView, globalDataSource, setGlobalDataSource }) => {
  // Core and Data Management Modules
  const coreModules = [
    { 
      id: 'cost-analysis', 
      title: "Cost Analysis", 
      description: "Track procurement costs and analyze supplier price trends", 
      icon: DollarSign, 
      color: "text-blue-500" 
    },
  ];

  const dataModules = [
    { 
      id: 'bom-data', 
      title: "BOM Data Dashboard", 
      description: "View and search BOM edges and demand FG data with filtering", 
      icon: Database, 
      color: "text-blue-500" 
    },
    { 
      id: 'suppliers', 
      title: "Supplier Management", 
      description: "Manage supplier data, track performance and KPI scores", 
      icon: Building2, 
      color: "text-purple-500" 
    },
    { 
      id: 'external', 
      title: "External Systems", 
      description: "Connect ERP, MES, WMS and other systems, upload data files", 
      icon: Database, 
      color: "text-cyan-500" 
    },
    { 
      id: 'import-history', 
      title: "Import History", 
      description: "View all data import records, preview data and undo batches", 
      icon: History, 
      color: "text-indigo-500" 
    },
    { 
      id: 'decision', 
      title: "AI Decision Assistant", 
      description: "Chat with AI to get supply chain decision insights and recommendations", 
      icon: Bot, 
      color: "text-amber-500" 
    },
  ];


  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="space-y-8 animate-fade-in">
      {/* Hero Section - Welcome Area + KPI Overview */}
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-slate-900 dark:text-slate-100 mb-2">
            👋 Welcome Back
          </h1>
          <p className="text-slate-600 dark:text-slate-400 text-sm md:text-base">
            Today is {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}. Here's your supply chain overview
          </p>
        </div>

        {/* Global Data Source Toggle */}
        <div className="flex items-center gap-4 bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700 shadow-sm">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">🔄 Data Source:</span>
          </div>
          <div className="flex bg-slate-100 dark:bg-slate-700 rounded-lg p-1">
            <button
              onClick={() => setGlobalDataSource('local')}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-all ${
                globalDataSource === 'local'
                  ? 'bg-green-500 text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Database className="w-4 h-4" />
              Local Upload
            </button>
            <button
              onClick={() => setGlobalDataSource('sap')}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-all ${
                globalDataSource === 'sap'
                  ? 'bg-blue-500 text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Cloud className="w-4 h-4" />
              SAP Data
            </button>
          </div>
          <span className={`text-xs font-medium px-2 py-1 rounded-full ${
            globalDataSource === 'sap'
              ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
              : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
          }`}>
            {globalDataSource === 'sap' ? 'Using SAP synced data system-wide' : 'Using locally uploaded data system-wide'}
          </span>
        </div>

      </div>

      {/* Core Modules - Core Function Modules */}
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-1">
            Core Features
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Daily operations and analytics tools
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {coreModules.map((module) => (
            <ModuleCard
              key={module.id}
              {...module}
              onClick={setView}
            />
          ))}
        </div>
      </div>

      {/* Data Management Modules - Data Management Modules */}
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-1">
            Data Management
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Manage suppliers, integrate system data, and AI tools
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {dataModules.map((module) => (
            <ModuleCard
              key={module.id}
              {...module}
              onClick={setView}
            />
          ))}
        </div>
      </div>

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
      addNotification(`Loaded ${rows.length} rows, awaiting AI analysis`, "success");
      const suppliers = extractSuppliers(rows);
      setSupplierPreview(suppliers);
      if (!suppliers.length) {
        setSupplierError('No supplier fields detected. Please ensure data contains supplier names.');
      }
      setCurrentPage(1);
      setSearchTerm('');
      if (rows.length > 0) {
        await runAiAnalysis(rows);
      } else {
        addNotification("File is empty, unable to analyze", "error");
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
                  AI Data Preview
                </h3>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  Loaded {stagedRows.length} rows. AI will analyze first 30 samples.
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  onClick={runAiAnalysis.bind(null, stagedRows)}
                  disabled={aiStatus === 'analyzing' || stagedRows.length === 0}
                >
                  {aiStatus === 'analyzing' ? "AI Analyzing..." : "Re-analyze"}
                </Button>
                <Button variant="secondary" onClick={handleReject}>
                  Discard
                </Button>
                <Button
                  variant="success"
                  onClick={handleAccept}
                  disabled={aiStatus !== 'ready' || saving}
                >
                  {saving ? "Saving..." : "Accept & Save"}
                </Button>
              </div>
            </div>

            {aiStatus === 'analyzing' && (
              <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
                <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                AI analyzing, please wait...
              </div>
            )}

            {aiStatus === 'error' && (
              <div className="flex items-center gap-2 text-sm text-red-600">
                <AlertCircle className="w-4 h-4" />
                {aiError || 'AI analysis failed'}
              </div>
            )}

            {aiPreview && aiStatus === 'ready' && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="md:col-span-2 space-y-2">
                  <div className="text-sm text-slate-500">AI Summary</div>
                  <p className="text-sm leading-relaxed whitespace-pre-line">{aiPreview.summary}</p>
                  <div className="text-sm text-slate-500 mt-3">Quality Check</div>
                  <p className="text-sm leading-relaxed whitespace-pre-line">{aiPreview.quality}</p>
                  {versionId && (
                    <Badge type="success">Version {versionId}</Badge>
                  )}
                </div>
                <div className="space-y-2">
                  <div className="text-sm text-slate-500">Fields</div>
                  <div className="flex flex-wrap gap-2">
                    {aiPreview.fields && aiPreview.fields.length > 0 ? aiPreview.fields.map((f) => (
                      <Badge key={f} type="info">{f}</Badge>
                    )) : <span className="text-xs text-slate-400">AI could not identify fields</span>}
                  </div>
                  <div className="text-xs text-slate-400 mt-2">
                    AI raw output (for debugging):<br />{aiPreview.raw?.slice(0, 200)}{aiPreview.raw && aiPreview.raw.length > 200 ? '…' : ''}
                  </div>
                </div>
              </div>
            )}

            {supplierPreview.length > 0 && (
              <div className="mt-2">
                <div className="flex items-center gap-2 mb-2">
                  <Database className="w-4 h-4 text-emerald-500" />
                  <span className="text-sm font-semibold">Detected Supplier Data (Deduplicated)</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse min-w-[600px]">
                    <thead className="bg-emerald-50 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-100">
                      <tr>
                        <th className="px-3 py-2 text-left">Name</th>
                        <th className="px-3 py-2 text-left">Contact</th>
                        <th className="px-3 py-2 text-left">Address</th>
                        <th className="px-3 py-2 text-left">Product Category</th>
                        <th className="px-3 py-2 text-left">Payment Terms</th>
                        <th className="px-3 py-2 text-left">Delivery Time</th>
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
                    <div className="text-xs text-slate-500 mt-1">Showing first 5 of {supplierPreview.length} suppliers</div>
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




// DecisionSupportView is now imported from ./views/DecisionSupportView

const SettingsView = ({ darkMode, setDarkMode, user, addNotification }) => {
  const handleShowAiSecretSetup = () => {
    addNotification(
      'Set Supabase Edge Function secrets: GEMINI_API_KEY and DEEPSEEK_API_KEY.',
      'info'
    );
  };

  const handleClearLegacyApiKeys = () => {
    localStorage.removeItem('gemini_api_key');
    localStorage.removeItem('deepseek_api_key');
    addNotification('Legacy browser API keys cleared.', 'success');
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
          AI Configuration (Edge Functions)
        </h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2">
              Server-side AI Secrets
            </label>
            <p className="text-xs text-slate-500 mt-2">
              AI keys are no longer stored in browser localStorage.
              Configure `GEMINI_API_KEY` and `DEEPSEEK_API_KEY` in Supabase Edge Function secrets.
            </p>
          </div>

          <div className="flex gap-2">
            <Button onClick={handleShowAiSecretSetup} variant="primary">
              Show setup hint
            </Button>
            <Button onClick={handleClearLegacyApiKeys} variant="secondary">
              Clear legacy local keys
            </Button>
          </div>

          {/* API Status */}
          <div className="bg-blue-50 dark:bg-blue-900/20 p-4 rounded-lg border border-blue-200 dark:border-blue-800">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-5 h-5 text-blue-600 mt-0.5" />
              <div className="text-sm text-blue-900 dark:text-blue-200">
                <p className="font-medium mb-1">Usage notes:</p>
                <ul className="list-disc list-inside space-y-1 text-xs">
                  <li>All AI requests are routed via Supabase Edge Function `ai-proxy`</li>
                  <li>Provider keys are server-managed (not exposed to browser)</li>
                  <li>Set secrets with: `supabase secrets set GEMINI_API_KEY=... DEEPSEEK_API_KEY=...`</li>
                  <li>Prompt 1-3: Gemini 3.1 Pro (`gemini-3.1-pro-preview`) via Edge Function</li>
                  <li>Prompt 4-5 + chat priority: DeepSeek V3.2 (`deepseek-chat`) via Edge Function</li>
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
