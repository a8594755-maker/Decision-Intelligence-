import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Activity } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useApp } from '../contexts/AppContext';
import { APP_NAME, APP_TAGLINE } from '../config/branding';

export default function LoginPage() {
  const { session, loading, handleLogin, handleSignUp } = useAuth();
  const { darkMode } = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('viewer');
  const [submitting, setSubmitting] = useState(false);

  // Already authenticated — redirect to home
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

  return (
    <div className={`min-h-screen flex items-center justify-center p-4 transition-colors duration-300 ${darkMode ? 'bg-slate-900 text-white' : 'bg-slate-50 text-slate-900'}`}>
      <div className="max-w-md w-full bg-white dark:bg-slate-800 rounded-2xl shadow-xl p-8 border border-slate-200 dark:border-slate-700">
        <div className="flex justify-center mb-8">
          <div className="bg-blue-600 p-3 rounded-lg">
            <Activity className="w-8 h-8 text-white" />
          </div>
        </div>
        <h1 className="text-3xl font-bold text-center mb-2">{APP_NAME}</h1>
        <p className="text-center text-slate-500 dark:text-slate-400 mb-8">{APP_TAGLINE}</p>

        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Email</label>
            <input
              type="email"
              required
              className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Password</label>
            <input
              type="password"
              required
              className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
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
          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg font-medium transition-colors"
          >
            {submitting ? 'Processing...' : 'Log In'}
          </button>
          <button
            type="button"
            onClick={onSignUp}
            disabled={submitting}
            className="w-full bg-transparent border border-blue-600 text-blue-600 hover:bg-blue-50 py-2.5 rounded-lg font-medium transition-colors"
          >
            Sign Up
          </button>
        </form>
      </div>
    </div>
  );
}
