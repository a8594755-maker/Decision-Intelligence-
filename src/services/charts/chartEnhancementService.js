/**
 * chartEnhancementService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Sends a chart spec to the LLM for visual enhancement (colors, reference
 * lines, axis labels, tick formatting). Data and structure are never changed.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { callLLM } from '../ai-infra/aiEmployeeLLMService.js';

const STYLING_KEYS = [
  'colors',
  'colorMap',
  'referenceLines',
  'xAxisLabel',
  'yAxisLabel',
  'tickFormatter',
  'title',
];

const SYSTEM_PROMPT = `You are a data visualization expert. Given a Recharts-compatible chart spec, enhance it for maximum clarity and visual appeal.

Return ONLY valid JSON — no markdown, no code fences, no commentary.

You MAY change these fields:
- colors: array of hex color strings for bars/lines/pie segments. Use a professional, accessible palette.
- colorMap: object mapping x-axis values to hex colors (for categorical bar charts).
- referenceLines: array of { value, label, color?, axis?, strokeDasharray? }. Add lines for mean/median/thresholds when the data warrants it.
- xAxisLabel: descriptive axis label in the audience's language.
- yAxisLabel: descriptive axis label in the audience's language.
- tickFormatter: { x?: "compact"|"currency"|"percent", y?: "compact"|"currency"|"percent" }.
- title: improved chart title in the audience's language.

You must NOT change: type, data, xKey, yKey, series.

Design principles:
- Use distinct, colorblind-friendly palettes (avoid pure red/green pairs).
- Add reference lines only when they aid interpretation (averages, targets, thresholds).
- Keep axis labels concise (≤30 chars).
- Match the language of the existing title/labels.`;

/**
 * Enhance a chart spec with LLM-generated styling.
 *
 * @param {object} chart - Original chart spec ({ type, data, xKey, yKey, ... })
 * @param {object} [context] - Optional context for better enhancement
 * @param {string} [context.title] - Card title (e.g. "Seller Revenue Distribution")
 * @param {string} [context.summary] - Card summary text
 * @returns {Promise<object>} Enhanced chart spec (original data preserved)
 */
export async function enhanceChartSpec(chart, { title, summary } = {}) {
  if (!chart?.type || !Array.isArray(chart?.data)) {
    throw new Error('Invalid chart spec: requires type and data array');
  }

  // Send a compact version (limit data to 30 rows to save tokens)
  const compactChart = {
    ...chart,
    data: chart.data.slice(0, 30),
  };

  const { text } = await callLLM({
    taskType: 'chart_enhancement',
    systemPrompt: SYSTEM_PROMPT,
    prompt: JSON.stringify({ chart: compactChart, title, summary }),
    temperature: 0.3,
    maxTokens: 2048,
    jsonMode: true,
  });

  const enhanced = JSON.parse(text);

  // Merge: keep original data integrity, only adopt styling fields
  const result = { ...chart };
  for (const key of STYLING_KEYS) {
    if (enhanced[key] != null) {
      result[key] = enhanced[key];
    }
  }

  return result;
}
