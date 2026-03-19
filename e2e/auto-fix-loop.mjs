#!/usr/bin/env node
/**
 * auto-fix-loop.mjs — Automated test → detect → fix → re-test pipeline
 *
 * Usage:
 *   node e2e/auto-fix-loop.mjs --source live          # fix failures from live-report.json
 *   node e2e/auto-fix-loop.mjs --source crawler        # fix failures from crawler-report.json
 *   node e2e/auto-fix-loop.mjs --source playwright     # fix failures from Playwright JSON report
 *   node e2e/auto-fix-loop.mjs --report path/to/report.json
 *   node e2e/auto-fix-loop.mjs --source live --dry-run  # show diffs without applying
 *   node e2e/auto-fix-loop.mjs --source live --max-retries 5
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

import { parseReport, buildFixPrompt, resolveFilePath } from './helpers/fix-prompt-builder.js';
import { applyDiff } from './helpers/patch-applier.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ── CLI Args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return defaultVal;
  return args[idx + 1] || defaultVal;
}
const hasFlag = (name) => args.includes(`--${name}`);

const SOURCE = getArg('source', 'live');
const REPORT_PATH = getArg('report', null);
const DRY_RUN = hasFlag('dry-run');
const MAX_RETRIES = parseInt(getArg('max-retries', '3'), 10);
const MAX_FAILURES = parseInt(getArg('max-failures', '10'), 10);
const RUN_TESTS_FIRST = hasFlag('run-first');
const VERBOSE = hasFlag('verbose');

// ── Env ─────────────────────────────────────────────────────────────────────

function readEnvVar(varName) {
  try {
    const content = fs.readFileSync(path.join(PROJECT_ROOT, '.env.local'), 'utf8');
    const m = content.match(new RegExp(`^${varName}=(.+)$`, 'm'));
    return m ? m[1].trim() : null;
  } catch { return null; }
}

const DEEPSEEK_API_KEY = process.env.VITE_DEEPSEEK_API_KEY || readEnvVar('VITE_DEEPSEEK_API_KEY');
const DEEPSEEK_BASE_URL = process.env.VITE_DI_DEEPSEEK_BASE_URL || readEnvVar('VITE_DI_DEEPSEEK_BASE_URL') || 'https://api.deepseek.com';
const DEEPSEEK_MODEL = process.env.VITE_DI_DEEPSEEK_MODEL || readEnvVar('VITE_DI_DEEPSEEK_MODEL') || 'deepseek-chat';

// ── Logging ─────────────────────────────────────────────────────────────────

const log = (msg) => console.log(`[autofix] ${msg}`);
const warn = (msg) => console.warn(`[autofix] ⚠ ${msg}`);
const err = (msg) => console.error(`[autofix] ✗ ${msg}`);

// ── LLM Call ────────────────────────────────────────────────────────────────

async function callLLM(prompt) {
  if (!DEEPSEEK_API_KEY) {
    throw new Error('No VITE_DEEPSEEK_API_KEY — cannot call LLM for auto-fix');
  }

  const resp = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 4096,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`DeepSeek API ${resp.status}: ${text.slice(0, 300)}`);
  }

  const json = await resp.json();
  return json.choices?.[0]?.message?.content || '';
}

// ── Report resolution ───────────────────────────────────────────────────────

function resolveReportPath() {
  if (REPORT_PATH) return REPORT_PATH;

  const reportMap = {
    live: path.join(__dirname, 'live-report.json'),
    crawler: path.join(__dirname, 'crawler-report.json'),
    playwright: path.join(PROJECT_ROOT, 'test-results', 'report.json'),
  };

  const p = reportMap[SOURCE];
  if (!p) throw new Error(`Unknown source: ${SOURCE}. Use live, crawler, or playwright.`);
  if (!fs.existsSync(p)) throw new Error(`Report not found: ${p}\nRun tests first or specify --report.`);
  return p;
}

// ── Run tests ───────────────────────────────────────────────────────────────

function runTests(source) {
  const cmdMap = {
    live: 'npm run test:live:ui-only',
    crawler: 'node e2e/auto-crawler.js',
    playwright: 'npx playwright test --reporter=json',
  };
  const cmd = cmdMap[source] || cmdMap.live;
  log(`Running: ${cmd}`);
  try {
    execSync(cmd, { cwd: PROJECT_ROOT, stdio: 'inherit', timeout: 300_000 });
    return true;
  } catch {
    return false;
  }
}

// ── Git safety ──────────────────────────────────────────────────────────────

function createSafetyBranch() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const branch = `autofix/${timestamp}`;
  try {
    execSync(`git stash push -m "autofix-safety-${timestamp}"`, { cwd: PROJECT_ROOT, stdio: 'pipe' });
    log(`Stashed current changes as autofix-safety-${timestamp}`);
  } catch {
    // Nothing to stash — that's fine
  }
  return branch;
}

// ── Extract diff from LLM response ─────────────────────────────────────────

function extractDiff(llmResponse) {
  // Try to find diff blocks in markdown fences
  const fenceMatch = llmResponse.match(/```(?:diff)?\n([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();

  // Try to find raw unified diff
  const diffMatch = llmResponse.match(/(---\s+a\/[\s\S]+?\+\+\+\s+b\/[\s\S]+?)(?=\n---\s+a\/|\n*$)/g);
  if (diffMatch) return diffMatch.join('\n\n');

  // If the response itself looks like a diff
  if (llmResponse.includes('--- a/') && llmResponse.includes('+++ b/')) {
    return llmResponse.trim();
  }

  return null;
}

// ── Main loop ───────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║          Auto-Fix Loop — AI-Powered Bug Repair      ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log();

  if (DRY_RUN) log('DRY RUN mode — diffs will be shown but not applied');

  // [1] Optionally run tests first
  if (RUN_TESTS_FIRST) {
    log('Step 1: Running tests...');
    runTests(SOURCE);
  }

  // [2] Parse report
  const reportPath = resolveReportPath();
  log(`Step 2: Parsing report: ${path.relative(PROJECT_ROOT, reportPath)}`);

  let failures;
  try {
    failures = parseReport(reportPath);
  } catch (e) {
    err(`Failed to parse report: ${e.message}`);
    process.exit(1);
  }

  if (failures.length === 0) {
    log('No failures found! All tests passed.');
    process.exit(0);
  }

  log(`Found ${failures.length} failure(s)`);
  if (failures.length > MAX_FAILURES) {
    warn(`Limiting to first ${MAX_FAILURES} failures (use --max-failures to change)`);
    failures = failures.slice(0, MAX_FAILURES);
  }

  // [3] Git safety
  if (!DRY_RUN) {
    createSafetyBranch();
  }

  // [4] Process each failure
  const results = [];

  for (let fi = 0; fi < failures.length; fi++) {
    const failure = failures[fi];
    console.log(`\n${'─'.repeat(60)}`);
    log(`Failure ${fi + 1}/${failures.length}: ${failure.name}`);
    log(`  Error: ${failure.error.slice(0, 200)}`);
    if (failure.file) log(`  File: ${failure.file}:${failure.line || '?'}`);

    let fixed = false;
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      log(`  Attempt ${attempt}/${MAX_RETRIES}...`);

      // Build prompt
      const { prompt, sourceFile } = buildFixPrompt(failure, PROJECT_ROOT);
      if (!sourceFile) {
        warn('  Could not resolve source file — sending prompt without source context');
      }

      // Call LLM
      let llmResponse;
      try {
        llmResponse = await callLLM(prompt);
      } catch (e) {
        err(`  LLM call failed: ${e.message}`);
        lastError = e.message;
        break; // Don't retry LLM errors
      }

      if (VERBOSE) {
        console.log('  LLM Response:\n' + llmResponse.slice(0, 2000));
      }

      // Extract diff
      const diffStr = extractDiff(llmResponse);
      if (!diffStr) {
        warn('  LLM did not return a valid unified diff');
        lastError = 'No valid diff in LLM response';
        continue;
      }

      // Apply diff
      const result = applyDiff(diffStr, { projectRoot: PROJECT_ROOT, dryRun: DRY_RUN });

      if (result.applied.length > 0) {
        log(`  Applied patches to: ${result.applied.join(', ')}`);

        if (DRY_RUN) {
          for (const d of result.diffs) {
            console.log(`\n  === Diff for ${d.file} ===`);
            // Show a simple before/after summary
            const beforeLines = d.before.split('\n').length;
            const afterLines = d.after.split('\n').length;
            console.log(`  Lines: ${beforeLines} → ${afterLines}`);
          }
          fixed = true;
          break;
        }

        // Re-run the test to verify
        log('  Verifying fix...');
        const testPassed = runTests(SOURCE);
        if (testPassed) {
          log('  Fix verified!');
          fixed = true;
          break;
        } else {
          warn('  Fix did not resolve the issue, continuing...');
          lastError = 'Patch applied but test still fails';
        }
      } else {
        warn(`  Patch application failed: ${result.failed.join(', ')}`);
        lastError = `Patch failed: ${result.failed.join(', ')}`;
      }
    }

    results.push({
      name: failure.name,
      source: failure.source,
      file: failure.file,
      error: failure.error.slice(0, 500),
      fixed,
      attempts: Math.min(MAX_RETRIES, results.length + 1),
      lastError: fixed ? null : lastError,
    });
  }

  // [5] Summary report
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  AUTO-FIX SUMMARY');
  console.log(`${'═'.repeat(60)}`);

  const fixedCount = results.filter(r => r.fixed).length;
  const failedCount = results.filter(r => !r.fixed).length;

  for (const r of results) {
    const icon = r.fixed ? '✓' : '✗';
    console.log(`  ${icon} ${r.name}${r.fixed ? '' : ` — ${r.lastError || 'unknown'}`}`);
  }

  console.log();
  log(`Fixed: ${fixedCount}/${results.length}`);
  if (failedCount > 0) log(`Failed: ${failedCount}/${results.length}`);
  if (DRY_RUN) log('(Dry run — no files were modified)');

  // [6] Write report
  const reportOut = {
    timestamp: new Date().toISOString(),
    source: SOURCE,
    dry_run: DRY_RUN,
    total_failures: failures.length,
    fixed: fixedCount,
    failed: failedCount,
    results,
  };

  const outPath = path.join(__dirname, 'autofix-report.json');
  fs.writeFileSync(outPath, JSON.stringify(reportOut, null, 2));
  log(`Report saved: ${path.relative(PROJECT_ROOT, outPath)}`);

  process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((e) => {
  err(`Fatal: ${e.message}`);
  if (VERBOSE) console.error(e.stack);
  process.exit(2);
});
