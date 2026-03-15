import { askClaude } from './claudeCode.js';

console.log('[TEST] Starting claude test...');
try {
  const response = await askClaude('say hello in one word');
  console.log('[TEST] SUCCESS:', response);
  process.exit(0);
} catch (err) {
  console.error('[TEST] FAILED:', err.message);
  process.exit(1);
}
