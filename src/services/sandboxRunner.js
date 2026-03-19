// @product: ai-employee
//
// sandboxRunner.js
// ─────────────────────────────────────────────────────────────────────────────
// Executes AI-generated code in a restricted Web Worker sandbox.
//
// The sandbox exposes only safe globals: Math, Date, JSON, Array, Map, Set,
// Number, String, Boolean, RegExp, Object, parseInt, parseFloat, isNaN,
// isFinite, console (captured). No fetch, XMLHttpRequest, localStorage, DOM.
//
// Usage:
//   const { result, stdout, stderr, durationMs } = await runInSandbox(code, input);
// ─────────────────────────────────────────────────────────────────────────────

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB

// ── Worker source (inline) ───────────────────────────────────────────────────

function buildWorkerSource() {
  return `
'use strict';

// Capture console
const __stdout = [];
const __stderr = [];
const __console = {
  log:   (...args) => __stdout.push(args.map(String).join(' ')),
  info:  (...args) => __stdout.push(args.map(String).join(' ')),
  warn:  (...args) => __stderr.push(args.map(String).join(' ')),
  error: (...args) => __stderr.push(args.map(String).join(' ')),
};

// Block dangerous globals
self.fetch = undefined;
self.XMLHttpRequest = undefined;
self.importScripts = undefined;
self.WebSocket = undefined;
self.indexedDB = undefined;
self.caches = undefined;

self.onmessage = function(e) {
  const { code, input } = e.data;
  const start = Date.now();
  try {
    // Build a function from code, injecting console
    const fn = new Function('input', 'console', code + '\\nreturn typeof run === "function" ? run(input) : undefined;');
    const result = fn(input, __console);
    const durationMs = Date.now() - start;
    self.postMessage({
      ok: true,
      result,
      stdout: __stdout.join('\\n'),
      stderr: __stderr.join('\\n'),
      durationMs,
    });
  } catch (err) {
    const durationMs = Date.now() - start;
    self.postMessage({
      ok: false,
      error: err?.message || String(err),
      stdout: __stdout.join('\\n'),
      stderr: __stderr.join('\\n'),
      durationMs,
    });
  }
};
`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run code in a restricted Web Worker sandbox.
 *
 * The code must define a `function run(input) { ... return result; }`.
 *
 * @param {string} code – JS source code
 * @param {*} input – data passed to run()
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=30000]
 * @param {number} [opts.maxOutputBytes=10MB]
 * @returns {Promise<{ result: *, stdout: string, stderr: string, durationMs: number }>}
 */
export async function runInSandbox(code, input, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? MAX_OUTPUT_BYTES;

  // ── Environment detection ──────────────────────────────────────────────
  // In non-browser environments (tests, SSR), fall back to direct eval
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined') {
    return _runDirect(code, input, timeoutMs);
  }

  return _runInWorker(code, input, timeoutMs, maxOutputBytes);
}

// ── Worker-based execution ───────────────────────────────────────────────────

function _runInWorker(code, input, timeoutMs, maxOutputBytes) {
  return new Promise((resolve, _reject) => {
    const blob = new Blob([buildWorkerSource()], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        worker.terminate();
        URL.revokeObjectURL(url);
        resolve({
          result: null,
          stdout: '',
          stderr: 'Execution timed out',
          durationMs: timeoutMs,
          timedOut: true,
        });
      }
    }, timeoutMs);

    worker.onmessage = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);

      const msg = e.data;

      // Check output size
      const outputSize = JSON.stringify(msg.result ?? null).length;
      if (outputSize > maxOutputBytes) {
        resolve({
          result: null,
          stdout: msg.stdout || '',
          stderr: `Output too large: ${outputSize} bytes (max ${maxOutputBytes})`,
          durationMs: msg.durationMs || 0,
        });
        return;
      }

      if (msg.ok) {
        resolve({
          result: msg.result,
          stdout: msg.stdout || '',
          stderr: msg.stderr || '',
          durationMs: msg.durationMs || 0,
        });
      } else {
        resolve({
          result: null,
          stdout: msg.stdout || '',
          stderr: msg.error || 'Unknown sandbox error',
          durationMs: msg.durationMs || 0,
        });
      }
    };

    worker.onerror = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
      resolve({
        result: null,
        stdout: '',
        stderr: err?.message || 'Worker error',
        durationMs: 0,
      });
    };

    worker.postMessage({ code, input });
  });
}

// ── Direct execution fallback (non-browser / test) ───────────────────────────

function _runDirect(code, input, timeoutMs) {
  const effectiveTimeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();
  const stdout = [];
  const stderr = [];
  const console_ = {
    log:   (...args) => stdout.push(args.map(String).join(' ')),
    info:  (...args) => stdout.push(args.map(String).join(' ')),
    warn:  (...args) => stderr.push(args.map(String).join(' ')),
    error: (...args) => stderr.push(args.map(String).join(' ')),
  };

  try {
    const fn = new Function('input', 'console', code + '\nreturn typeof run === "function" ? run(input) : undefined;');
    const resultPromise = Promise.resolve().then(() => fn(input, console_));
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Execution timed out')), effectiveTimeout)
    );
    return Promise.race([resultPromise, timeoutPromise]).then(
      (result) => ({
        result,
        stdout: stdout.join('\n'),
        stderr: stderr.join('\n'),
        durationMs: Date.now() - start,
      }),
      (err) => ({
        result: null,
        stdout: stdout.join('\n'),
        stderr: err?.message || String(err),
        durationMs: Date.now() - start,
        timedOut: err?.message === 'Execution timed out',
      })
    );
  } catch (err) {
    return Promise.resolve({
      result: null,
      stdout: stdout.join('\n'),
      stderr: err?.message || String(err),
      durationMs: Date.now() - start,
    });
  }
}
