/**
 * ai-action.js — AI-driven Playwright helper
 *
 * Use natural language to drive Playwright actions instead of hardcoded selectors.
 * Uses DeepSeek API (from .env.local) to convert instructions → Playwright code.
 *
 * Usage:
 *   import { ai } from '../helpers/ai-action.js';
 *   await ai(page, '點擊送出按鈕');
 *   await ai(page, 'type "hello" in the chat input and press Enter');
 *   const result = await ai(page, 'check if a forecast chart is visible');
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Env ─────────────────────────────────────────────────────────────────────
function readEnvVar(varName) {
  try {
    const content = fs.readFileSync(path.join(__dirname, '..', '..', '.env.local'), 'utf8');
    const m = content.match(new RegExp(`^${varName}=(.+)$`, 'm'));
    return m ? m[1].trim() : null;
  } catch { return null; }
}

const DEEPSEEK_API_KEY = process.env.VITE_DEEPSEEK_API_KEY || readEnvVar('VITE_DEEPSEEK_API_KEY');
const DEEPSEEK_BASE_URL = process.env.VITE_DI_DEEPSEEK_BASE_URL || readEnvVar('VITE_DI_DEEPSEEK_BASE_URL') || 'https://api.deepseek.com';
const DEEPSEEK_MODEL = process.env.VITE_DI_DEEPSEEK_MODEL || readEnvVar('VITE_DI_DEEPSEEK_MODEL') || 'deepseek-chat';

// ── Cache ───────────────────────────────────────────────────────────────────
const codeCache = new Map();

// ── DOM Snapshot ────────────────────────────────────────────────────────────
/**
 * Extract a compact JSON tree of interactive elements from the page.
 * Keeps the LLM context small (< 4K tokens for most pages).
 */
async function snapshotDOM(page) {
  return page.evaluate(() => {
    const MAX = 200;
    const seen = new Set();
    const elements = [];

    const selectors = [
      'button', 'a', 'input', 'textarea', 'select',
      '[role="button"]', '[role="tab"]', '[role="link"]', '[role="menuitem"]',
      '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
      '[data-testid]', '[aria-label]',
    ];

    for (const sel of selectors) {
      if (elements.length >= MAX) break;
      for (const el of document.querySelectorAll(sel)) {
        if (elements.length >= MAX) break;
        if (seen.has(el)) continue;
        seen.add(el);

        const rect = el.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0 &&
          window.getComputedStyle(el).display !== 'none' &&
          window.getComputedStyle(el).visibility !== 'hidden';
        if (!visible) continue;

        const text = (el.textContent || '').trim().slice(0, 80);
        const entry = {
          tag: el.tagName.toLowerCase(),
          text: text || undefined,
          role: el.getAttribute('role') || undefined,
          id: el.id || undefined,
          testid: el.getAttribute('data-testid') || undefined,
          type: el.getAttribute('type') || undefined,
          placeholder: el.getAttribute('placeholder') || undefined,
          ariaLabel: el.getAttribute('aria-label') || undefined,
          title: el.getAttribute('title') || undefined,
          name: el.getAttribute('name') || undefined,
          href: el.tagName === 'A' ? el.getAttribute('href') : undefined,
          disabled: el.disabled || undefined,
        };

        // Remove undefined keys
        for (const k of Object.keys(entry)) {
          if (entry[k] === undefined) delete entry[k];
        }
        elements.push(entry);
      }
    }

    return elements;
  });
}

// ── System Prompt ───────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a Playwright test automation expert. Given a DOM snapshot (JSON array of interactive elements) and a natural language instruction, output ONLY the JavaScript code body that performs the action using the Playwright \`page\` API.

Rules:
- Use page.locator(), page.click(), page.fill(), page.press(), page.waitForSelector(), page.waitForTimeout(), etc.
- Prefer selectors in this order: data-testid > aria-label > role > title > text content > tag+type
- For text matching, use page.locator('text=...') or page.locator('button:has-text("...")').
- Output ONLY the raw JavaScript code. No markdown fences, no explanation, no comments.
- The code runs inside: async function(page) { YOUR_CODE_HERE }
- Always await async operations.
- For assertions/checks, set a variable \`result\` (boolean or string) that will be returned.
- For file uploads, use: await page.locator('input[type="file"]').setInputFiles(filePath);
- Keep the code concise — usually 1-5 lines.

Examples:
Instruction: "click the Send button"
Code: await page.locator('button[title="Send"], button:has-text("Send")').first().click();

Instruction: "type hello in the chat input"
Code: await page.locator('textarea').first().fill('hello');

Instruction: "check if a forecast chart is visible"
Code: result = await page.locator('text=/forecast|Forecast|預測/i').first().isVisible({ timeout: 5000 }).catch(() => false);

Instruction: "upload test.csv"
Code: await page.locator('input[type="file"]').first().setInputFiles('e2e/fixtures/test-supply-chain.csv');`;

