import React from 'react';
import { Menu, Plus, X } from 'lucide-react';

function HeaderActionButton({ label, icon, onClick, active = false, disabled = false }) {
  const Icon = icon;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition cursor-pointer ${
        active
          ? 'bg-[var(--brand-50)] text-[var(--brand-700)] border border-[var(--brand-500)]/30'
          : 'text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] hover:text-[var(--text-primary)]'
      } disabled:cursor-not-allowed disabled:opacity-50`}
    >
      <Icon className="h-4 w-4" />
      <span className="hidden lg:inline">{label}</span>
    </button>
  );
}

export default function AIEmployeeChatShell({
  title,
  subtitle,
  badge = null,
  sidebarOpen,
  onSidebarToggle,
  onDismissOverlays,
  onNewConversation,
  sidebar,
  thread,
  composer,
  secondaryPanel = null,
  sidePanel = null,
  actions = [],
}) {
  return (
    <div className="relative h-full overflow-hidden bg-[var(--surface-base)]">
      {/* Flex row: sidebar + main content */}
      <div className="flex h-full min-h-0">
        {/* ── Sidebar ── */}
        {sidebarOpen && (
          <aside
            data-testid="ai-employee-sidebar"
            className="w-[280px] flex-shrink-0 border-r border-[var(--border-default)] bg-[var(--surface-card)]"
          >
            {sidebar}
          </aside>
        )}

        {/* ── Main content area ── */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Header */}
          <header className="border-b border-[var(--border-default)] bg-[var(--surface-card)] px-4 py-3 sm:px-6">
            <div className="flex w-full items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <button
                  type="button"
                  aria-label="Toggle conversation history"
                  onClick={onSidebarToggle}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-secondary)] transition hover:bg-[var(--surface-subtle)] cursor-pointer"
                >
                  <Menu className="h-5 w-5" />
                </button>

                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-base font-semibold text-[var(--text-primary)]">{title}</h2>
                    {badge ? (
                      <span className="inline-flex rounded-md bg-[var(--brand-50)] text-[var(--brand-700)] px-2 py-0.5 text-[11px] font-medium border border-[var(--brand-200)]">
                        {badge}
                      </span>
                    ) : null}
                  </div>
                  {subtitle ? (
                    <p className="truncate text-xs text-[var(--text-muted)]">{subtitle}</p>
                  ) : null}
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={onNewConversation}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--brand-600)] px-3.5 py-2 text-sm font-medium text-white transition hover:bg-[var(--brand-700)] cursor-pointer"
                >
                  <Plus className="h-4 w-4" />
                  <span className="hidden sm:inline">New chat</span>
                </button>
                {actions.map((action) => (
                  <HeaderActionButton
                    key={action.key}
                    label={action.label}
                    icon={action.icon}
                    onClick={action.onClick}
                    active={action.active}
                    disabled={action.disabled}
                  />
                ))}
              </div>
            </div>
          </header>

          {/* Chat thread + composer */}
          <div className="flex min-h-0 flex-1 flex-col">
            {thread}
            {composer}
          </div>
        </div>

        {/* ── Side panel (inline, non-blocking — for thinking) ── */}
        {sidePanel ? (
          <aside className="w-[380px] flex-shrink-0 border-l border-[var(--border-default)] bg-[var(--surface-card)]">
            {sidePanel.content}
          </aside>
        ) : null}

        {/* ── Secondary panel (Profile/Steps/Artifacts drawer) ── */}
        {secondaryPanel ? (
          <>
            <button
              type="button"
              aria-label="Dismiss overlay"
              className="absolute inset-0 z-20 bg-black/20"
              onClick={onDismissOverlays}
            />
            <section
              data-testid="ai-employee-secondary-panel"
              className="absolute inset-y-0 right-0 z-30 flex w-[420px] max-w-full flex-col overflow-hidden border-l border-[var(--border-default)] bg-[var(--surface-card)] shadow-[var(--shadow-float)]"
            >
              {secondaryPanel.title ? (
                <div className="flex items-center justify-between border-b border-[var(--border-default)] px-5 py-3">
                  <div>
                    <div className="text-sm font-semibold text-[var(--text-primary)]">{secondaryPanel.title}</div>
                    {secondaryPanel.description ? (
                      <div className="mt-0.5 text-xs text-[var(--text-muted)]">{secondaryPanel.description}</div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    aria-label={`Close ${secondaryPanel.title}`}
                    onClick={secondaryPanel.onClose}
                    className="rounded-lg p-2 text-[var(--text-muted)] transition hover:bg-[var(--accent-hover)] cursor-pointer"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : null}
              <div className="min-h-0 flex-1 overflow-hidden">{secondaryPanel.content}</div>
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}
