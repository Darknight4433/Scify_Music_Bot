/**
 * reconnect.js — Auto-reconnect module for Scify Music.
 *
 * Monitors network connectivity and automatically reconnects the bot
 * when the network recovers after a disconnection. Uses exponential
 * backoff with configurable retry limits.
 *
 * The manager exposes triggerOffline()/triggerOnline() methods so that
 * the main process can forward network state from the renderer (which
 * has access to window 'online'/'offline' events) via IPC, or from
 * any other detection mechanism.
 *
 * Exports:
 *  - createReconnectManager(options) — factory for ReconnectManager instances
 *  - computeBackoffDelay(retryCount, baseDelay, maxDelay) — pure utility for testability
 */

/**
 * Compute the exponential backoff delay for a given retry count.
 * Formula: min(baseDelay * 2^retryCount, maxDelay)
 *
 * @param {number} retryCount - Current retry attempt (0-based)
 * @param {number} [baseDelay=5000] - Base delay in milliseconds
 * @param {number} [maxDelay=60000] - Maximum delay cap in milliseconds
 * @returns {number} Delay in milliseconds
 */
export function computeBackoffDelay(retryCount, baseDelay = 5000, maxDelay = 60000) {
  return Math.min(baseDelay * Math.pow(2, retryCount), maxDelay);
}

/**
 * Create an auto-reconnect manager that monitors network state
 * and attempts to reconnect the bot with exponential backoff.
 *
 * @param {object} options
 * @param {object} options.logger - Logger instance with info/warn/error methods
 * @param {(status: 'online' | 'offline' | 'reconnecting') => void} options.onStatusChange
 * @param {() => Promise<void>} options.onReconnect - Callback to restart bot + rejoin VC
 * @param {number} [options.maxRetries=5] - Maximum consecutive retry attempts
 * @param {number} [options.baseDelay=5000] - Base backoff delay in ms
 * @param {number} [options.maxDelay=60000] - Maximum backoff delay cap in ms
 * @returns {{
 *   start(): void,
 *   stop(): void,
 *   getStatus(): 'online' | 'offline' | 'reconnecting',
 *   triggerOffline(): void,
 *   triggerOnline(): void
 * }}
 */
export function createReconnectManager(options) {
  const {
    logger,
    onStatusChange,
    onReconnect,
    maxRetries = 5,
    baseDelay = 5000,
    maxDelay = 60000,
  } = options;

  /** @type {'online' | 'offline' | 'reconnecting'} */
  let status = 'online';
  let retryCount = 0;
  let retryTimeout = null;
  let started = false;

  /**
   * Update internal status, log the transition, and notify listener.
   * @param {'online' | 'offline' | 'reconnecting'} newStatus
   */
  function setStatus(newStatus) {
    if (status === newStatus) return;
    status = newStatus;
    onStatusChange(newStatus);
  }

  /**
   * Attempt to reconnect by calling onReconnect(). On success, reset
   * retry count and set status to online. On failure, schedule another
   * attempt with exponential backoff up to maxRetries.
   */
  async function attemptReconnect() {
    try {
      await onReconnect();
      // Success — connection restored
      retryCount = 0;
      logger.info('Network reconnection successful');
      setStatus('online');
    } catch (err) {
      retryCount++;

      if (retryCount >= maxRetries) {
        // Max retries exhausted — stop retrying, signal failure
        logger.error('Reconnection failed after maximum retries', {
          retryCount,
          maxRetries,
        });
        setStatus('offline');
        return;
      }

      // Schedule next attempt with exponential backoff
      const delay = computeBackoffDelay(retryCount, baseDelay, maxDelay);
      logger.warn('Reconnection attempt failed, retrying', {
        retryCount,
        nextDelay: delay,
        error: err.message || String(err),
      });

      retryTimeout = setTimeout(() => {
        retryTimeout = null;
        attemptReconnect();
      }, delay);
    }
  }

  /**
   * Handle network going offline.
   */
  function handleOffline() {
    if (status === 'offline' || status === 'reconnecting') return;
    logger.warn('Network connection lost');
    setStatus('offline');
  }

  /**
   * Handle network coming back online after being offline.
   */
  function handleOnline() {
    if (status === 'online') return;

    // Clear any pending retry timeout from a previous cycle
    if (retryTimeout) {
      clearTimeout(retryTimeout);
      retryTimeout = null;
    }

    retryCount = 0;
    logger.info('Network connection restored, attempting reconnect');
    setStatus('reconnecting');
    attemptReconnect();
  }

  return {
    /**
     * Begin monitoring network state. Initial status is 'online'.
     * After calling start(), use triggerOffline()/triggerOnline() to
     * feed network state changes from the renderer or other source.
     */
    start() {
      if (started) return;
      started = true;
      status = 'online';
      retryCount = 0;
      logger.info('Reconnect manager started');
    },

    /**
     * Stop monitoring, clear all pending timeouts, and reset state.
     */
    stop() {
      if (!started) return;
      started = false;

      if (retryTimeout) {
        clearTimeout(retryTimeout);
        retryTimeout = null;
      }

      retryCount = 0;
      status = 'online';
      logger.info('Reconnect manager stopped');
    },

    /**
     * Get the current network/reconnection status.
     * @returns {'online' | 'offline' | 'reconnecting'}
     */
    getStatus() {
      return status;
    },

    /**
     * Signal that the network has gone offline.
     * Typically called from main.js when the renderer reports
     * a window 'offline' event via IPC.
     */
    triggerOffline() {
      if (started) handleOffline();
    },

    /**
     * Signal that the network has come back online.
     * Typically called from main.js when the renderer reports
     * a window 'online' event via IPC.
     */
    triggerOnline() {
      if (started) handleOnline();
    },
  };
}
