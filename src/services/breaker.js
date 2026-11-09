// 插件与上游源健康度监控 + 自适应指数退避熔断器 (Adaptive Circuit Breaker)

const FAILURE_THRESHOLD = 3; // 连续失败 3 次触发熔断
const BASE_COOLDOWN_MS = 60 * 1000; // 首次熔断冷却 60 秒
const MAX_COOLDOWN_MS = 5 * 60 * 1000; // 最大熔断冷却 5 分钟

const breakers = new Map();

function ensureEntry(id) {
  if (!breakers.has(id)) {
    if (breakers.size > 120) {
      const oldest = breakers.keys().next().value;
      breakers.delete(oldest);
    }
    breakers.set(id, {
      id,
      state: 'CLOSED', // CLOSED (正常) | OPEN (已熔断) | HALF_OPEN (单路探测恢复中)
      okCount: 0,
      failCount: 0,
      consecutiveFailures: 0,
      tripCount: 0,
      cooldownMs: BASE_COOLDOWN_MS,
      halfOpenProbing: false,
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
 * 检查某个源当前是否允许发起请求（并发安全：HALF_OPEN 严格只放行单路探测）
 */
export function canExecuteSource(id) {
  const entry = ensureEntry(id);
  if (entry.state === 'CLOSED') return true;

  if (entry.state === 'OPEN') {
    if (Date.now() - entry.openedAt >= entry.cooldownMs) {
      entry.state = 'HALF_OPEN';
      entry.halfOpenProbing = true;
      return true;
    }
    return false;
  }

  // HALF_OPEN 状态下，若已有探测请求在途，则其余并发请求快速跳过，防止惊群击穿
  if (entry.state === 'HALF_OPEN') {
    if (!entry.halfOpenProbing) {
      entry.halfOpenProbing = true;
      return true;
    }
    return false;
  }

  return true;
}

/**
 * 记录源执行成功
 */
export function recordSourceSuccess(id, latencyMs) {
  const entry = ensureEntry(id);
  entry.state = 'CLOSED';
  entry.halfOpenProbing = false;
  entry.okCount++;
  entry.consecutiveFailures = 0;
  entry.tripCount = Math.max(0, entry.tripCount - 1);
  entry.cooldownMs = BASE_COOLDOWN_MS;
  entry.lastLatencyMs = latencyMs;
  entry.avgLatencyMs = entry.avgLatencyMs
    ? Math.round(entry.avgLatencyMs * 0.7 + latencyMs * 0.3)
    : latencyMs;
  entry.lastError = '';
  entry.updatedAt = Date.now();
}

/**
 * 记录源执行失败（自适应退避冷却）
 */
export function recordSourceFailure(id, latencyMs, errorMsg = '') {
  const entry = ensureEntry(id);
  entry.failCount++;
  entry.consecutiveFailures++;
  entry.halfOpenProbing = false;
  entry.lastLatencyMs = latencyMs;
  entry.lastError = String(errorMsg || 'Error').slice(0, 120);
  entry.updatedAt = Date.now();

  if (entry.state === 'HALF_OPEN' || entry.consecutiveFailures >= FAILURE_THRESHOLD) {
    entry.state = 'OPEN';
    entry.tripCount = Math.min(6, (entry.tripCount || 0) + 1);
    entry.cooldownMs = Math.min(
      MAX_COOLDOWN_MS,
      BASE_COOLDOWN_MS * Math.pow(1.8, entry.tripCount - 1)
    );
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
        ? Math.max(0, Math.ceil((entry.cooldownMs - (Date.now() - entry.openedAt)) / 1000))
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
