// @product: ai-employee
//
// opencloudDesktopSync.js
// ─────────────────────────────────────────────────────────────────────────────
// Helper for configuring and detecting OpenCloud desktop client sync.
//
// The OpenCloud desktop client syncs files between the server and the local
// filesystem. This service helps users set up sync for DI artifacts and
// detects locally-synced files for quick access.
//
// Desktop client config is typically at:
//   - macOS:   ~/Library/Preferences/OpenCloud/opencloud.cfg
//   - Linux:   ~/.config/OpenCloud/opencloud.cfg
//   - Windows: %APPDATA%\OpenCloud\opencloud.cfg
// ─────────────────────────────────────────────────────────────────────────────

import {
  OPENCLOUD_URL,
  OPENCLOUD_BASE_FOLDER,
  DESKTOP_SYNC_FOLDER,
  isOpenCloudConfigured,
} from '../config/opencloudConfig';

// ── Sync folder detection ─────────────────────────────────────────────────

/**
 * Get the configured desktop sync folder for DI artifacts.
 * @returns {string|null}
 */
export function getDesktopSyncFolder() {
  return DESKTOP_SYNC_FOLDER || null;
}

/**
 * Check if desktop sync is configured.
 * @returns {boolean}
 */
export function isDesktopSyncConfigured() {
  return !!DESKTOP_SYNC_FOLDER;
}

/**
 * Get the expected local path for a task's artifacts.
 * @param {string} taskId
 * @param {string} [employeeName='Data Analyst']
 * @returns {string|null} Local filesystem path, or null if not configured
 */
export function getLocalTaskPath(taskId, employeeName = 'Data Analyst') {
  if (!DESKTOP_SYNC_FOLDER) return null;
  return `${DESKTOP_SYNC_FOLDER}/${OPENCLOUD_BASE_FOLDER}/${employeeName}/tasks/${taskId}`;
}

/**
 * Get the expected local path for reports.
 * @param {string} [employeeName='Data Analyst']
 * @returns {string|null}
 */
export function getLocalReportsPath(employeeName = 'Data Analyst') {
  if (!DESKTOP_SYNC_FOLDER) return null;
  return `${DESKTOP_SYNC_FOLDER}/${OPENCLOUD_BASE_FOLDER}/${employeeName}/reports`;
}

// ── Desktop client configuration guide ────────────────────────────────────

/**
 * Generate a step-by-step guide for setting up OpenCloud desktop sync.
 * @returns {object} Guide with steps, platform-specific paths, and config
 */
export function generateSyncSetupGuide() {
  const serverUrl = OPENCLOUD_URL || '<your-opencloud-server>';
  const syncFolder = OPENCLOUD_BASE_FOLDER;

  return {
    title: 'OpenCloud Desktop Sync Setup',
    prerequisites: [
      'OpenCloud desktop client installed (https://opencloud.eu/desktop)',
      `OpenCloud server accessible at ${serverUrl}`,
    ],
    steps: [
      {
        step: 1,
        title: 'Download and install the OpenCloud desktop client',
        platforms: {
          macos: 'Download from opencloud.eu/desktop or `brew install --cask opencloud`',
          linux: 'Download AppImage from opencloud.eu/desktop or install from your distro\'s package manager',
          windows: 'Download installer from opencloud.eu/desktop',
        },
      },
      {
        step: 2,
        title: 'Add your OpenCloud server',
        instruction: `Enter your server URL: ${serverUrl}`,
      },
      {
        step: 3,
        title: 'Authenticate',
        instruction: 'Log in with your OpenCloud credentials (same as DI login if OIDC is configured)',
      },
      {
        step: 4,
        title: 'Configure selective sync',
        instruction: `Select only the "${syncFolder}" folder to sync DI artifacts without downloading all server files`,
      },
      {
        step: 5,
        title: 'Set local sync directory',
        instruction: 'Choose a local folder for synced files, then set VITE_OPENCLOUD_DESKTOP_SYNC_FOLDER to that path',
        platforms: {
          macos: 'Recommended: ~/Documents/OpenCloud/Decision-Intelligence',
          linux: 'Recommended: ~/OpenCloud/Decision-Intelligence',
          windows: 'Recommended: C:\\Users\\<you>\\OpenCloud\\Decision-Intelligence',
        },
      },
      {
        step: 6,
        title: 'Configure .env',
        instruction: `Add to your .env file:\n  VITE_OPENCLOUD_DESKTOP_SYNC_FOLDER=/path/to/your/sync/folder`,
      },
    ],
    configTemplate: {
      description: 'Add these to your .env file',
      vars: {
        VITE_OPENCLOUD_URL: serverUrl,
        VITE_OPENCLOUD_TOKEN: '<your-api-token>',
        VITE_OPENCLOUD_AUTO_SYNC: 'true',
        VITE_OPENCLOUD_DESKTOP_SYNC_FOLDER: '/path/to/sync/folder',
        VITE_OPENCLOUD_AUTO_DISTRIBUTE: 'false',
        VITE_OPENCLOUD_DISTRIBUTE_TO: '',
      },
    },
    folderStructure: {
      description: 'Expected folder structure after sync',
      tree: [
        `${syncFolder}/`,
        `  Data Analyst/`,
        `    tasks/`,
        `      <task-id>/`,
        `        forecast/`,
        `          forecast_series_0.json`,
        `        plan/`,
        `          plan_table_0.json`,
        `    reports/`,
        `      report_<task-id>.html`,
      ],
    },
  };
}

/**
 * Generate a .env template string for OpenCloud configuration.
 * @returns {string}
 */
export function generateEnvTemplate() {
  return `# ── OpenCloud EU Integration ──────────────────────────────────────
# Server connection
VITE_OPENCLOUD_URL=${OPENCLOUD_URL || 'https://your-opencloud-server.eu'}
VITE_OPENCLOUD_TOKEN=your-api-token-here

# Auto-sync: upload artifacts to OpenCloud after task completion
VITE_OPENCLOUD_AUTO_SYNC=false

# Auto-distribute: share reports with team members
VITE_OPENCLOUD_AUTO_DISTRIBUTE=false
VITE_OPENCLOUD_DISTRIBUTE_TO=user1@example.com,user2@example.com

# Desktop sync: local folder for OpenCloud desktop client sync
VITE_OPENCLOUD_DESKTOP_SYNC_FOLDER=
`;
}

/**
 * Get the current integration status summary.
 * @returns {object}
 */
export function getIntegrationStatus() {
  return {
    configured: isOpenCloudConfigured(),
    serverUrl: OPENCLOUD_URL || null,
    desktopSync: {
      configured: isDesktopSyncConfigured(),
      folder: DESKTOP_SYNC_FOLDER || null,
    },
    features: {
      autoSync: !!import.meta.env.VITE_OPENCLOUD_AUTO_SYNC,
      autoDistribute: !!import.meta.env.VITE_OPENCLOUD_AUTO_DISTRIBUTE,
      sseWatching: true,
      tagging: true,
      fullTextSearch: true,
      eventTriggers: true,
      webExtension: true,
    },
  };
}

export default {
  getDesktopSyncFolder,
  isDesktopSyncConfigured,
  getLocalTaskPath,
  getLocalReportsPath,
  generateSyncSetupGuide,
  generateEnvTemplate,
  getIntegrationStatus,
};
