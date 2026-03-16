import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenvConfig({ path: resolve(__dirname, '.env') });

function required(key) {
  const val = process.env[key];
  if (!val) {
    console.error(`❌ Missing required env var: ${key}`);
    process.exit(1);
  }
  return val;
}

export const config = {
  // Discord
  botToken: required('DISCORD_BOT_TOKEN'),
  allowedChannels: (process.env.DISCORD_ALLOWED_CHANNELS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  approvalChannelId: process.env.DISCORD_APPROVAL_CHANNEL_ID || '',

  // Supabase (for approval queue)
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',

  // Project
  projectRoot: process.env.DI_PROJECT_ROOT || resolve(__dirname, '..'),

  // Claude CLI path
  claudePath: process.env.CLAUDE_CLI_PATH ||
    resolve(process.env.HOME, '.windsurf/extensions/anthropic.claude-code-2.1.74-darwin-arm64/resources/native-binary/claude'),

  // Limits
  claudeTimeout: parseInt(process.env.CLAUDE_TIMEOUT || '300000', 10), // 5 min
  rateLimitPerUser: parseInt(process.env.RATE_LIMIT_SECONDS || '5', 10),
  approvalPollInterval: parseInt(process.env.APPROVAL_POLL_INTERVAL || '10000', 10), // 10s
};
