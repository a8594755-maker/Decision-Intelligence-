import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  User, Bot, Moon, Sun, AlertCircle, Settings, Database, BarChart3, Cpu,
} from 'lucide-react';
import { Card, Button } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';
import { useApp } from '../contexts/AppContext';
import AdminLogicControlCenter from '../views/AdminLogicControlCenter';
import DataImportPanel from '../components/DataImportPanel';
import ApiUsageTab from '../components/settings/ApiUsageTab';
import ModelConfigTab from '../components/settings/ModelConfigTab';

const TABS = [
  { key: 'profile', label: 'Profile & API', icon: User },
  { key: 'logic',   label: 'Logic Control', icon: Settings },
  { key: 'data',    label: 'Data Import',   icon: Database },
  { key: 'models',  label: 'Model Config',  icon: Cpu },
  { key: 'usage',   label: 'API Usage',    icon: BarChart3 },
];

export default function SettingsPage() {
  const { user } = useAuth();
  const { darkMode, setDarkMode } = useApp();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('profile');

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="max-w-5xl mx-auto px-4 md:px-8 py-8 space-y-6">
        {/* Page header */}
        <div className="mb-2">
          <p className="text-xs font-semibold tracking-widest uppercase text-indigo-500 mb-1">
            CONFIGURATION
          </p>
          <h1 className="text-3xl font-bold tracking-tight" style={{ color: 'var(--text-primary)' }}>
            Settings
          </h1>
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 border-b" style={{ borderColor: 'var(--border-default)' }}>
          {/* eslint-disable-next-line no-unused-vars -- Icon is used in JSX below */}
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === key
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent hover:text-[var(--text-primary)]'
              }`}
              style={activeTab !== key ? { color: 'var(--text-secondary)' } : undefined}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {activeTab === 'profile' && (
          <div className="space-y-6">
            <Card>
              <h3 className="font-semibold mb-4 flex items-center gap-2">
                <User className="w-5 h-5" /> Profile
              </h3>
              <p style={{ color: 'var(--text-secondary)' }}>Email: {user?.email}</p>
            </Card>

            <Card>
              <h3 className="font-semibold mb-4 flex items-center gap-2">
                <Bot className="w-5 h-5 text-purple-500" /> AI Configuration (Edge Functions)
              </h3>
              <div className="space-y-4">
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  AI keys are no longer stored in browser localStorage.
                  Configure <code>GEMINI_API_KEY</code> and <code>DEEPSEEK_API_KEY</code> in Supabase Edge Function secrets.
                </p>
                <div className="bg-indigo-50 dark:bg-indigo-900/20 p-4 rounded-lg border border-indigo-200 dark:border-indigo-800">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="w-5 h-5 text-indigo-600 mt-0.5" />
                    <ul className="list-disc list-inside space-y-1 text-xs text-indigo-900 dark:text-indigo-200">
                      <li>All AI requests are routed via Supabase Edge Function <code>ai-proxy</code></li>
                      <li>Set secrets with: <code>supabase secrets set GEMINI_API_KEY=... DEEPSEEK_API_KEY=...</code></li>
                    </ul>
                  </div>
                </div>
              </div>
            </Card>

            <Card>
              <h3 className="font-semibold mb-4 flex items-center gap-2">
                {darkMode ? <Moon className="w-5 h-5" /> : <Sun className="w-5 h-5" />}
                Theme Settings
              </h3>
              <div className="flex items-center justify-between">
                <span style={{ color: 'var(--text-secondary)' }}>Dark mode</span>
                <button
                  onClick={() => setDarkMode(!darkMode)}
                  className={`relative w-14 h-7 rounded-full transition-colors ${darkMode ? 'bg-indigo-600' : 'bg-stone-300'}`}
                >
                  <div className={`absolute top-1 w-5 h-5 bg-white rounded-full transition-transform ${darkMode ? 'translate-x-8' : 'translate-x-1'}`} />
                </button>
              </div>
            </Card>
          </div>
        )}

        {activeTab === 'logic' && (
          <AdminLogicControlCenter setView={(v) => navigate(`/${v === 'decision' ? 'plan' : v}`)} />
        )}

        {activeTab === 'data' && (
          <DataImportPanel />
        )}

        {activeTab === 'models' && (
          <ModelConfigTab />
        )}

        {activeTab === 'usage' && (
          <ApiUsageTab />
        )}
      </div>
    </div>
  );
}
