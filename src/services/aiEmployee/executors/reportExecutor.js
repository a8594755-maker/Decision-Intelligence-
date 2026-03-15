/**
 * reportExecutor.js — Generates reports from prior step artifacts.
 *
 * Wraps reportGeneratorService.generateReport().
 */

import { generateReport } from '../../reportGeneratorService.js';

/**
 * @param {object} stepInput
 * @param {object} stepInput.step - { name, tool_hint }
 * @param {object} stepInput.inputData - { priorArtifacts, taskMeta }
 * @param {string} stepInput.taskId
 * @returns {Promise<{ok: boolean, artifacts: any[], logs: string[], error?: string}>}
 */
export async function executeReport(stepInput) {
  const { step, inputData, taskId } = stepInput;
  const logs = [];

  logs.push(`[ReportExecutor] Generating report for step: ${step.name}`);

  try {
    const format = step.report_format || 'html';
    const result = await generateReport({
      format,
      artifacts: inputData.priorArtifacts || [],
      taskMeta: inputData.taskMeta || { taskId, stepName: step.name },
      narrative: step.tool_hint,
    });

    logs.push(`[ReportExecutor] Generated ${format} report`);

    const artifacts = result?.artifacts || [];
    if (result?.html || result?.content) {
      artifacts.push({
        artifact_type: 'report_json',
        label: `Report: ${step.name}`,
        payload: result.html || result.content,
      });
    }

    return { ok: true, artifacts, logs };
  } catch (err) {
    logs.push(`[ReportExecutor] Error: ${err.message}`);
    return { ok: false, artifacts: [], logs, error: err.message };
  }
}
