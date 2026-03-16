import { spawn } from 'child_process';
import { config } from './config.js';

/**
 * Call Claude Code CLI with a prompt and return the response.
 * Uses spawn instead of execFile for better control over stdio.
 *
 * @param {string} message - The prompt to send
 * @param {object} [opts] - Options
 * @param {(update: string) => void} [opts.onProgress] - Called periodically while waiting
 * @returns {Promise<string>} Claude's response
 */
export function askClaude(message, opts = {}) {
  const { onProgress, maxRetries = 1 } = opts;

  return _askClaudeOnce(message, opts).catch(async (err) => {
    // If timeout or CLI timeout message, retry once
    if (maxRetries > 0 && /超時|timed?\s*out|timeout/i.test(err.message)) {
      if (onProgress) onProgress('⏱️ 回應較慢，正在重試...');
      return _askClaudeOnce(message, { ...opts, maxRetries: 0 });
    }
    throw err;
  });
}

function _askClaudeOnce(message, opts = {}) {
  const { onProgress } = opts;

  return new Promise((resolve, reject) => {
    const systemPrompt = [
      '你正在 Discord 聊天環境中回覆。格式規則：',
      '1. Discord 不支援 Markdown 表格（| header | 語法），所有表格必須包在 ```code block``` 裡',
      '2. 用繁體中文回覆',
      '3. 保持回覆簡潔，Discord 單則訊息上限 2000 字',
      '4. 可以用 **粗體**、*斜體*、`行內code`、```code block```',
    ].join('\n');

    const args = [
      '-p', message,
      '--output-format', 'text',
      '--dangerously-skip-permissions',
      '--system-prompt', systemPrompt,
    ];

    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE;

    const child = spawn(config.claudePath, args, {
      cwd: config.projectRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let lastActivity = Date.now();
    let killed = false;

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      lastActivity = Date.now();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
      lastActivity = Date.now();
      console.log(`[Claude stderr] ${data.toString().trim()}`);
    });

    // --- Progress heartbeat: notify caller every 15s while waiting ---
    const progressMessages = [
      '💭 Claude 正在分析中...',
      '🔍 Claude 正在查閱專案資料...',
      '📊 Claude 正在整理回覆...',
      '⏳ 問題較複雜，Claude 仍在思考...',
      '🧠 Claude 深入分析中，請耐心等待...',
    ];
    let progressTick = 0;
    const progressInterval = onProgress
      ? setInterval(() => {
          const totalSec = Math.round((Date.now() - startTime) / 1000);
          const msg = progressMessages[Math.min(progressTick, progressMessages.length - 1)];
          onProgress(`${msg} (${totalSec}s)`);
          progressTick++;
        }, 15_000)
      : null;
    const startTime = Date.now();

    // --- Hard timeout: kill process after claudeTimeout ---
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      // Give 3s for graceful shutdown, then SIGKILL
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      // Return partial stdout if available instead of just erroring
      if (stdout.trim()) {
        resolve(stdout.trim() + `\n\n⏱️ _(回應在 ${elapsed}s 後被截斷，以上為部分結果)_`);
      } else {
        reject(new Error(`Claude 思考超過 ${elapsed} 秒仍未完成。這通常是因為問題較複雜，不需要縮短問題。請稍後再試，或嘗試分步詢問。`));
      }
    }, config.claudeTimeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (progressInterval) clearInterval(progressInterval);
      if (killed) return; // already resolved/rejected by timeout handler

      if (code !== 0) {
        reject(new Error(`Claude 執行錯誤 (exit ${code}): ${stderr.trim() || stdout.trim()}`));
        return;
      }
      let response = stdout.trim();
      if (!response) {
        reject(new Error('Claude 沒有回覆，請再試一次'));
        return;
      }
      // Intercept CLI-generated timeout messages that blame the user
      if (/超時.*縮短問題|timed?\s*out.*shorten/i.test(response)) {
        // Strip the unhelpful message and either return partial content or retry
        response = response.replace(/⚠️?\s*Claude\s*回應超時.*再試.*/g, '').trim();
        if (response) {
          resolve(response + '\n\n⏱️ _(部分回應，問題較複雜需要更多時間)_');
        } else {
          reject(new Error('Claude 正在處理較複雜的問題，需要更多時間。請稍後再試，不需要縮短問題。'));
        }
        return;
      }
      resolve(response);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (progressInterval) clearInterval(progressInterval);
      reject(new Error(`Claude 啟動失敗: ${err.message}`));
    });

    // Close stdin immediately
    child.stdin.end();
  });
}
