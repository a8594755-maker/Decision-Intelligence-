// ============================================
// AI Employee Home — Chat-first Agent-as-UI homepage
// Main screen = DecisionSupportView + optional Employee Profile panel
// ============================================

import { useState, useCallback } from 'react';
import { Bot, X, ChevronRight } from 'lucide-react';
import DecisionSupportView from '../views/DecisionSupportView';
import EmployeeProfilePanel from '../components/ai-employee/EmployeeProfilePanel';
import { useAuth } from '../contexts/AuthContext';

export default function AIEmployeeHome() {
  const { user, addNotification } = useAuth();
  const [profileOpen, setProfileOpen] = useState(false);

  const toggleProfile = useCallback(() => setProfileOpen((p) => !p), []);

  return (
    <div className="h-full flex relative overflow-hidden">
      {/* ── Main: Chat workspace ── */}
      <div className="flex-1 min-w-0 h-full flex flex-col">
        <DecisionSupportView user={user} addNotification={addNotification} mode="ai_employee" />
      </div>

      {/* ── Toggle button (fixed edge) ── */}
      {!profileOpen && (
        <button
          onClick={toggleProfile}
          className="absolute right-0 top-1/2 -translate-y-1/2 z-20 flex items-center gap-1 pl-2 pr-1.5 py-3 rounded-l-xl border border-r-0 shadow-lg transition-all hover:pr-3"
          style={{
            backgroundColor: 'var(--surface-card)',
            borderColor: 'var(--border-default)',
            color: 'var(--text-secondary)',
          }}
          title="Open Aiden Profile"
        >
          <Bot className="w-4 h-4 text-indigo-500" />
          <ChevronRight className="w-3 h-3 rotate-180" />
        </button>
      )}

      {/* ── Right panel: Employee Profile ── */}
      {profileOpen && (
        <aside
          className="w-80 flex-shrink-0 h-full border-l flex flex-col overflow-hidden animate-slide-in-right"
          style={{
            backgroundColor: 'var(--surface-card)',
            borderColor: 'var(--border-default)',
          }}
        >
          <div className="flex items-center justify-between px-4 h-12 border-b flex-shrink-0" style={{ borderColor: 'var(--border-default)' }}>
            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              AI Employee
            </span>
            <button
              onClick={toggleProfile}
              className="p-1 rounded-md hover:bg-[var(--surface-subtle)] transition-colors"
              style={{ color: 'var(--text-muted)' }}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            <EmployeeProfilePanel userId={user?.id} />
          </div>
        </aside>
      )}
    </div>
  );
}
