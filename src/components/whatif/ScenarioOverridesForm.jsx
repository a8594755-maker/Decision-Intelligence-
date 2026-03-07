/**
 * ScenarioOverridesForm
 *
 * Sliders and toggles for the 9 supported What-If overrides.
 * All values default to null (= "use base config").
 */

import React from 'react';

const OVERRIDE_DEFAULTS = {
  budget_cap: null,
  service_target: null,
  stockout_penalty_multiplier: null,
  holding_cost_multiplier: null,
  safety_stock_alpha: null,
  risk_mode: null,
  expedite_mode: null,
  expedite_cost_per_unit: null,
  lead_time_buffer_days: null
};

// eslint-disable-next-line react-refresh/only-export-components
export function getDefaultOverrides() {
  return { ...OVERRIDE_DEFAULTS };
}

function SliderRow({ label, hint, min, max, step, value, onChange, displayFn }) {
  const isActive = value !== null && value !== undefined;
  const display = isActive ? (displayFn ? displayFn(value) : String(value)) : 'base';

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs font-medium text-slate-700 dark:text-slate-300">{label}</label>
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-blue-600 dark:text-blue-400 min-w-[48px] text-right">
            {display}
          </span>
          {isActive && (
            <button
              type="button"
              onClick={() => onChange(null)}
              className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              title="Reset to base"
            >
              ×
            </button>
          )}
        </div>
      </div>
      {hint && <p className="text-xs text-slate-400 dark:text-slate-500 mb-1">{hint}</p>}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={isActive ? value : (min + max) / 2}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1.5 appearance-none rounded-full bg-slate-200 dark:bg-slate-700 accent-blue-600 cursor-pointer"
      />
      <div className="flex justify-between text-xs text-slate-400 mt-0.5">
        <span>{displayFn ? displayFn(min) : min}</span>
        <span>{displayFn ? displayFn(max) : max}</span>
      </div>
    </div>
  );
}

function ToggleRow({ label, hint, value, onChange }) {
  const isOn = value === 'on';
  const isOff = value === 'off';
  const isBase = !isOn && !isOff;

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between">
        <div>
          <label className="text-xs font-medium text-slate-700 dark:text-slate-300">{label}</label>
          {hint && <p className="text-xs text-slate-400 dark:text-slate-500">{hint}</p>}
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden text-xs">
          {['base', 'off', 'on'].map((opt) => {
            const active = opt === 'base' ? isBase : value === opt;
            return (
              <button
                key={opt}
                type="button"
                onClick={() => onChange(opt === 'base' ? null : opt)}
                className={`px-2 py-1 font-medium transition-colors ${
                  active
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                {opt}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function NumberInputRow({ label, hint, placeholder, value, onChange, min = 0 }) {
  const isActive = value !== null && value !== undefined;

  return (
    <div className="mb-3">
      <label className="text-xs font-medium text-slate-700 dark:text-slate-300">{label}</label>
      {hint && <p className="text-xs text-slate-400 dark:text-slate-500 mb-1">{hint}</p>}
      <div className="flex items-center gap-2 mt-1">
        <input
          type="number"
          min={min}
          step="any"
          placeholder={placeholder || 'base'}
          value={isActive ? value : ''}
          onChange={(e) => {
            const v = e.target.value;
            onChange(v === '' ? null : Number(v));
          }}
          className="w-full px-2 py-1 text-xs rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:border-blue-500"
        />
        {isActive && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 whitespace-nowrap"
          >
            reset
          </button>
        )}
      </div>
    </div>
  );
}

export default function ScenarioOverridesForm({ overrides, onChange, disabled }) {
  const set = (key) => (value) => onChange({ ...overrides, [key]: value });

  const expediteOn = overrides.expedite_mode === 'on';

  return (
    <div className={`space-y-0 ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
      {/* Budget */}
      <div className="border-b border-slate-100 dark:border-slate-700/50 pb-3 mb-3">
        <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">
          Cost Controls
        </p>
        <NumberInputRow
          label="Budget Cap"
          hint="Hard cap on total order spend (same currency as unit_cost)"
          placeholder="no cap"
          value={overrides.budget_cap}
          onChange={set('budget_cap')}
        />
      </div>

      {/* Service */}
      <div className="border-b border-slate-100 dark:border-slate-700/50 pb-3 mb-3">
        <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">
          Service Level
        </p>
        <SliderRow
          label="Service Target"
          hint="Target fill rate (0.90–0.99). Applied as a penalty on backorders."
          min={0.80}
          max={0.99}
          step={0.01}
          value={overrides.service_target}
          onChange={set('service_target')}
          displayFn={(v) => `${(v * 100).toFixed(0)}%`}
        />
        <SliderRow
          label="Stockout Penalty ×"
          hint="Multiply base stockout penalty. >1 = prioritize availability."
          min={0.5}
          max={5.0}
          step={0.1}
          value={overrides.stockout_penalty_multiplier}
          onChange={set('stockout_penalty_multiplier')}
          displayFn={(v) => `×${v.toFixed(1)}`}
        />
        <SliderRow
          label="Holding Cost ×"
          hint="Multiply base holding cost. >1 = penalize excess inventory."
          min={0.5}
          max={5.0}
          step={0.1}
          value={overrides.holding_cost_multiplier}
          onChange={set('holding_cost_multiplier')}
          displayFn={(v) => `×${v.toFixed(1)}`}
        />
      </div>

      {/* Demand uncertainty */}
      <div className="border-b border-slate-100 dark:border-slate-700/50 pb-3 mb-3">
        <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">
          Demand Uncertainty
        </p>
        <SliderRow
          label="Safety-Stock α"
          hint="demand_eff = p50 + α × max(0, p90−p50). 0 = base p50; 1 = full p90."
          min={0}
          max={1}
          step={0.05}
          value={overrides.safety_stock_alpha}
          onChange={set('safety_stock_alpha')}
          displayFn={(v) => v.toFixed(2)}
        />
      </div>

      {/* Modes */}
      <div className="border-b border-slate-100 dark:border-slate-700/50 pb-3 mb-3">
        <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">
          Solver Modes
        </p>
        <ToggleRow
          label="Risk Mode"
          hint="ON: boosts stockout penalty ×1.5 (applied before multiplier)"
          value={overrides.risk_mode}
          onChange={set('risk_mode')}
        />
        <ToggleRow
          label="Expedite Mode"
          hint="ON: reduces lead time by buffer days, adds expedite cost"
          value={overrides.expedite_mode}
          onChange={set('expedite_mode')}
        />
        {expediteOn && (
          <div className="pl-3 border-l-2 border-blue-200 dark:border-blue-800 mt-2">
            <SliderRow
              label="Lead-Time Buffer (days)"
              hint="Days to subtract from lead time when expediting"
              min={1}
              max={14}
              step={1}
              value={overrides.lead_time_buffer_days ?? 3}
              onChange={set('lead_time_buffer_days')}
              displayFn={(v) => `${v}d`}
            />
            <NumberInputRow
              label="Expedite Cost / Unit"
              hint="Extra cost added per unit when lead time is reduced"
              placeholder="0"
              value={overrides.expedite_cost_per_unit}
              onChange={set('expedite_cost_per_unit')}
            />
          </div>
        )}
      </div>
    </div>
  );
}
