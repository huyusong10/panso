// 插件与上游源健康度监控 + 自动熔断器 (Circuit Breaker)

const FAILURE_THRESHOLD = 3;          // 连续失败 3 次触发熔断
const COOLDOWN_MS = 5 * 60 * 1000;    // 熔断冷却时间 5 分钟

const breakers = new Map();

function ensureEntry(id) {
  if (!breakers.has(id)) {
    breakers.set(id, {
      id,
      state: 'CLOSED', // CLOSED (正常) | OPEN (已熔断) | HALF_OPEN (探测恢复中)
      okCount: 0,
      failCount: 0,
      consecutiveFailures: 0,
      avgLatencyMs: 0,
      lastLatencyMs: 0,
      lastError: '',
      openedAt: 0,
      updatedAt: 0
    });
  }
  return breakers.get(id);
}

/**
 * 检查某个源当前是否允许发起请求
 */
export function canExecuteSource(id) {
  const entry = ensureEntry(id);
  if (entry.state === 'CLOSED') return true;

  if (entry.state === 'OPEN') {
    if (Date.now() - entry.openedAt >= COOLDOWN_MS) {
      entry.state = 'HALF_OPEN';
      return true;
    }
    return false;
  }

  // HALF_OPEN 允许放行一次探测请求
  return true;
}

/**
 * 记录源执行成功
 */
export function recordSourceSuccess(id, latencyMs) {
  const entry = ensureEntry(id);
  entry.state = 'CLOSED';
  entry.okCount++;
  entry.consecutiveFailures = 0;
  entry.lastLatencyMs = latencyMs;
  entry.avgLatencyMs = entry.avgLatencyMs
    ? Math.round(entry.avgLatencyMs * 0.7 + latencyMs * 0.3)
    : latencyMs;
  entry.lastError = '';
  entry.updatedAt = Date.now();
}

/**
 * 记录源执行失败
 */
export function recordSourceFailure(id, latencyMs, errorMsg = '') {
  const entry = ensureEntry(id);
  entry.failCount++;
  entry.consecutiveFailures++;
  entry.lastLatencyMs = latencyMs;
  entry.lastError = String(errorMsg || 'Error').slice(0, 120);
  entry.updatedAt = Date.now();

  if (entry.state === 'HALF_OPEN' || entry.consecutiveFailures >= FAILURE_THRESHOLD) {
    entry.state = 'OPEN';
    entry.openedAt = Date.now();
  }
}

/**
 * 获取所有源的健康度矩阵快照
 */
export function getHealthMatrix() {
  const out = {};
  for (const [id, entry] of breakers.entries()) {
    const cooldownRemainingSec =
      entry.state === 'OPEN'
        ? Math.max(0, Math.ceil((COOLDOWN_MS - (Date.now() - entry.openedAt)) / 1000))
        : 0;
    out[id] = {
      ...entry,
      cooldownRemainingSec
    };
  }
  return out;
}

/**
 * 手动重置所有熔断器状态
 */
export function resetAllBreakers() {
  breakers.clear();
}
