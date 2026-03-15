import { spawn } from 'child_process';
import { config } from './config.js';

/**
 * Call Claude Code CLI with a prompt and return the response.
 * Uses spawn instead of execFile for better control over stdio.
 */
export function askClaude(message) {
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

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
      console.log(`[Claude stderr] ${data.toString().trim()}`);
    });

    // Timeout
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Claude 回應超時，請縮短問題再試'));
    }, config.claudeTimeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Claude 執行錯誤 (exit ${code}): ${stderr.trim() || stdout.trim()}`));
        return;
      }
      const response = stdout.trim();
      if (!response) {
        reject(new Error('Claude 沒有回覆，請再試一次'));
        return;
      }
      resolve(response);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Claude 啟動失敗: ${err.message}`));
    });

    // Close stdin immediately
    child.stdin.end();
  });
}
