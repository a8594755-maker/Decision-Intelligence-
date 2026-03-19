/**
 * LLM Record/Replay for E2E tests.
 *
 * Mode selection (env var LLM_REPLAY):
 *   - "record"  → intercept ai-proxy, forward to real endpoint, save response to fixture
 *   - "replay"  → intercept ai-proxy, return saved fixture (zero LLM tokens)
 *   - unset     → passthrough (no interception, same as before)
 *
 * Fixture files are stored in e2e/fixtures/llm-recordings/<test-name>/<seq>.json
 *
 * Usage:
 *   import { setupLlmReplay } from '../helpers/llm-replay.js';
 *   test.beforeEach(async ({ page }, testInfo) => { await setupLlmReplay(page, testInfo); });
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'llm-recordings');

function readEnvVar(varName) {
  try {
    const content = fs.readFileSync(path.join(__dirname, '..', '..', '.env.local'), 'utf8');
    const match = content.match(new RegExp(`^${varName}=(.+)$`, 'm'));
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL || readEnvVar('VITE_SUPABASE_URL') || '';

/**
 * Sanitise test title into a safe directory name.
 */
function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

/**
 * Build a short, stable key from the request so we can match recordings
 * to replays even if minor headers change between runs.
 */
function requestKey(method, url, postData) {
  // Strip the base Supabase URL so keys are portable
  const shortUrl = url.replace(SUPABASE_URL, '');
  // Include a hash of the body so different prompts get different recordings
  let bodyHash = '';
  if (postData) {
    // Simple djb2 hash — fast, deterministic, good enough for dedup
    let h = 5381;
    for (let i = 0; i < postData.length; i++) {
      h = ((h << 5) + h + postData.charCodeAt(i)) >>> 0;
    }
    bodyHash = h.toString(36);
  }
  // Sanitize for use as filename — replace path separators and special chars
  const safeUrl = shortUrl.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${method}_${safeUrl}_${bodyHash}`;
}

/**
 * Set up LLM record/replay interception on a Playwright page.
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').TestInfo} testInfo
 */
export async function setupLlmReplay(page, testInfo) {
  const mode = process.env.LLM_REPLAY; // 'record' | 'replay' | undefined
  if (!mode || !SUPABASE_URL) return; // passthrough

  const testSlug = slugify(testInfo.title);
  const fixtureDir = path.join(FIXTURES_DIR, testSlug);

  if (mode === 'record') {
    // Ensure fixture directory exists
    fs.mkdirSync(fixtureDir, { recursive: true });
    let seq = 0;

    await page.route(`${SUPABASE_URL}/functions/v1/ai-proxy`, async (route) => {
      // Let CORS preflight through without recording
      if (route.request().method() === 'OPTIONS') {
        return route.continue();
      }
      try {
        // Forward to real endpoint
        const response = await route.fetch();
        const status = response.status();
        const headers = response.headers();
        const body = await response.text();

        // Save recording
        const reqData = route.request().postData() || '';
        const key = requestKey(route.request().method(), route.request().url(), reqData);
        const recording = {
          seq: seq++,
          key,
          request: {
            method: route.request().method(),
            url: route.request().url().replace(SUPABASE_URL, '<SUPABASE_URL>'),
            postData: safeJsonParse(reqData),
          },
          response: {
            status,
            contentType: headers['content-type'] || 'application/json',
            body: safeJsonParse(body),
          },
          recordedAt: new Date().toISOString(),
        };

        const filePath = path.join(fixtureDir, `${String(seq - 1).padStart(3, '0')}_${key.slice(0, 40)}.json`);
        fs.writeFileSync(filePath, JSON.stringify(recording, null, 2));

        // Fulfill with the real response
        await route.fulfill({ status, headers, body });
      } catch (err) {
        // Page/context closed during in-flight request — safe to ignore
        if (err.message?.includes('closed') || err.message?.includes('disposed')) return;
        throw err;
      }
    });
  } else if (mode === 'replay') {
    // Load all recordings for this test
    if (!fs.existsSync(fixtureDir)) {
      console.warn(`[llm-replay] No recordings found for "${testInfo.title}" at ${fixtureDir}. Falling back to passthrough.`);
      return;
    }

    const files = fs.readdirSync(fixtureDir)
      .filter(f => f.endsWith('.json'))
      .sort();

    const recordings = files.map(f => JSON.parse(fs.readFileSync(path.join(fixtureDir, f), 'utf8')));

    // Build a map: key → [recordings] (in order, for repeated identical requests)
    const keyMap = new Map();
    for (const rec of recordings) {
      if (!keyMap.has(rec.key)) keyMap.set(rec.key, []);
      keyMap.get(rec.key).push(rec);
    }

    // Fallback: sequential replay if key matching fails
    let seqIndex = 0;

    await page.route(`${SUPABASE_URL}/functions/v1/ai-proxy`, async (route) => {
      // Let CORS preflight through
      if (route.request().method() === 'OPTIONS') {
        return route.continue();
      }
      const reqData = route.request().postData() || '';
      const key = requestKey(route.request().method(), route.request().url(), reqData);

      // Try key-matched replay first
      const bucket = keyMap.get(key);
      let recording;
      if (bucket && bucket.length > 0) {
        recording = bucket.shift(); // consume in order
      } else if (seqIndex < recordings.length) {
        // Fallback: sequential
        recording = recordings[seqIndex++];
      }

      if (recording) {
        const body = typeof recording.response.body === 'string'
          ? recording.response.body
          : JSON.stringify(recording.response.body);

        await route.fulfill({
          status: recording.response.status,
          contentType: recording.response.contentType,
          body,
        });
      } else {
        // No recording left — return a safe fallback
        console.warn(`[llm-replay] No recording for request #${seqIndex}: ${key.slice(0, 60)}`);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            choices: [{ message: { content: '[Replay exhausted — no more recorded responses]' } }],
          }),
        });
      }
    });
  }
}

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return str; }
}
