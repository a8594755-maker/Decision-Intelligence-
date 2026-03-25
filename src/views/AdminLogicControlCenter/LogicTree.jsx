// ============================================
// Logic Tree Component
// Sidebar navigation for logic types and scopes
// ============================================

import { useState, useEffect } from 'react';
import { supabase } from '../../services/infra/supabaseClient';
import { getStatusColor, getStatusText } from '../../services/governance/logicVersionService';

export default function LogicTree({ 
  selectedLogic, 
  selectedScope, 
  onSelectLogic, 
  onSelectScope,
  versions 
}) {
  const [plants, setPlants] = useState([]);
  const [expanded, setExpanded] = useState({ bom_explosion: true });

  async function loadPlants() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('accessible_plants')
      .eq('user_id', user.id)
      .single();

    if (profile?.accessible_plants) {
      setPlants(profile.accessible_plants.filter(p => p !== '*'));
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load on mount
    loadPlants();
  }, []);

  function toggleExpand(logicId) {
    setExpanded(prev => ({
      ...prev,
      [logicId]: !prev[logicId]
    }));
  }

  function getVersionStatus(logicId, scopeLevel, scopeId) {
    const version = versions.find(v => 
      v.logic_id === logicId && 
      v.scope_level === scopeLevel && 
      (v.scope_id === scopeId || (!v.scope_id && !scopeId))
    );
    return version?.status || null;
  }

  const LOGIC_TYPES = [
    { id: 'bom_explosion', name: 'BOM Explosion', icon: '📋' },
    { id: 'risk_score', name: 'Risk Score', icon: '⚠️' },
    { id: 'simulation', name: 'Simulation', icon: '🔮' },
  ];

  return (
    <div className="bg-white rounded-lg shadow">
      <div className="p-4 border-b border-gray-200">
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wider">
          Logic Types
        </h2>
      </div>
      
      <div className="divide-y divide-gray-200">
        {LOGIC_TYPES.map((logic) => (
          <div key={logic.id}>
            <button
              onClick={() => !logic.disabled && toggleExpand(logic.id)}
              disabled={logic.disabled}
              className={`
                w-full flex items-center justify-between px-4 py-3 text-left
                ${logic.disabled 
                  ? 'opacity-50 cursor-not-allowed' 
                  : 'hover:bg-gray-50 cursor-pointer'
                }
                ${selectedLogic === logic.id && !logic.disabled ? 'bg-indigo-50' : ''}
              `}
            >
              <div className="flex items-center">
                <span className="mr-2">{logic.icon}</span>
                <span className={`font-medium ${selectedLogic === logic.id ? 'text-indigo-900' : 'text-gray-700'}`}>
                  {logic.name}
                </span>
                {logic.disabled && (
                  <span className="ml-2 text-xs text-gray-400">(Coming Soon)</span>
                )}
              </div>
              {!logic.disabled && (
                <svg
                  className={`w-4 h-4 text-gray-400 transform transition-transform ${
                    expanded[logic.id] ? 'rotate-90' : ''
                  }`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              )}
            </button>

            {/* Scope levels */}
            {expanded[logic.id] && !logic.disabled && (
              <div className="bg-gray-50">
                {/* Global Scope */}
                <button
                  onClick={() => {
                    onSelectLogic(logic.id);
                    onSelectScope('GLOBAL', null);
                  }}
                  className={`
                    w-full flex items-center justify-between px-8 py-2 text-left text-sm
                    hover:bg-gray-100
                    ${selectedLogic === logic.id && selectedScope.level === 'GLOBAL' 
                      ? 'bg-indigo-100 text-indigo-900' 
                      : 'text-gray-600'
                    }
                  `}
                >
                  <span>🌍 Global</span>
                  {(() => {
                    const status = getVersionStatus(logic.id, 'GLOBAL', null);
                    if (status) {
                      return (
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${getStatusColor(status)}`}>
                          {getStatusText(status)}
                        </span>
                      );
                    }
                    return null;
                  })()}
                </button>

                {/* Plant Scopes */}
                {plants.map((plantId) => (
                  <button
                    key={plantId}
                    onClick={() => {
                      onSelectLogic(logic.id);
                      onSelectScope('PLANT', plantId);
                    }}
                    className={`
                      w-full flex items-center justify-between px-8 py-2 text-left text-sm
                      hover:bg-gray-100
                      ${selectedLogic === logic.id && selectedScope.level === 'PLANT' && selectedScope.id === plantId
                        ? 'bg-indigo-100 text-indigo-900' 
                        : 'text-gray-600'
                      }
                    `}
                  >
                    <span>🏭 {plantId}</span>
                    {(() => {
                      const status = getVersionStatus(logic.id, 'PLANT', plantId);
                      if (status) {
                        return (
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${getStatusColor(status)}`}>
                            {getStatusText(status)}
                          </span>
                        );
                      }
                      return null;
                    })()}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="p-4 border-t border-gray-200 text-xs text-gray-500">
        <p className="font-medium mb-2">Status Legend:</p>
        <div className="space-y-1">
          <div className="flex items-center">
            <span className="inline-block w-2 h-2 rounded-full bg-green-500 mr-2"></span>
            Published - Active
          </div>
          <div className="flex items-center">
            <span className="inline-block w-2 h-2 rounded-full bg-yellow-500 mr-2"></span>
            Pending Approval
          </div>
          <div className="flex items-center">
            <span className="inline-block w-2 h-2 rounded-full bg-gray-400 mr-2"></span>
            Draft
          </div>
        </div>
      </div>
    </div>
  );
}
