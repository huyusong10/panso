import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = path.join(__dirname, 'server.js');

let child = null;
let shuttingDown = false;
let restartCount = 0;
let lastStartTime = 0;

function startWorker() {
  if (shuttingDown) return;
  lastStartTime = Date.now();

  child = spawn(process.execPath, ['--max-old-space-size=512', SERVER_SCRIPT], {
    stdio: 'inherit',
    env: process.env
  });

  console.log(`[Daemon] 盘松守护进程已拉起工作节点 (PID: ${child.pid})`);

  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      process.exit(0);
    }
    const ranForSec = Math.round((Date.now() - lastStartTime) / 1000);
    // 如果稳定运行超过 2 分钟，重置重启计数
    if (ranForSec > 120) {
      restartCount = 0;
    } else {
      restartCount++;
    }
    const delayMs = Math.min(15000, 1500 * Math.pow(1.6, Math.min(restartCount, 6)));
    console.warn(
      `[Daemon] 工作节点退出 (code=${code}, signal=${signal}, 运行=${ranForSec}s)，将在 ${Math.round(delayMs)}ms 后自动自愈重启...`
    );
    setTimeout(startWorker, delayMs);
  });
}

// 定时健康巡检（每 60 秒探活一次，连续 3 次无响应则主动重启工作进程）
let failedPings = 0;
const healthTimer = setInterval(async () => {
  if (shuttingDown || !child) return;
  const port = getConfig().port || 3200;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal });
    clearTimeout(t);
    if (res.ok) {
      failedPings = 0;
      return;
    }
  } catch {
    // ignore single ping error
  }
  failedPings++;
  if (failedPings >= 3 && child) {
    console.warn('[Daemon] 连续 3 次健康探针超时，正在触发工作节点自愈重启...');
    failedPings = 0;
    try { child.kill('SIGTERM'); } catch {}
  }
}, 60 * 1000);
if (healthTimer.unref) healthTimer.unref();

function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Daemon] 收到 ${sig}，正在停止守护进程...`);
  if (child) {
    try { child.kill('SIGTERM'); } catch {}
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

startWorker();
