import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { askClaude } from './claudeCode.js';
import { formatForDiscord } from './messageFormatter.js';
import { handleInteraction } from './interactionHandler.js';
import { pollAndNotify, expireStaleApprovals } from './approvalService.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = resolve(__dirname, '.chat-history.json');

// ── Rate limiter ──
const userCooldowns = new Map();

function isRateLimited(userId) {
  const now = Date.now();
  const lastUsed = userCooldowns.get(userId) || 0;
  if (now - lastUsed < config.rateLimitPerUser * 1000) {
    return true;
  }
  userCooldowns.set(userId, now);
  return false;
}

// ── Conversation history (per-user, persisted to file) ──
let conversations = new Map();
const MAX_HISTORY = 10;

// Load history from file on startup
try {
  const data = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
  conversations = new Map(Object.entries(data));
  console.log(`📝 載入 ${conversations.size} 個用戶的對話紀錄`);
} catch { /* no history file yet */ }

function saveHistory() {
  const obj = Object.fromEntries(conversations);
  writeFileSync(HISTORY_FILE, JSON.stringify(obj), 'utf-8');
}

function getHistory(userId) {
  if (!conversations.has(userId)) {
    conversations.set(userId, []);
  }
  return conversations.get(userId);
}

function addToHistory(userId, role, content) {
  const history = getHistory(userId);
  history.push({ role, content: content.slice(0, 2000) });
  while (history.length > MAX_HISTORY * 2) {
    history.splice(0, 2);
  }
  saveHistory();
}

function clearHistory(userId) {
  conversations.delete(userId);
  saveHistory();
}

function buildPromptWithHistory(userId, message) {
  const history = getHistory(userId);
  if (history.length === 0) return message;

  const contextLines = history.map(h =>
    h.role === 'user' ? `User: ${h.content}` : `Assistant: ${h.content}`
  );
  return `以下是之前的對話紀錄：\n${contextLines.join('\n')}\n\n現在的問題：${message}`;
}

// ── Channel filter ──
function isAllowedChannel(channelId) {
  if (config.allowedChannels.length === 0) return true;
  return config.allowedChannels.includes(channelId);
}

// ── Bot setup ──
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [
    Partials.Channel,  // Required for DM support
    Partials.Message,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Bot 上線！登入為 ${c.user.tag}`);
  console.log(`📁 專案目錄: ${config.projectRoot}`);
  console.log(`🔧 Claude CLI: ${config.claudePath}`);
  if (config.allowedChannels.length > 0) {
    console.log(`🔒 限定頻道: ${config.allowedChannels.join(', ')}`);
  } else {
    console.log(`⚠️  未設定頻道限制，所有頻道都會回應`);
  }
});

client.on(Events.MessageCreate, async (message) => {
  console.log(`[DEBUG] 收到訊息: "${message.content}" from ${message.author.tag} isDM=${!message.guild}`);

  // Ignore bots
  if (message.author.bot) return;

  // Check if message is a DM or mentions the bot or starts with !di
  const isDM = !message.guild;
  const isMentioned = message.mentions.has(client.user);
  const hasPrefix = message.content.startsWith('!di ');
  const hasClearCmd = message.content.trim() === '!clear';

  if (!isDM && !isMentioned && !hasPrefix && !hasClearCmd) return;

  // Channel filter (skip for DMs)
  if (!isDM && !isAllowedChannel(message.channelId)) return;

  // Handle !clear
  if (hasClearCmd) {
    clearHistory(message.author.id);
    await message.reply('🗑️ 對話紀錄已清除');
    return;
  }

  // Rate limit
  if (isRateLimited(message.author.id)) {
    await message.reply(`⏳ 請等 ${config.rateLimitPerUser} 秒再發送下一則訊息`);
    return;
  }

  // Extract the actual question
  let question = message.content;
  if (hasPrefix) {
    question = question.slice(4).trim();
  } else if (isMentioned) {
    question = question.replace(/<@!?\d+>/g, '').trim();
  }

  if (!question) {
    await message.reply('請輸入你的問題，例如：`!di 這個專案的架構是什麼？`');
    return;
  }

  // Show typing indicator (repeat every 5s while waiting)
  const typingInterval = setInterval(() => {
    message.channel.sendTyping().catch(() => {});
  }, 5000);
  try { await message.channel.sendTyping(); } catch {}

  try {
    // Build prompt with conversation history
    const fullPrompt = buildPromptWithHistory(message.author.id, question);

    // Call Claude Code
    console.log(`[DEBUG] 呼叫 Claude CLI，問題: "${fullPrompt.slice(0, 100)}"`);
    const response = await askClaude(fullPrompt);
    console.log(`[DEBUG] Claude 回覆: "${response.slice(0, 100)}"`);

    // Save to history
    addToHistory(message.author.id, 'user', question);
    addToHistory(message.author.id, 'assistant', response);

    // Format and send
    const chunks = formatForDiscord(response);
    for (const chunk of chunks) {
      await message.reply(chunk);
    }
  } catch (err) {
    console.error('[DEBUG] Claude 呼叫失敗:', err.message, err.stack);
    await message.reply(`⚠️ ${err.message}`);
  } finally {
    clearInterval(typingInterval);
  }
});

// ── Start ──
console.log('🚀 正在啟動 Discord Bot...');
client.login(config.botToken).catch((err) => {
  console.error('❌ 登入失敗，請檢查 DISCORD_BOT_TOKEN:', err.message);
  process.exit(1);
});
