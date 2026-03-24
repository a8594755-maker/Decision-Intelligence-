import { AlertTriangle, AlertCircle, Info } from 'lucide-react';

const SEVERITY = {
  warning: { icon: AlertTriangle, bg: 'bg-amber-50 dark:bg-amber-950/30', border: 'border-amber-300 dark:border-amber-700', text: 'text-amber-800 dark:text-amber-200', iconColor: 'text-amber-500' },
  error:   { icon: AlertCircle,   bg: 'bg-red-50 dark:bg-red-950/30',     border: 'border-red-300 dark:border-red-700',     text: 'text-red-800 dark:text-red-200',     iconColor: 'text-red-500' },
  info:    { icon: Info,           bg: 'bg-blue-50 dark:bg-blue-950/30',   border: 'border-blue-300 dark:border-blue-700',   text: 'text-blue-800 dark:text-blue-200',   iconColor: 'text-blue-500' },
};

export default function AlertBlock({ severity = 'warning', title, description, loading }) {
  if (loading) {
    return (
      <div className="h-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 animate-pulse">
        <div className="h-4 w-40 bg-slate-200 dark:bg-slate-700 rounded mb-2" />
        <div className="h-3 w-full bg-slate-100 dark:bg-slate-800 rounded" />
      </div>
    );
  }

  const s = SEVERITY[severity] || SEVERITY.warning;
  const Icon = s.icon;

  return (
    <div className={`h-full rounded-xl border ${s.border} ${s.bg} p-4 flex gap-3`}>
      <Icon className={`w-5 h-5 shrink-0 mt-0.5 ${s.iconColor}`} />
      <div>
        {title && <h4 className={`text-sm font-semibold ${s.text} mb-1`}>{title}</h4>}
        {description && <p className={`text-xs ${s.text} opacity-80 leading-relaxed`}>{description}</p>}
      </div>
    </div>
  );
}