// ── LLM Call ────────────────────────────────────────────────────────────────
async function callDeepSeek(userPrompt) {
  if (!DEEPSEEK_API_KEY) {
    throw new Error('[ai-action] No VITE_DEEPSEEK_API_KEY found in .env.local — cannot use ai() helper');
  }

  const resp = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0,
      max_tokens: 1024,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`[ai-action] DeepSeek API error ${resp.status}: ${text.slice(0, 200)}`);
  }

  const json = await resp.json();
  let code = json.choices?.[0]?.message?.content || '';

  // Strip markdown fences if LLM adds them despite instructions
  code = code.replace(/^```(?:javascript|js)?\n?/gm, '').replace(/\n?```$/gm, '').trim();

  return code;
}

// ── Main: ai() ──────────────────────────────────────────────────────────────
/**
 * Execute a natural language instruction on the page using AI.
 *
 * @param {import('playwright').Page} page - Playwright page object
 * @param {string} instruction - What to do, in natural language (EN or ZH)
 * @param {object} [opts]
 * @param {boolean} [opts.retry=true] - Retry once on failure with error context
 * @param {boolean} [opts.screenshot=false] - Take before/after screenshots
 * @param {string} [opts.screenshotDir] - Directory for screenshots
 * @returns {Promise<{ success: boolean, code: string, result?: any, error?: string }>}
 */
export async function ai(page, instruction, opts = {}) {
  const { retry = true, screenshot = false, screenshotDir = '' } = opts;

  // [1] Snapshot DOM
  const elements = await snapshotDOM(page);

  // [2] Check cache
  const cacheKey = JSON.stringify({ elements: elements.slice(0, 20), instruction });
  if (codeCache.has(cacheKey)) {
    const cached = codeCache.get(cacheKey);
    try {
      const fn = new Function('page', `return (async (page) => { let result; ${cached}; return result; })(page);`);
      const result = await fn(page);
      return { success: true, code: cached, result, cached: true };
    } catch {
      codeCache.delete(cacheKey);
    }
  }

  // [3] Build prompt
  const userPrompt = `DOM Snapshot (${elements.length} interactive elements):\n${JSON.stringify(elements, null, 0)}\n\nInstruction: ${instruction}`;

  // [4] Call LLM
  let code;
  try {
    code = await callDeepSeek(userPrompt);
  } catch (e) {
    return { success: false, code: '', error: e.message };
  }

  if (!code) {
    return { success: false, code: '', error: 'LLM returned empty code' };
  }

  // [5] Take before screenshot
  if (screenshot && screenshotDir) {
    await page.screenshot({ path: path.join(screenshotDir, `ai-before-${Date.now()}.png`) }).catch(() => {});
  }

  // [6] Execute
  try {
    const fn = new Function('page', `return (async (page) => { let result; ${code}; return result; })(page);`);
    const result = await fn(page);

    // Cache on success
    codeCache.set(cacheKey, code);

    // After screenshot
    if (screenshot && screenshotDir) {
      await page.screenshot({ path: path.join(screenshotDir, `ai-after-${Date.now()}.png`) }).catch(() => {});
    }

    return { success: true, code, result };
  } catch (execError) {
    // [7] Retry with error context
    if (retry) {
      const retryPrompt = `${userPrompt}\n\nMy previous code failed with this error:\n${execError.message}\n\nPrevious code:\n${code}\n\nPlease fix the code. Output ONLY the corrected JavaScript code.`;

      try {
        const fixedCode = await callDeepSeek(retryPrompt);
        if (fixedCode) {
          const fn2 = new Function('page', `return (async (page) => { let result; ${fixedCode}; return result; })(page);`);
          const result = await fn2(page);
          codeCache.set(cacheKey, fixedCode);
          return { success: true, code: fixedCode, result, retried: true };
        }
      } catch (retryErr) {
        return { success: false, code, error: `Retry also failed: ${retryErr.message}`, originalError: execError.message };
      }
    }

    return { success: false, code, error: execError.message };
  }
}

/**
 * Assert something about the page using AI.
 * Throws if the assertion fails.
 */
export async function aiAssert(page, assertion) {
  const result = await ai(page, `check if: ${assertion}. Set result = true if yes, false if no.`, { retry: true });
  if (!result.success) throw new Error(`[aiAssert] AI action failed: ${result.error}`);
  if (result.result !== true) throw new Error(`[aiAssert] Assertion failed: "${assertion}" — result was ${result.result}`);
  return result;
}

/**
 * Get information from the page using AI.
 * Returns the extracted value.
 */
export async function aiQuery(page, query) {
  const result = await ai(page, `${query}. Store the answer in \`result\`.`, { retry: true });
  if (!result.success) throw new Error(`[aiQuery] AI action failed: ${result.error}`);
  return result.result;
}

export { snapshotDOM };
