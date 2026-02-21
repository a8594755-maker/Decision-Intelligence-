import { NavLink as RouterNavLink } from 'react-router-dom';
import {
  Activity, LayoutDashboard, Calculator, TrendingUp,
  ShieldAlert, Settings, Moon, Sun, LogOut,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useApp } from '../../contexts/AppContext';
import { APP_NAME } from '../../config/branding';

const NAV_ITEMS = [
  { to: '/',         label: 'Command Center',  icon: LayoutDashboard, end: true },
  { to: '/plan',     label: 'Plan Studio',     icon: Calculator },
  { to: '/forecast', label: 'Forecast Studio',  icon: TrendingUp },
  { to: '/risk',     label: 'Risk Center',      icon: ShieldAlert },
  { to: '/settings', label: 'Settings',         icon: Settings },
];

const linkBase =
  'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap';
const linkInactive =
  'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-700/50';
const linkActive =
  'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30';

export default function TopNavBar() {
  const { user, handleLogout } = useAuth();
  const { darkMode, setDarkMode } = useApp();

  return (
    <header className="flex-shrink-0 z-40 bg-white/80 dark:bg-slate-800/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-700">
      <div className="w-full px-4 md:px-6 h-14 flex items-center justify-between">
        {/* Left: branding */}
        <RouterNavLink to="/" className="flex items-center gap-2 mr-6">
          <div className="bg-blue-600 p-1.5 rounded-lg">
            <Activity className="w-5 h-5 text-white" />
          </div>
          <span className="text-lg font-bold hidden sm:inline">{APP_NAME}</span>
        </RouterNavLink>

        {/* Center: nav links */}
        <nav className="flex items-center gap-1 overflow-x-auto scrollbar-hide">
          {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
            <RouterNavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `${linkBase} ${isActive ? linkActive : linkInactive}`
              }
            >
              <Icon className="w-4 h-4" />
              <span className="hidden md:inline">{label}</span>
            </RouterNavLink>
          ))}
        </nav>

        {/* Right: user actions */}
        <div className="flex items-center gap-2 ml-4">
          <button
            onClick={() => setDarkMode(!darkMode)}
            className="p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-full"
            title={darkMode ? 'Light mode' : 'Dark mode'}
          >
            {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
          <span className="text-sm font-medium hidden lg:inline text-slate-600 dark:text-slate-300">
            {user?.email?.split('@')[0]}
          </span>
          <button
            onClick={handleLogout}
            className="p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-full"
            title="Log out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </header>
  );
}
