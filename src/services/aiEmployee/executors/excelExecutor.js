/**
 * excelExecutor.js — Generates MBR Excel workbook via ML API.
 *
 * Calls POST /agent/generate-excel which:
 *   1. Takes step artifacts (cleaned data, KPIs, pivots, insights)
 *   2. Generates a real .xlsx with 6 formatted sheets via openpyxl
 *   3. Opens it in Excel desktop
 *   4. Returns file path + base64 for upload
 *
 * Pure function: stepInput → { ok, artifacts, logs, error? }
 */

const ML_API_BASE = 'http://localhost:8000';

/**
 * @param {object} stepInput
 * @param {object} stepInput.step - { name, tool_hint }
 * @param {object} stepInput.inputData - { priorStepResults, title }
 * @param {string} stepInput.taskId
 * @returns {Promise<{ok: boolean, artifacts: any[], logs: string[], error?: string}>}
 */
export async function executeExcelTool(stepInput) {
  const { step, inputData, taskId, styleContext, outputProfile } = stepInput;
  const logs = [];

  logs.push(`[ExcelExecutor] Generating MBR workbook for task: ${taskId}`);
  if (outputProfile?.profileName) {
    logs.push(`[ExcelExecutor] Using output profile: ${outputProfile.profileName} (${outputProfile.docType}, v${outputProfile.version})`);
  }
  if (styleContext) {
    logs.push(`[ExcelExecutor] Applied learned style context (${styleContext.length} chars)`);
  }

  try {
    const resp = await fetch(`${ML_API_BASE}/agent/generate-excel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task_id: taskId,
        step_results: inputData.priorStepResults || [],
        title: inputData.title || step.tool_hint || '',
        style_context: styleContext || '',
        output_profile: outputProfile || null,
        open_file: true,
      }),
    });

    if (!resp.ok) {
      const errorText = await resp.text().catch(() => 'Unknown error');
      logs.push(`[ExcelExecutor] HTTP ${resp.status}: ${errorText.slice(0, 200)}`);
      return { ok: false, artifacts: [], logs, error: `ML API returned ${resp.status}` };
    }

    const result = await resp.json();

    if (!result.ok) {
      logs.push(`[ExcelExecutor] Generation failed: ${result.error}`);
      return { ok: false, artifacts: [], logs, error: result.error };
    }

    logs.push(`[ExcelExecutor] Generated: ${result.filename} (${result.file_size} bytes, ${result.sheets?.length} sheets)`);
    logs.push(`[ExcelExecutor] File opened in Excel: ${result.file_path}`);

    return {
      ok: true,
      artifacts: [
        {
          type: 'excel_workbook',
          label: result.filename,
          data: {
            file_path: result.file_path,
            filename: result.filename,
            file_size: result.file_size,
            sheets: result.sheets,
            content_base64: result.content_base64,
          },
        },
      ],
      logs,
    };
  } catch (err) {
    logs.push(`[ExcelExecutor] Error: ${err.message}`);
    return { ok: false, artifacts: [], logs, error: `ML API unreachable: ${err.message}` };
  }
}
