import { useState } from 'react';
import { NavLink as RouterNavLink } from 'react-router-dom';
import {
  Activity, LayoutDashboard, Calculator, TrendingUp,
  ShieldAlert, Settings, Moon, Sun, LogOut, Cpu,
  ChevronsLeft, ChevronsRight, GitCompare, BarChart3,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useApp } from '../../contexts/AppContext';
import { APP_NAME } from '../../config/branding';

const NAV_ITEMS = [
  { to: '/',           label: 'Command Center',  icon: LayoutDashboard, end: true },
  { to: '/plan',       label: 'Plan Studio',     icon: Calculator },
  { to: '/forecast',   label: 'Forecast Studio', icon: TrendingUp },
  { to: '/risk',       label: 'Risk Center',     icon: ShieldAlert },
  { to: '/digital-twin', label: 'Digital Twin',  icon: Cpu },
  { to: '/scenarios',    label: 'Scenarios',      icon: GitCompare },
];

const BOTTOM_ITEMS = [
  { to: '/ops', label: 'Ops Dashboard', icon: BarChart3 },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export default function Sidebar() {
  const { user, handleLogout } = useAuth();
  const { darkMode, setDarkMode } = useApp();
  const [expanded, setExpanded] = useState(false);

  const width = expanded ? 'w-52' : 'w-14';

  return (
    <aside
      className={`${width} flex-shrink-0 h-screen flex flex-col transition-all duration-200 ease-out border-r`}
      style={{
        backgroundColor: 'var(--surface-card)',
        borderColor: 'var(--border-default)',
      }}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
    >
      {/* ── Brand ── */}
      <div className="h-14 flex items-center px-3.5 gap-2.5 flex-shrink-0">
        <div className="w-7 h-7 bg-indigo-600 rounded-lg flex items-center justify-center flex-shrink-0">
          <Activity className="w-4 h-4 text-white" />
        </div>
        <span
          className={`font-bold text-sm tracking-tight whitespace-nowrap overflow-hidden transition-all duration-200 ${
            expanded ? 'opacity-100 w-auto' : 'opacity-0 w-0'
          }`}
          style={{ color: 'var(--text-primary)' }}
        >
          {APP_NAME}
        </span>
      </div>

      {/* ── Main nav ── */}
      <nav className="flex-1 flex flex-col gap-0.5 px-2 pt-2 overflow-y-auto overflow-x-hidden">
        {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
          <SidebarLink
            key={to}
            to={to}
            label={label}
            icon={Icon}
            end={end}
            expanded={expanded}
          />
        ))}
      </nav>

      {/* ── Bottom section ── */}
      <div className="flex flex-col gap-0.5 px-2 pb-2 border-t" style={{ borderColor: 'var(--border-default)' }}>
        {/* Settings */}
        {BOTTOM_ITEMS.map(({ to, label, icon: Icon }) => (
          <SidebarLink key={to} to={to} label={label} icon={Icon} expanded={expanded} />
        ))}

        {/* Theme toggle */}
        <button
          onClick={() => setDarkMode(!darkMode)}
          className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm transition-colors hover:bg-[var(--surface-subtle)]"
          style={{ color: 'var(--text-secondary)' }}
          title={darkMode ? 'Light mode' : 'Dark mode'}
        >
          <span className="w-5 h-5 flex items-center justify-center flex-shrink-0">
            {darkMode ? <Sun className="w-[18px] h-[18px]" /> : <Moon className="w-[18px] h-[18px]" />}
          </span>
          <span
            className={`whitespace-nowrap overflow-hidden transition-all duration-200 ${
              expanded ? 'opacity-100 w-auto' : 'opacity-0 w-0'
            }`}
          >
            {darkMode ? 'Light mode' : 'Dark mode'}
          </span>
        </button>

        {/* User + logout */}
        <div className="flex items-center gap-2.5 px-2.5 py-2">
          <div
            className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 text-[10px] font-bold text-white bg-indigo-600"
          >
            {user?.email?.[0]?.toUpperCase() || '?'}
          </div>
          <span
            className={`text-sm truncate flex-1 whitespace-nowrap overflow-hidden transition-all duration-200 ${
              expanded ? 'opacity-100 w-auto' : 'opacity-0 w-0'
            }`}
            style={{ color: 'var(--text-secondary)' }}
          >
            {user?.email?.split('@')[0]}
          </span>
          {expanded && (
            <button
              onClick={handleLogout}
              className="p-1 rounded-md hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500 transition-colors"
              title="Log out"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Collapse toggle */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center justify-center p-1.5 rounded-lg transition-colors hover:bg-[var(--surface-subtle)]"
          style={{ color: 'var(--text-muted)' }}
          title={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? <ChevronsLeft className="w-4 h-4" /> : <ChevronsRight className="w-4 h-4" />}
        </button>
      </div>
    </aside>
  );
}

/* ── Sidebar link item ── */
// eslint-disable-next-line no-unused-vars -- Icon is used in JSX below; ESLint false positive on destructured rename
function SidebarLink({ to, label, icon: Icon, end, expanded }) {
  return (
    <RouterNavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        [
          'group relative flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm font-medium transition-colors',
          isActive
            ? 'bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400'
            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-subtle)]',
        ].join(' ')
      }
    >
      {({ isActive }) => (
        <>
          {/* Active accent bar */}
          {isActive && (
            <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-indigo-600 dark:bg-indigo-400" />
          )}
          <span className="w-5 h-5 flex items-center justify-center flex-shrink-0">
            <Icon className="w-[18px] h-[18px]" />
          </span>
          <span
            className={`whitespace-nowrap overflow-hidden transition-all duration-200 ${
              expanded ? 'opacity-100 w-auto' : 'opacity-0 w-0'
            }`}
          >
            {label}
          </span>
        </>
      )}
    </RouterNavLink>
  );
}
