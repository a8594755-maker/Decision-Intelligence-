// ============================================
// Logic Control Center - Main Page
// Phase 1: Frontend - /admin/logic
// ============================================

import { useState, useEffect } from 'react';
import { supabase } from '../../services/infra/supabaseClient';
import {
  fetchLogicVersions,
  fetchPublishedLogicVersion,
  fetchDraftVersions,
  DEFAULT_LOGIC_CONFIG,
  getStatusColor,
  getStatusText,
} from '../../services/governance/logicVersionService';
import LogicTree from './LogicTree';
import OverviewTab from './OverviewTab';
import EditTab from './EditTab';
import SandboxTab from './SandboxTab';
import ReleaseTab from './ReleaseTab';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'edit', label: 'Edit' },
  { id: 'sandbox', label: 'Sandbox & Diff' },
  { id: 'release', label: 'Release' },
];

export default function AdminLogicControlCenter({ setView }) {
  const [user, setUser] = useState(null);
  const [userRole, setUserRole] = useState('viewer');
  const [activeTab, setActiveTab] = useState('overview');
  
  // Logic tree state
  const [selectedLogic, setSelectedLogic] = useState('bom_explosion');
  const [selectedScope, setSelectedScope] = useState({ level: 'GLOBAL', id: null });
  const [versions, setVersions] = useState([]);
  const [publishedVersion, setPublishedVersion] = useState(null);
  const [draftVersion, setDraftVersion] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    checkAuth();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- checkAuth runs once on mount
  }, []);

  useEffect(() => {
    if (user && selectedLogic) {
      loadVersions();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- loadVersions depends on user/selectedLogic/selectedScope
  }, [user, selectedLogic, selectedScope]);

  async function checkAuth() {
    const { data: { user: currentUser } } = await supabase.auth.getUser();
    if (!currentUser) {
      setView('login');
      return;
    }
    setUser(currentUser);

    // Fetch user role
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('role')
      .eq('user_id', currentUser.id)
      .single();
    
    if (profile) {
      setUserRole(profile.role || 'viewer');
    }
  }

  async function loadVersions() {
    setLoading(true);
    try {
      // Fetch all versions for this logic
      const allVersions = await fetchLogicVersions(selectedLogic);
      setVersions(allVersions);

      // Fetch published version for selected scope
      const published = await fetchPublishedLogicVersion(
        selectedLogic,
        selectedScope.level,
        selectedScope.id
      );
      setPublishedVersion(published);

      // Find user's draft
      const drafts = await fetchDraftVersions(selectedLogic);
      const relevantDraft = drafts.find(d => 
        d.scope_level === selectedScope.level && 
        (d.scope_id === selectedScope.id || (!d.scope_id && !selectedScope.id))
      );
      setDraftVersion(relevantDraft || null);
    } catch (err) {
      console.error('Error loading versions:', err);
    } finally {
      setLoading(false);
    }
  }

  function handleScopeSelect(level, id) {
    setSelectedScope({ level, id });
  }

  function handleCreateDraft() {
    // This will be handled by the EditTab component
    setActiveTab('edit');
  }

  const canEdit = ['admin', 'logic_editor'].includes(userRole);
  const canApprove = ['admin', 'logic_approver'].includes(userRole);
  const canPublish = ['admin', 'logic_publisher'].includes(userRole);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-4">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Logic Control Center</h1>
              <p className="text-sm text-gray-500 mt-1">
                Configure calculation policies without code changes
              </p>
            </div>
            <div className="flex items-center space-x-4">
              <span className="text-sm text-gray-500">
                Role: <span className="font-medium capitalize">{userRole}</span>
              </span>
              {draftVersion && (
                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(draftVersion.status)}`}>
                  Draft: {getStatusText(draftVersion.status)}
                </span>
              )}
              {publishedVersion && (
                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor('published')}`}>
                  Published v{publishedVersion.schema_version}
                </span>
              )}
            </div>
          </div>

          {/* Tabs */}
          <div className="border-b border-gray-200">
            <nav className="-mb-px flex space-x-8">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`
                    whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm
                    ${activeTab === tab.id
                      ? 'border-indigo-500 text-indigo-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                    }
                  `}
                >
                  {tab.label}
                </button>
              ))}
            </nav>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex gap-6">
          {/* Sidebar - Logic Tree */}
          <div className="w-64 flex-shrink-0">
            <LogicTree
              selectedLogic={selectedLogic}
              selectedScope={selectedScope}
              onSelectLogic={setSelectedLogic}
              onSelectScope={handleScopeSelect}
              versions={versions}
            />
          </div>

          {/* Main Panel */}
          <div className="flex-1">
            {loading ? (
              <div className="flex items-center justify-center h-64">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
              </div>
            ) : (
              <>
                {activeTab === 'overview' && (
                  <OverviewTab
                    publishedVersion={publishedVersion}
                    draftVersion={draftVersion}
                    selectedScope={selectedScope}
                    onCreateDraft={handleCreateDraft}
                    canEdit={canEdit}
                  />
                )}
                {activeTab === 'edit' && (
                  <EditTab
                    logicId={selectedLogic}
                    scopeLevel={selectedScope.level}
                    scopeId={selectedScope.id}
                    draftVersion={draftVersion}
                    publishedVersion={publishedVersion}
                    onDraftCreated={loadVersions}
                    canEdit={canEdit}
                  />
                )}
                {activeTab === 'sandbox' && (
                  <SandboxTab
                    draftVersion={draftVersion}
                    publishedVersion={publishedVersion}
                    canEdit={canEdit}
                  />
                )}
                {activeTab === 'release' && (
                  <ReleaseTab
                    draftVersion={draftVersion}
                    publishedVersion={publishedVersion}
                    onStatusChange={loadVersions}
                    canEdit={canEdit}
                    canApprove={canApprove}
                    canPublish={canPublish}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
