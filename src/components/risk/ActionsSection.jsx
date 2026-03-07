/**
 * Actions Section - Recommended actions list for DetailsPanel
 * Shows per-row recommended actions with feasibility, impact, and evidence.
 */

import React from 'react';
import { Zap, Truck, Users, Shield, BarChart3, Upload } from 'lucide-react';
import { formatCurrency } from '../../domains/risk/profitAtRiskCalculator';

const ACTION_ICONS = {
  expedite: Zap,
  transfer_stock: Truck,
  change_supplier: Users,
  increase_safety_stock: Shield,
  review_demand: BarChart3,
  upload_missing_data: Upload,
};

const FEASIBILITY_COLORS = {
  high: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  low: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
};

const ActionsSection = ({ actions = [], decisionRankingScore }) => {
  if (actions.length === 0) return null;

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Zap className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
        <h4 className="font-semibold text-slate-700 dark:text-slate-300 flex-1">
          Recommended Actions
        </h4>
        {decisionRankingScore != null && (
          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
            decisionRankingScore > 0.7 ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' :
            decisionRankingScore > 0.4 ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' :
            'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300'
          }`}>
            Priority: {decisionRankingScore.toFixed(2)}
          </span>
        )}
      </div>
      <div className="space-y-2">
        {actions.map((action, idx) => {
          const Icon = ACTION_ICONS[action.type] || Zap;
          return (
            <div key={action.type} className={`bg-slate-50 dark:bg-slate-900/50 rounded-lg p-3 ${idx === 0 ? 'border-2 border-indigo-200 dark:border-indigo-800' : 'border border-slate-200 dark:border-slate-700'}`}>
              <div className="flex items-start gap-2">
                <Icon className="w-4 h-4 text-indigo-600 dark:text-indigo-400 mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                      {idx === 0 && '\u2605 '}{action.title}
                    </span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${FEASIBILITY_COLORS[action.feasibility] || ''}`}>
                      {action.feasibility}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {action.description}
                  </div>
                  {action.expected_impact_usd > 0 && (
                    <div className="text-xs text-green-600 dark:text-green-400 mt-1 font-medium">
                      Est. savings: {formatCurrency(action.expected_impact_usd)}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ActionsSection;
