import React, { useState, useEffect, useRef } from 'react';
import * as XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { 
  LayoutDashboard, Database, Activity, AlertTriangle, BarChart3, Bot, Settings, LogOut, 
  Search, Bell, User, Upload, RefreshCw, CheckCircle, AlertCircle, FileText, TrendingUp, 
  DollarSign, Clock, Truck, Package, Menu, X, ChevronRight, Download, Moon, Sun, Send, Sparkles, Loader2
} from 'lucide-react';

// --- 1. 設定 Supabase (請填入你的資料) ---
const supabaseUrl = "https://cbxvqqqulwytdblivtoe.supabase.co";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNieHZxcXF1bHd5dGRibGl2dG9lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ0NjQzNjUsImV4cCI6MjA4MDA0MDM2NX0.3PeFtqJAkoxrosFeAiXbOklRCDxaQjH2VjXWwEiFyYI"; 
const supabase = createClient(supabaseUrl, supabaseKey);

// --- Robust Gemini API Integration ---
const callGeminiAPI = async (prompt, systemContext = "") => {
  const apiKey = "AIzaSyBiPV68i9HR_D6a_PQ3lwSEJSIYZ0eF3j4"; 
  
  if (!apiKey) {
    console.warn("No API Key found.");
    await new Promise(resolve => setTimeout(resolve, 1500)); 
    return "I'm currently running in offline mode. Please check your API key connection.";
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [{ text: systemContext ? `Context: ${systemContext}\n\nUser Query: ${prompt}` : prompt }]
          }]
        })
      }
    );
    if (!response.ok) throw new Error(`API Error: ${response.status}`);
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "No response generated.";
  } catch (error) {
    console.error("Gemini API Failed:", error);
    return "Error connecting to AI service.";
  }
};

// --- UI Components (Responsive Updates) ---
const Card = ({ children, className = "", onClick, hoverEffect = false }) => (
  <div onClick={onClick} className={`bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm p-4 md:p-6 ${hoverEffect ? 'hover:shadow-lg hover:border-blue-500 dark:hover:border-blue-400 cursor-pointer transition-all duration-200' : ''} ${className}`}>
    {children}
  </div>
);

const Button = ({ children, onClick, variant = "primary", className = "", disabled = false, icon: Icon }) => {
  const baseStyles = "flex items-center justify-center px-4 py-2 rounded-lg font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed text-sm md:text-base";
  const variants = {
    primary: "bg-blue-600 hover:bg-blue-700 text-white focus:ring-blue-500",
    secondary: "bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-600 focus:ring-slate-500",
    danger: "bg-red-600 hover:bg-red-700 text-white focus:ring-red-500",
    success: "bg-emerald-600 hover:bg-emerald-700 text-white focus:ring-emerald-500",
    magic: "bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 text-white hover:opacity-90 focus:ring-purple-500"
  };
  return (
    <button onClick={onClick} disabled={disabled} className={`${baseStyles} ${variants[variant]} ${className}`}>
      {Icon && <Icon className="w-4 h-4 mr-2" />}
      {children}
    </button>
  );
};

