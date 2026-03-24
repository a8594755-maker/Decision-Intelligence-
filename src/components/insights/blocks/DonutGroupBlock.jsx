import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';

const COLORS = ['#0891b2', '#2563eb', '#059669', '#d97706', '#dc2626', '#7c3aed', '#db2777'];

function MiniDonut({ data, label, centerValue }) {
  return (
    <div className="flex flex-col items-center">
      <div className="w-24 h-24 relative">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%" cy="50%"
              innerRadius={28} outerRadius={40}
              dataKey="value"
              stroke="none"
            >
              {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Pie>
            <Tooltip formatter={(v) => `${v}`} />
          </PieChart>
        </ResponsiveContainer>
        {centerValue != null && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-sm font-bold text-slate-800 dark:text-white">{centerValue}</span>
          </div>
        )}
      </div>
      {label && <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 text-center">{label}</p>}
    </div>
  );
}

export default function DonutGroupBlock({ title, donuts = [], loading }) {
  if (loading) {
    return (
      <div className="h-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 animate-pulse">
        <div className="h-4 w-40 bg-slate-200 dark:bg-slate-700 rounded mb-4" />
        <div className="flex gap-6 justify-center">
          {[1, 2, 3].map((i) => <div key={i} className="w-24 h-24 rounded-full bg-slate-200 dark:bg-slate-700" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
      {title && <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3 text-center">{title}</h4>}
      <div className="flex flex-wrap gap-4 justify-center items-end">
        {donuts.map((d, i) => (
          <MiniDonut key={i} data={d.data || []} label={d.label} centerValue={d.centerValue} />
        ))}
      </div>
    </div>
  );
}
