/**
 * opencloudExecutor.js — OpenCloud publish/import operations.
 *
 * Wraps opencloudArtifactSync for upload and import steps.
 */

import {
  syncTaskOutputsToOpenCloud,
  importDatasetFromOpenCloud,
} from '../../opencloudArtifactSync.js';

/**
 * @param {object} stepInput
 * @param {object} stepInput.step - { name, tool_hint, opencloud_action, opencloud_config }
 * @param {object} stepInput.inputData - { priorArtifacts, userId }
 * @param {string} stepInput.taskId
 * @returns {Promise<{ok: boolean, artifacts: any[], logs: string[], error?: string}>}
 */
export async function executeOpenCloud(stepInput) {
  const { step, inputData, taskId } = stepInput;
  const logs = [];
  const action = step.opencloud_action || 'publish';

  logs.push(`[OpenCloudExecutor] Action: ${action} for step: ${step.name}`);

  try {
    if (action === 'import') {
      const { driveId, itemId } = step.opencloud_config || {};
      if (!driveId || !itemId) {
        return { ok: false, artifacts: [], logs, error: 'Missing driveId or itemId for import' };
      }

      const result = await importDatasetFromOpenCloud(driveId, itemId, inputData.userId);
      logs.push(`[OpenCloudExecutor] Import completed`);
      return { ok: true, artifacts: result ? [result] : [], logs };
    }

    // Default: publish task outputs
    const config = step.opencloud_config || {};
    const result = await syncTaskOutputsToOpenCloud(taskId, config.driveId, {
      folderPath: config.folderPath,
      share: config.share !== false,
    });

    logs.push(`[OpenCloudExecutor] Published ${result?.uploadedCount || 0} files`);
    return {
      ok: true,
      artifacts: [{
        artifact_type: 'opencloud_sync_result',
        label: `OpenCloud publish: ${step.name}`,
        payload: result,
      }],
      logs,
    };
  } catch (err) {
    logs.push(`[OpenCloudExecutor] Error: ${err.message}`);
    return { ok: false, artifacts: [], logs, error: err.message };
  }
}
