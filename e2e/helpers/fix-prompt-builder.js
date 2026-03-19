/**
 * fix-prompt-builder.js — Parse E2E test reports + build LLM fix prompts
 *
 * Supports three report formats:
 *   - live-report.json (from live-worker-test.js)
 *   - crawler-report.json (from auto-crawler.js)
 *   - Playwright JSON reporter output
 */

import fs from 'fs';
import path from 'path';

/**
 * Unified failure shape used by the auto-fix loop.
 * @typedef {object} Failure
 * @property {string} source - 'live' | 'crawler' | 'playwright'
 * @property {string} name - test or route name
 * @property {string} error - error message
 * @property {string} [stack] - stack trace (if available)
 * @property {string} [file] - source file path extracted from stack
 * @property {number} [line] - line number extracted from stack
 * @property {string} [screenshot] - screenshot path
 * @property {string} [phase] - phase ID (for live reports)
 */

// ── Parse live-report.json ──────────────────────────────────────────────────
export function parseLiveReport(jsonPath) {
  const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const failures = [];

  for (const phase of report.phases || []) {
    for (const test of phase.tests || []) {
      if (!test.pass) {
        failures.push({
          source: 'live',
          name: `Phase ${phase.id}: ${test.name}`,
          error: test.detail || test.name,
          phase: phase.id,
        });
      }
    }
  }

  // Console errors (may indicate source bugs)
  for (const err of (report.console_errors || []).slice(0, 10)) {
    const fileMatch = err.text.match(/at\s+(?:\w+\s+\()?([^:]+):(\d+)/);
    failures.push({
      source: 'live',
      name: `Console error`,
      error: err.text.slice(0, 500),
      file: fileMatch?.[1],
      line: fileMatch ? parseInt(fileMatch[2], 10) : undefined,
    });
  }

  // Page errors (JS crashes)
  for (const err of (report.page_errors || []).slice(0, 10)) {
    const fileMatch = (err.stack || '').match(/at\s+(?:\w+\s+\()?([^:]+):(\d+)/);
    failures.push({
      source: 'live',
      name: `JS Crash`,
      error: err.message,
      stack: err.stack,
      file: fileMatch?.[1],
      line: fileMatch ? parseInt(fileMatch[2], 10) : undefined,
    });
  }

  return failures;
}

// ── Parse crawler-report.json ───────────────────────────────────────────────
export function parseCrawlerReport(jsonPath) {
  const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const failures = [];

  for (const route of report.routes || []) {
    for (const err of route.errors || []) {
      const fileMatch = (err.text || '').match(/at\s+(?:\w+\s+\()?([^:]+):(\d+)/);
      failures.push({
        source: 'crawler',
        name: `${route.name} (${route.route})`,
        error: err.text || err.type,
        file: fileMatch?.[1],
        line: fileMatch ? parseInt(fileMatch[2], 10) : undefined,
        screenshot: route.screenshotPath,
      });
    }
    for (const ind of route.indicators || []) {
      if (ind.severity === 'error') {
        failures.push({
          source: 'crawler',
          name: `${route.name} (${route.route})`,
          error: ind.msg,
          screenshot: route.screenshotPath,
        });
      }
    }
  }

  return failures;
}

// ── Parse Playwright JSON report ────────────────────────────────────────────
export function parsePlaywrightReport(jsonPath) {
  const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const failures = [];

  function extractFromSuites(suites) {
    for (const suite of suites || []) {
      for (const spec of suite.specs || []) {
        for (const test of spec.tests || []) {
          for (const result of test.results || []) {
            if (result.status === 'failed' || result.status === 'timedOut') {
              const errMsg = result.error?.message || result.error?.snippet || 'Unknown error';
              const stack = result.error?.stack || '';
              const fileMatch = stack.match(/at\s+(?:\w+\s+\()?([^:]+):(\d+)/);

              failures.push({
                source: 'playwright',
                name: `${suite.title} > ${spec.title}`,
                error: errMsg.slice(0, 1000),
                stack: stack.slice(0, 2000),
                file: fileMatch?.[1] || spec.file,
                line: fileMatch ? parseInt(fileMatch[2], 10) : undefined,
              });
            }
          }
        }
      }
      // Recurse into nested suites
      if (suite.suites) extractFromSuites(suite.suites);
    }
  }

  extractFromSuites(report.suites);
  return failures;
}

// ── Auto-detect report format ───────────────────────────────────────────────
export function parseReport(jsonPath) {
  const raw = fs.readFileSync(jsonPath, 'utf8');
  const data = JSON.parse(raw);

  if (data.phases) return parseLiveReport(jsonPath);
  if (data.routes) return parseCrawlerReport(jsonPath);
  if (data.suites) return parsePlaywrightReport(jsonPath);

  throw new Error(`[fix-prompt-builder] Unknown report format in ${jsonPath}`);
}

// ── Read source context ─────────────────────────────────────────────────────
/**
 * Read up to `maxLines` lines from a source file around the error line.
 * Returns the source code string with line numbers.
 */
export function readSourceContext(filePath, errorLine, maxLines = 200) {
  if (!filePath || !fs.existsSync(filePath)) return null;

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    const startLine = Math.max(0, (errorLine || 0) - Math.floor(maxLines / 2));
    const endLine = Math.min(lines.length, startLine + maxLines);

    const numbered = lines.slice(startLine, endLine)
      .map((line, i) => `${startLine + i + 1}: ${line}`)
      .join('\n');

    return { filePath, startLine: startLine + 1, endLine, content: numbered };
  } catch {
    return null;
  }
}

// ── Resolve file path from stack trace paths ────────────────────────────────
/**
 * Try to resolve a file path from a stack trace entry.
 * Stack traces may contain absolute paths, relative paths, or Vite-transformed paths.
 */
export function resolveFilePath(rawPath, projectRoot) {
  if (!rawPath) return null;

  // Strip query strings (Vite adds ?v=xxx)
  const cleaned = rawPath.split('?')[0];

  // Already absolute and exists?
  if (path.isAbsolute(cleaned) && fs.existsSync(cleaned)) return cleaned;

  // Try relative to project root
  const fromRoot = path.join(projectRoot, cleaned);
  if (fs.existsSync(fromRoot)) return fromRoot;

  // Try as src/ path
  const fromSrc = path.join(projectRoot, 'src', cleaned);
  if (fs.existsSync(fromSrc)) return fromSrc;

  // Search in common directories
  for (const dir of ['src/services', 'src/components', 'src/views', 'src/pages', 'src/utils']) {
    const base = path.basename(cleaned);
    const candidate = path.join(projectRoot, dir, base);
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

// ── Build fix prompt ────────────────────────────────────────────────────────
/**
 * Build an LLM prompt that describes the failure and provides source context.
 *
 * @param {Failure} failure
 * @param {string} projectRoot
 * @returns {{ prompt: string, sourceFile: string|null }}
 */
export function buildFixPrompt(failure, projectRoot) {
  const resolvedFile = resolveFilePath(failure.file, projectRoot);
  const sourceCtx = resolvedFile
    ? readSourceContext(resolvedFile, failure.line)
    : null;

  let prompt = `You are a senior frontend developer fixing a bug in a React + Vite + Supabase project.

## Error
Source: ${failure.source} test
Test: ${failure.name}
Error: ${failure.error}`;

  if (failure.stack) {
    prompt += `\nStack trace:\n${failure.stack.slice(0, 1500)}`;
  }

  if (sourceCtx) {
    prompt += `\n\n## Source Code (${sourceCtx.filePath}, lines ${sourceCtx.startLine}-${sourceCtx.endLine})
\`\`\`javascript
${sourceCtx.content}
\`\`\``;
  }

  prompt += `\n\n## Instructions
1. Analyze the root cause of the failure.
2. Output a unified diff that fixes the issue.
3. Output ONLY the diff, no explanation before or after.
4. Format: standard unified diff with --- a/ and +++ b/ headers, using the actual file path.
5. If the fix requires changes to multiple files, output multiple diff blocks separated by a blank line.
6. Do NOT touch .env files, node_modules, or migration files.
7. Keep the fix minimal — only change what's needed.`;

  return { prompt, sourceFile: resolvedFile };
}