const Badge = ({ children, type = "info" }) => {
  const styles = {
    info: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
    success: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
    warning: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    danger: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  };
  return <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${styles[type]}`}>{children}</span>;
};

// Charts (Improved Responsiveness)
const SimpleLineChart = ({ data, color = "#3b82f6" }) => {
  const max = Math.max(...data) * 1.2;
  const points = data.map((val, i) => `${(i / (data.length - 1)) * 100},${100 - (val / max) * 100}`).join(' ');
  return (
    <div className="h-48 md:h-64 w-full relative">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full overflow-visible">
        <polyline fill="none" stroke={color} strokeWidth="2" points={points} vectorEffect="non-scaling-stroke" />
        {data.map((val, i) => (
          <circle key={i} cx={(i / (data.length - 1)) * 100} cy={100 - (val / max) * 100} r="3" fill={color} className="hover:r-5 transition-all cursor-pointer opacity-0 hover:opacity-100">
            <title>{val}</title>
          </circle>
        ))}
      </svg>
      {/* Grid Lines */}
      <div className="absolute inset-0 flex flex-col justify-between pointer-events-none opacity-10">
        {[...Array(5)].map((_, i) => <div key={i} className="w-full h-px bg-slate-500" />)}
      </div>
    </div>
  );
};

const SimpleBarChart = ({ data, labels, colorClass = "bg-blue-500" }) => {
  const max = Math.max(...data);
  return (
    <div className="h-48 md:h-64 flex items-end justify-between gap-2">
      {data.map((val, i) => (
        <div key={i} className="flex-1 flex flex-col items-center group h-full justify-end">
          <div className="relative w-full flex items-end justify-center h-full bg-slate-100 dark:bg-slate-700/50 rounded-t-sm overflow-hidden">
            <div style={{ height: `${(val / max) * 100}%` }} className={`w-full ${colorClass} transition-all duration-500 group-hover:opacity-80 relative`}>
               <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-slate-800 text-white text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10">{val}%</div>
            </div>
          </div>
          <span className="text-xs text-slate-500 dark:text-slate-400 mt-2 truncate w-full text-center hidden sm:block">{labels[i]}</span>
          {/* Mobile only simplified label */}
          <span className="text-xs text-slate-500 dark:text-slate-400 mt-1 sm:hidden">{labels[i].substring(0,1)}</span>
        </div>
      ))}
    </div>
  );
};

// Mock Data
const MOCK_ALERTS = [{ id: 1, category: "Material Shortage", item: "Lithium Batteries", supplier: "Voltaic Supplies", risk: "High", impact: "Production Stop Risk", rootCause: "Supplier strike.", recommendation: "Activate backup supplier." }, { id: 2, category: "Delivery Delay", item: "Circuit Boards", supplier: "TechTronix", risk: "Medium", impact: "2 Day Delay", rootCause: "Port congestion.", recommendation: "Expedite Air Freight." }, { id: 3, category: "Quantity Mismatch", item: "Steel Casings", supplier: "MetalWorks", risk: "Low", impact: "Inventory Discrepancy", rootCause: "Packing error.", recommendation: "Request credit note." }];
const MOCK_KPI_CONTEXT = { healthIndex: "94%", goodsReceipt: "98%", productionRate: "87%", onTimeShipment: "92%", activeDelays: 3, riskItems: 12 };
const MOCK_CHAT_HISTORY = [{ role: 'ai', content: "Hello! I am your SmartOps Decision Assistant. Upload an Excel file to get started!" }];

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

  const fetchUserData = async (userId) => {
    const { data, error } = await supabase.from('user_files').select('data').eq('user_id', userId).order('created_at', { ascending: false }).limit(1);
    if (data && data.length > 0) {
      setExcelData(data[0].data);
      addNotification("Data restored from cloud.", "success");
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
      case 'external': return <ExternalSystemsView addNotification={addNotification} onFileUpload={handleExcelUpload} excelData={excelData} />;
      case 'integration': return <DataIntegrationView addNotification={addNotification} />;
      case 'alerts': return <SmartAlertsView addNotification={addNotification} excelData={excelData} />;
      case 'dashboard': return <OperationsDashboardView />;
      case 'analytics': return <AnalyticsCenterView excelData={excelData} />;
      case 'decision': return <DecisionSupportView excelData={excelData} />;
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

  const navItems = [{ id: 'home', label: 'Home', icon: LayoutDashboard }, { id: 'dashboard', label: 'Dashboard', icon: BarChart3 }, { id: 'alerts', label: 'Alerts', icon: AlertTriangle }, { id: 'analytics', label: 'Analytics', icon: TrendingUp }, { id: 'decision', label: 'Decision AI', icon: Bot }];

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
              <button key={item.id} onClick={() => { setView(item.id); setIsMobileMenuOpen(false); }} className={`flex items-center p-3 rounded-lg text-sm font-medium ${view === item.id ? 'bg-blue-50 text-blue-600' : 'bg-slate-50 text-slate-600'}`}>
                <item.icon className="w-4 h-4 mr-2" />{item.label}
              </button>
            ))}
            <button onClick={handleLogout} className="flex items-center p-3 rounded-lg text-sm font-medium bg-red-50 text-red-600 col-span-2 justify-center"><LogOut className="w-4 h-4 mr-2" />Logout</button>
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

const ExternalSystemsView = ({ addNotification, onFileUpload, excelData }) => {
  const [loading, setLoading] = useState(false);
  const handleSync = () => { setLoading(true); setTimeout(() => { setLoading(false); addNotification("Synced!", "success"); }, 2000); };
  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <h2 className="text-xl md:text-2xl font-bold flex items-center gap-2"><Database className="w-6 h-6 text-blue-500" />External Systems</h2>
        <div className="flex gap-2 w-full sm:w-auto">
          <div className="relative flex-1 sm:flex-none"><input type="file" accept=".xlsx, .xls" onChange={onFileUpload} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" /><Button variant="secondary" icon={Upload} className="w-full">Upload</Button></div>
          <Button onClick={handleSync} disabled={loading} icon={RefreshCw} className="flex-1 sm:flex-none">{loading ? "Syncing..." : "Sync"}</Button>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 md:gap-6">{['ERP (SAP)', 'MES (Siemens)', 'WMS (Oracle)'].map((sys, i) => (<Card key={i} className="flex items-center justify-between"><div className="flex items-center gap-3"><div className="w-10 h-10 rounded-full bg-slate-100 dark:bg-slate-700 flex items-center justify-center font-bold text-slate-500">{sys[0]}</div><div><h4 className="font-semibold text-sm md:text-base">{sys}</h4><p className="text-xs text-green-500">Connected</p></div></div></Card>))}</div>
      <Card>
        <div className="flex justify-between mb-4 items-center"><h3 className="font-semibold text-lg">Preview</h3>{excelData && <Badge type="success">{excelData.length} Rows</Badge>}</div>
        <div className="overflow-x-auto">
          {excelData ? (
             <table className="w-full text-sm text-left border-collapse min-w-[600px]"><thead className="text-xs uppercase bg-slate-50 dark:bg-slate-700/50"><tr>{Object.keys(excelData[0]).map((key) => <th key={key} className="px-4 py-3 border-b">{key}</th>)}</tr></thead><tbody>{excelData.slice(0, 5).map((row, i) => (<tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-700/30">{Object.values(row).map((val, j) => <td key={j} className="px-4 py-3 border-b">{val}</td>)}</tr>))}</tbody></table>
          ) : (<div className="text-center py-8 text-slate-400">No data loaded. Upload an Excel file.</div>)}
        </div>
      </Card>
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

const OperationsDashboardView = () => {
  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <h2 className="text-xl md:text-2xl font-bold flex items-center gap-2"><LayoutDashboard className="w-6 h-6 text-emerald-500" />Dashboard</h2>
        <select className="bg-white dark:bg-slate-700 border border-slate-300 rounded-lg text-sm px-3 py-2 w-full sm:w-auto"><option>Last 7 Days</option><option>Last Month</option></select>
      </div>
      {/* Responsive Grid for KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 md:gap-4">
        {[{ l: "Health", v: MOCK_KPI_CONTEXT.healthIndex, c: "text-emerald-500" }, { l: "Receipt", v: MOCK_KPI_CONTEXT.goodsReceipt, c: "text-blue-500" }, { l: "Production", v: MOCK_KPI_CONTEXT.productionRate, c: "text-amber-500" }, { l: "Shipment", v: MOCK_KPI_CONTEXT.onTimeShipment, c: "text-blue-500" }, { l: "Delays", v: MOCK_KPI_CONTEXT.activeDelays, c: "text-red-500" }, { l: "Risks", v: MOCK_KPI_CONTEXT.riskItems, c: "text-amber-500" }].map((k, i) => (
          <Card key={i} className="p-3 md:p-4 text-center">
            <div className="text-[10px] md:text-xs text-slate-500 uppercase font-bold tracking-wider mb-1">{k.l}</div>
            <div className={`text-xl md:text-2xl font-bold ${k.c}`}>{k.v}</div>
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card><h3 className="font-semibold mb-4">Production Trend</h3><SimpleLineChart data={[65, 78, 80, 85, 70, 88, 92]} /></Card>
        <Card><h3 className="font-semibold mb-4">On-Time Delivery</h3><SimpleBarChart data={[95, 82, 88, 75, 98]} labels={['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']} colorClass="bg-indigo-500" /></Card>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <h3 className="font-semibold mb-4">Delay Heatmap</h3>
          <div className="grid grid-cols-7 gap-1 md:gap-2">
            {['M','T','W','T','F','S','S'].map(d => <div key={d} className="text-center text-xs text-slate-500">{d}</div>)}
            {[0, 2, 5, 1, 0, 8, 3, 2, 4, 1, 6, 2, 0, 1].map((val, i) => (
              <div key={i} className={`h-8 md:h-12 rounded flex items-center justify-center text-xs font-medium text-white ${val === 0 ? 'bg-slate-100 dark:bg-slate-800 text-slate-400' : val < 3 ? 'bg-emerald-400' : val < 6 ? 'bg-amber-400' : 'bg-red-500'}`}>{val > 0 ? val : ''}</div>
            ))}
          </div>
        </Card>
        <Card><h3 className="font-semibold mb-4">Shortages</h3><div className="flex flex-col gap-4">{[{ l: 'Materials', p: 45, c: 'bg-blue-500' }, { l: 'Packing', p: 30, c: 'bg-purple-500' }, { l: 'Chips', p: 25, c: 'bg-amber-500' }].map((item, i) => (<div key={i}><div className="flex justify-between text-sm mb-1"><span>{item.l}</span><span>{item.p}%</span></div><div className="w-full bg-slate-200 h-2 rounded-full"><div className={`h-full ${item.c}`} style={{ width: `${item.p}%` }}></div></div></div>))}</div></Card>
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

const DecisionSupportView = ({ excelData }) => {
  const [input, setInput] = useState('');
  const [chat, setChat] = useState(MOCK_CHAT_HISTORY);
  const [isTyping, setIsTyping] = useState(false);
  const scrollRef = useRef(null);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [chat]);
  
  const handleSend = async (e) => { 
    e.preventDefault(); if (!input.trim()) return; 
    const userMsg = { role: 'user', content: input }; setChat(prev => [...prev, userMsg]); setInput(''); setIsTyping(true); 
    let context = excelData ? `USER DATA: ${JSON.stringify(excelData.slice(0, 5))}` : "No data.";
    const result = await callGeminiAPI(input, context); 
    setChat(prev => [...prev, { role: 'ai', content: result }]); setIsTyping(false); 
  };
  
  return (
    <div className="h-[calc(100vh-140px)] flex flex-col md:flex-row gap-6 animate-fade-in">
      <Card className="flex-1 flex flex-col overflow-hidden p-0 h-full">
        <div className="bg-slate-50 dark:bg-slate-800 border-b p-4"><h3 className="font-semibold">AI Assistant</h3></div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4" ref={scrollRef}>{chat.map((msg, i) => (<div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}><div className={`max-w-[85%] rounded-2xl p-3 md:p-4 text-sm ${msg.role === 'user' ? 'bg-blue-600 text-white' : 'bg-slate-100 dark:bg-slate-700'}`}>{msg.content}</div></div>))}{isTyping && <div className="p-4 text-slate-400 text-sm">Thinking...</div>}</div>
        <div className="p-4 border-t"><form onSubmit={handleSend} className="relative"><input type="text" className="w-full pl-4 pr-12 py-3 rounded-xl border" placeholder="Ask AI..." value={input} onChange={(e) => setInput(e.target.value)} /><button type="submit" className="absolute right-2 top-2 p-2 bg-blue-600 text-white rounded-lg"><Send className="w-4 h-4" /></button></form></div>
      </Card>
    </div>
  );
};

const SettingsView = ({ darkMode, setDarkMode, user, addNotification }) => { return (<div className="max-w-3xl mx-auto space-y-6"><h2 className="text-2xl font-bold">Settings</h2><Card><h3 className="font-semibold mb-4">Profile</h3><p className="text-slate-500">Email: {user.email}</p></Card><div className="flex justify-end"><Button onClick={() => addNotification("Saved", "success")}>Save</Button></div></div>);};