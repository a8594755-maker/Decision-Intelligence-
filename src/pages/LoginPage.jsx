import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Activity } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { APP_NAME } from '../config/branding';

export default function LoginPage() {
  const { session, loading, handleLogin, handleSignUp } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('viewer');
  const [submitting, setSubmitting] = useState(false);

  if (!loading && session) return <Navigate to="/" replace />;

  const onSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    await handleLogin(email, password, role);
    setSubmitting(false);
  };

  const onSignUp = async () => {
    setSubmitting(true);
    await handleSignUp(email, password);
    setSubmitting(false);
  };

  const inputCls =
    'w-full px-4 py-2.5 rounded-lg bg-[var(--surface-subtle)] border border-[var(--border-default)] focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 outline-none transition-all text-[var(--text-primary)]';

  return (
    <div className="min-h-screen flex">
      {/* ── Left: brand panel (hidden < lg) ── */}
      <div
        className="hidden lg:flex w-[45%] flex-col justify-between p-12"
        style={{ background: 'linear-gradient(135deg, #1e1b4b 0%, #312e81 40%, #4338ca 100%)' }}
      >
        {/* Logo */}
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-white/15 rounded-lg flex items-center justify-center">
            <Activity className="w-5 h-5 text-white" />
          </div>
          <span className="text-white font-bold text-xl tracking-tight">{APP_NAME}</span>
        </div>

        {/* Hero copy */}
        <div>
          <h2 className="text-4xl font-bold text-white leading-tight mb-4">
            Make smarter calls,<br />faster.
          </h2>
          <p className="text-indigo-200 text-lg leading-relaxed">
            Supply-chain risk doesn't wait.<br />
            Decision Intelligence keeps you one step ahead.
          </p>
        </div>

        <p className="text-indigo-300/50 text-sm">&copy; 2026 Decision-Intelligence</p>
      </div>

      {/* ── Right: form ── */}
      <div
        className="flex-1 flex items-center justify-center p-8"
        style={{ backgroundColor: 'var(--surface-base)' }}
      >
        <div className="w-full max-w-sm">
          {/* Mobile logo (hidden >= lg) */}
          <div className="flex items-center gap-2.5 mb-10 lg:hidden">
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
              <Activity className="w-4.5 h-4.5 text-white" />
            </div>
            <span className="font-bold text-lg tracking-tight" style={{ color: 'var(--text-primary)' }}>
              {APP_NAME}
            </span>
          </div>

          <h1
            className="text-2xl font-bold mb-1.5"
            style={{ color: 'var(--text-primary)' }}
          >
            Welcome back
          </h1>
          <p className="text-sm mb-8" style={{ color: 'var(--text-secondary)' }}>
            Sign in to continue your decision workspace
          </p>

          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>
                Email
              </label>
              <input
                type="email"
                required
                className={inputCls}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>
                Password
              </label>
              <input
                type="password"
                required
                className={inputCls}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>
                Role
              </label>
              <p className="text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>
                Select the permission level for your session
              </p>
              <select value={role} onChange={(e) => setRole(e.target.value)} className={inputCls}>
                <option value="viewer">Viewer (Read-only)</option>
                <option value="logic_editor">Logic Editor (Edit)</option>
                <option value="logic_approver">Logic Approver (Approve)</option>
                <option value="logic_publisher">Logic Publisher (Publish)</option>
                <option value="admin">Admin (Full Access)</option>
              </select>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white py-2.5 rounded-lg font-medium transition-all shadow-[0_2px_8px_rgba(79,70,229,0.4)] disabled:opacity-50"
            >
              {submitting ? 'Processing...' : 'Log In'}
            </button>

            <button
              type="button"
              onClick={onSignUp}
              disabled={submitting}
              className="w-full border border-[var(--border-strong)] text-[var(--text-primary)] hover:bg-[var(--surface-subtle)] py-2.5 rounded-lg font-medium transition-all disabled:opacity-50"
            >
              Sign Up
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
