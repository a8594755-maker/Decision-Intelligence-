import { useState } from 'react';
import { NavLink as RouterNavLink, useNavigate, useLocation } from 'react-router-dom';
import {
  Activity, MessageSquare, ClipboardList, CheckSquare, LayoutDashboard,
  Settings, Moon, Sun, LogOut,
  ChevronsLeft, ChevronsRight, BarChart3, Database, Bot, Wrench, FileText, Users,
  ChevronDown, Calculator, TrendingUp, ShieldAlert, Cpu, GitCompare, Handshake,
  ArrowLeftRight, Shield, Webhook, Clock, Layers, Inbox, PanelTop,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useApp } from '../../contexts/AppContext';
import { APP_NAME } from '../../config/branding';

// ────────────────────────────────────────────────────────────
// DI Workspace nav
// ────────────────────────────────────────────────────────────
const DI_NAV_ITEMS = [
  { to: '/workspace',     label: 'Workspace',       icon: PanelTop },
  { to: '/',              label: 'Command Center',  icon: LayoutDashboard, end: true },
  { to: '/forecast',      label: 'Forecast Studio', icon: TrendingUp },
  { to: '/risk',           label: 'Risk Center',     icon: ShieldAlert },
  { to: '/digital-twin',  label: 'Digital Twin',    icon: Cpu },
  { to: '/scenarios',     label: 'Scenarios',       icon: GitCompare },
  { to: '/negotiation',   label: 'Negotiation',     icon: Handshake },
  { to: '/insights',      label: 'Insights Hub',    icon: BarChart3 },
];

const DI_ADVANCED_ITEMS = [
  { to: '/employees',           label: 'Digital Worker',    icon: Bot },
  { to: '/employees/tasks',     label: 'Tasks',             icon: ClipboardList },
  { to: '/employees/review',    label: 'Review',            icon: CheckSquare },
  { to: '/employees/tools',     label: 'Tool Library',      icon: Wrench },
  { to: '/employees/profiles',  label: 'Output Profiles',   icon: FileText },
  { to: '/employees/templates', label: 'Templates',         icon: Layers },
  { to: '/employees/policies',  label: 'Governance',        icon: Shield },
  { to: '/employees/approvals', label: 'Approvals',         icon: Inbox },
  { to: '/employees/webhooks',  label: 'Webhooks',          icon: Webhook },
  { to: '/employees/schedules', label: 'Schedules',         icon: Clock },
];

// ────────────────────────────────────────────────────────────
// Digital Worker Workspace nav
// ────────────────────────────────────────────────────────────
const AI_NAV_ITEMS = [
  { to: '/workspace',           label: 'Workspace',      icon: PanelTop },
  { to: '/employees/tasks',     label: 'Task Board',     icon: ClipboardList },
  { to: '/employees/review',    label: 'Review',         icon: CheckSquare },
  { to: '/employees/approvals', label: 'Approvals',      icon: Inbox },
  { to: '/',                    label: 'Dashboard',      icon: Bot, end: true },
  { to: '/employees',           label: 'Workers',        icon: Users },
  { to: '/employees/profiles',  label: 'Profiles',       icon: FileText },
  { to: '/insights',             label: 'Insights Hub',   icon: LayoutDashboard },
];

const AI_ADVANCED_ITEMS = [
  { to: '/employees/templates', label: 'Templates',      icon: Layers },
  { to: '/employees/policies',  label: 'Governance',     icon: Shield },
  { to: '/employees/webhooks',  label: 'Webhooks',       icon: Webhook },
  { to: '/employees/schedules', label: 'Schedules',      icon: Clock },
  { to: '/employees/tools',     label: 'Tool Library',   icon: Wrench },
  { to: '/forecast',      label: 'Forecast Studio', icon: TrendingUp },
  { to: '/risk',           label: 'Risk Center',     icon: ShieldAlert },
  { to: '/digital-twin',  label: 'Digital Twin',     icon: Cpu },
  { to: '/scenarios',     label: 'Scenarios',         icon: GitCompare },
  { to: '/negotiation',   label: 'Negotiation',       icon: Handshake },
];

// ────────────────────────────────────────────────────────────
const BOTTOM_ITEMS = [
  { to: '/sandbox', label: 'ERP Sandbox', icon: Database },
  { to: '/ops', label: 'Ops Dashboard', icon: BarChart3 },
  { to: '/settings', label: 'Settings', icon: Settings },
];

const WS_META = {
  di:          { label: 'Decision Intelligence', short: 'DI', icon: LayoutDashboard, color: 'text-blue-600' },
  ai_employee: { label: 'Digital Worker',        short: 'DW', icon: Bot,              color: 'text-[var(--brand-600)]' },
};

