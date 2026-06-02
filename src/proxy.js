import process from 'node:process';

const YT_PROXY = process.env.YT_PROXY;

// Parse comma-separated list of proxies (supports http, https, socks4, socks5)
export const PROXY_POOL = YT_PROXY
  ? YT_PROXY.split(',').map((p) => p.trim()).filter(Boolean)
  : [];

let currentIndex = 0;

/**
 * Get the next proxy in the pool in round-robin order.
 * If the pool is empty, returns null.
 */
export function getNextProxy() {
  if (PROXY_POOL.length === 0) return null;
  const proxy = PROXY_POOL[currentIndex];
  currentIndex = (currentIndex + 1) % PROXY_POOL.length;
  return proxy;
}

/**
 * Get a random proxy from the pool.
 * If the pool is empty, returns null.
 */
export function getRandomProxy() {
  if (PROXY_POOL.length === 0) return null;
  const index = Math.floor(Math.random() * PROXY_POOL.length);
  return PROXY_POOL[index];
}

/**
 * Get all available proxies.
 */
export function getProxyPool() {
  return [...PROXY_POOL];
}
