/**
 * proxy.js — Residential proxy pool management.
 *
 * Set YT_PROXY in .env as a comma-separated list of proxy URLs.
 * Supports: http, https, socks4, socks5
 *
 * Example:
 *   YT_PROXY=socks5://user:pass@host1:port,http://user:pass@host2:port
 *
 * If only one proxy is provided, it's used for every request.
 * If multiple are provided, they rotate round-robin with basic health tracking.
 */

import process from 'node:process';

const YT_PROXY = process.env.YT_PROXY || '';

// Parse comma-separated list of proxies
export const PROXY_POOL = YT_PROXY
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);

// Health tracking: { proxy -> { failures: number, lastFail: timestamp, cooldownUntil: timestamp } }
const health = new Map();
const COOLDOWN_MS = 60_000; // 1 min cooldown after 3 consecutive failures
const MAX_FAILURES = 3;

let currentIndex = 0;

/**
 * Get the next healthy proxy in the pool (round-robin).
 * Skips proxies that are in cooldown. Returns null if pool is empty or all are cooling down.
 */
export function getNextProxy() {
  if (PROXY_POOL.length === 0) return null;

  const now = Date.now();
  const poolSize = PROXY_POOL.length;

  // Try each proxy in the pool starting from currentIndex
  for (let i = 0; i < poolSize; i++) {
    const idx = (currentIndex + i) % poolSize;
    const proxy = PROXY_POOL[idx];
    const h = health.get(proxy);

    // Skip if in cooldown
    if (h && h.cooldownUntil > now) continue;

    // Found a usable proxy — advance the index past it for next call
    currentIndex = (idx + 1) % poolSize;
    return proxy;
  }

  // All proxies are in cooldown — just use the next one anyway (better than nothing)
  const fallback = PROXY_POOL[currentIndex];
  currentIndex = (currentIndex + 1) % poolSize;
  return fallback;
}

/**
 * Report a proxy as having succeeded. Resets its failure counter.
 */
export function reportSuccess(proxy) {
  if (!proxy) return;
  health.delete(proxy);
}

/**
 * Report a proxy as having failed. After MAX_FAILURES consecutive failures,
 * it goes into cooldown for COOLDOWN_MS.
 */
export function reportFailure(proxy) {
  if (!proxy) return;
  const h = health.get(proxy) || { failures: 0, lastFail: 0, cooldownUntil: 0 };
  h.failures += 1;
  h.lastFail = Date.now();

  if (h.failures >= MAX_FAILURES) {
    h.cooldownUntil = Date.now() + COOLDOWN_MS;
    h.failures = 0; // reset after cooldown is set
    console.warn(`[Proxy] ${proxy} put on cooldown for ${COOLDOWN_MS / 1000}s after ${MAX_FAILURES} failures`);
  }

  health.set(proxy, h);
}

/**
 * Get the full proxy pool (for logging/display).
 */
export function getProxyPool() {
  return [...PROXY_POOL];
}

/**
 * Get pool status for diagnostics.
 */
export function getPoolStatus() {
  const now = Date.now();
  return PROXY_POOL.map((proxy) => {
    const h = health.get(proxy);
    return {
      proxy,
      healthy: !h || h.cooldownUntil <= now,
      failures: h?.failures ?? 0,
      inCooldown: h ? h.cooldownUntil > now : false,
    };
  });
}
