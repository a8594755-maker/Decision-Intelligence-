import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  User, Bot, Moon, Sun, AlertCircle, Settings, Database, Shield, Key,
} from 'lucide-react';
import { Card, Button, Badge } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';
import { useApp } from '../contexts/AppContext';
import AdminLogicControlCenter from '../views/AdminLogicControlCenter';

const TABS = [
  { key: 'profile', label: 'Profile & API', icon: User },
  { key: 'logic',   label: 'Logic Control', icon: Settings },
  { key: 'data',    label: 'Data Import',   icon: Database },
];

export default function SettingsPage() {
  const { user, addNotification } = useAuth();
  const { darkMode, setDarkMode } = useApp();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('profile');

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-4 md:px-6 py-6 space-y-6">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Settings className="w-6 h-6 text-slate-400" />
          Settings
        </h1>

        {/* Tab bar */}
        <div className="flex gap-1 border-b border-slate-200 dark:border-slate-700">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === key
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
              }`}
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
              <p className="text-slate-500">Email: {user?.email}</p>
            </Card>

            <Card>
              <h3 className="font-semibold mb-4 flex items-center gap-2">
                <Bot className="w-5 h-5 text-purple-500" /> AI Configuration (Edge Functions)
              </h3>
              <div className="space-y-4">
                <p className="text-xs text-slate-500">
                  AI keys are no longer stored in browser localStorage.
                  Configure <code>GEMINI_API_KEY</code> and <code>DEEPSEEK_API_KEY</code> in Supabase Edge Function secrets.
                </p>
                <div className="bg-blue-50 dark:bg-blue-900/20 p-4 rounded-lg border border-blue-200 dark:border-blue-800">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="w-5 h-5 text-blue-600 mt-0.5" />
                    <ul className="list-disc list-inside space-y-1 text-xs text-blue-900 dark:text-blue-200">
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
        )}

        {activeTab === 'logic' && (
          <AdminLogicControlCenter setView={(v) => navigate(`/${v === 'decision' ? 'plan' : v}`)} />
        )}

        {activeTab === 'data' && (
          <Card>
            <div className="text-center py-12">
              <Database className="w-12 h-12 text-slate-300 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-slate-600 dark:text-slate-400 mb-2">Data Import</h3>
              <p className="text-sm text-slate-500 mb-4">
                Data import and master data management will be available here in a future update.
              </p>
              <p className="text-xs text-slate-400">
                For now, upload data via the Plan Studio chat interface.
              </p>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