export default function Sidebar() {
  const { user, handleLogout } = useAuth();
  const { darkMode, setDarkMode, activeWorkspace, setActiveWorkspace } = useApp();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const width = expanded ? 'w-52' : 'w-14';
  const isAI = activeWorkspace === 'ai_employee';
  const navItems = isAI ? AI_NAV_ITEMS : DI_NAV_ITEMS;
  const advancedItems = isAI ? AI_ADVANCED_ITEMS : DI_ADVANCED_ITEMS;
  const _currentWs = WS_META[activeWorkspace] || WS_META.ai_employee;
  const otherWs = isAI ? WS_META.di : WS_META.ai_employee;

  function switchWorkspace() {
    const next = isAI ? 'di' : 'ai_employee';
    setActiveWorkspace(next);
    navigate('/');
    setAdvancedOpen(false);
  }

  return (
    <aside
      className={`${width} flex-shrink-0 h-screen flex flex-col transition-all duration-200 ease-out border-r`}
      style={{
        backgroundColor: 'var(--surface-card)',
        borderColor: 'var(--border-default)',
      }}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => { setExpanded(false); setAdvancedOpen(false); }}
    >
      {/* ── Brand ── */}
      <div className="h-14 flex items-center px-3.5 gap-2.5 flex-shrink-0">
        <div className="w-7 h-7 bg-[var(--brand-600)] rounded-lg flex items-center justify-center flex-shrink-0">
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

      {/* ── Primary nav ── */}
      <nav className="flex-1 flex flex-col gap-0.5 px-2 pt-2 overflow-y-auto overflow-x-hidden">
        {navItems.map(({ to, label, icon: Icon, end }) => (
          <SidebarLink key={to} to={to} label={label} icon={Icon} end={end} expanded={expanded} />
        ))}

        {/* ── Advanced tools (collapsible) ── */}
        {expanded && (
          <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--border-default)' }}>
            <button
              onClick={() => setAdvancedOpen(!advancedOpen)}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors hover:bg-[var(--surface-subtle)]"
              style={{ color: 'var(--text-muted)' }}
            >
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${advancedOpen ? '' : '-rotate-90'}`} />
              {isAI ? 'Advanced Tools' : 'Digital Worker'}
            </button>
            {advancedOpen && (
              <div className="flex flex-col gap-0.5 mt-0.5">
                {advancedItems.map(({ to, label, icon: Icon }) => (
                  <SidebarLink key={to} to={to} label={label} icon={Icon} expanded={expanded} />
                ))}
              </div>
            )}
          </div>
        )}
      </nav>

      {/* ── Bottom section ── */}
      <div className="flex flex-col gap-0.5 px-2 pb-2 border-t" style={{ borderColor: 'var(--border-default)' }}>

        {/* Workspace switcher */}
        <button
          onClick={switchWorkspace}
          className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm transition-colors hover:bg-[var(--surface-subtle)]"
          style={{ color: 'var(--text-secondary)' }}
          title={`Switch to ${otherWs.label}`}
        >
          <span className="w-5 h-5 flex items-center justify-center flex-shrink-0">
            <ArrowLeftRight className="w-[18px] h-[18px]" />
          </span>
          <span
            className={`whitespace-nowrap overflow-hidden transition-all duration-200 ${
              expanded ? 'opacity-100 w-auto' : 'opacity-0 w-0'
            }`}
          >
            {otherWs.short} Mode
          </span>
        </button>

        {/* Settings & other bottom items */}
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
            className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 text-[10px] font-bold text-white bg-[var(--brand-600)]"
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
  const location = useLocation();

  // Custom active matching: for links with query params (e.g. /workspace?widget=risk),
  // check both pathname AND query string match, since NavLink only matches on pathname.
  const hasQuery = to.includes('?');
  let isActiveCustom;
  if (hasQuery) {
    const [linkPath, linkSearch] = to.split('?');
    const linkParams = new URLSearchParams(linkSearch);
    const currentParams = new URLSearchParams(location.search);
    isActiveCustom = location.pathname === linkPath
      && [...linkParams.entries()].every(([k, v]) => currentParams.get(k) === v);
  }

  return (
    <RouterNavLink
      to={to}
      end={end}
      className={({ isActive: routerActive }) => {
        const active = hasQuery ? isActiveCustom : routerActive;
        return [
          'group relative flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm font-medium transition-colors',
          active
            ? 'bg-[var(--brand-50)] text-[var(--brand-600)]'
            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-subtle)]',
        ].join(' ');
      }}
    >
      {({ isActive: routerActive }) => {
        const active = hasQuery ? isActiveCustom : routerActive;
        return (
          <>
            {active && (
              <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-[var(--brand-600)]" />
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
        );
      }}
    </RouterNavLink>
  );
}
