/**
 * recovery.js — Bot crash recovery module with circuit breaker for Scify Music.
 *
 * Provides a createRecoveryManager() factory that monitors the bot child process,
 * automatically restarts it after non-zero exit codes, and implements a circuit
 * breaker that stops restarts if too many crashes occur within a sliding window.
 */

/**
 * Create a crash recovery manager for the bot process.
 *
 * @param {object} options
 * @param {import('./logger.js').Logger} options.logger - Structured logger instance
 * @param {() => import('child_process').ChildProcess} options.spawnBot - Callback to spawn the bot process
 * @param {(status: string) => void} options.onStatusChange - Notify renderer of recovery events
 * @param {number} [options.crashThreshold=3] - Number of crashes to trip the circuit breaker
 * @param {number} [options.crashWindow=60000] - Sliding window duration in ms
 * @param {number} [options.restartDelay=3000] - Delay before restart in ms
 * @returns {{
 *   start: () => import('child_process').ChildProcess,
 *   stop: () => void,
 *   isCircuitOpen: () => boolean,
 *   getProcess: () => import('child_process').ChildProcess | null,
 *   handleExit: (code: number) => void
 * }}
 */
export function createRecoveryManager(options) {
  const {
    logger,
    spawnBot,
    onStatusChange,
    crashThreshold = 3,
    crashWindow = 60000,
    restartDelay = 3000,
  } = options;

  /** @type {number[]} Timestamps of recent crashes (sliding window) */
  let crashTimestamps = [];

  /** @type {import('child_process').ChildProcess | null} */
  let currentProcess = null;

  /** @type {ReturnType<typeof setTimeout> | null} */
  let restartTimeout = null;

  /**
   * Filter crash timestamps to only those within the sliding window,
   * then determine if the circuit breaker should be open.
   * @returns {boolean}
   */
  function isCircuitOpen() {
    const now = Date.now();
    crashTimestamps = crashTimestamps.filter(
      (ts) => now - ts <= crashWindow
    );
    return crashTimestamps.length >= crashThreshold;
  }

  /**
   * Get the current bot child process reference.
   * @returns {import('child_process').ChildProcess | null}
   */
  function getProcess() {
    return currentProcess;
  }

  /**
   * Handle bot process exit. Called when the bot process emits a 'close' event.
   * - Exit code 0: clean shutdown, no action taken.
   * - Non-zero exit code: record crash, check circuit breaker, schedule restart.
   * @param {number} code - The process exit code
   */
  function handleExit(code) {
    currentProcess = null;

    // Clean shutdown — do nothing
    if (code === 0) {
      return;
    }

    // Log the crash event with context
    logger.error('Bot crashed', {
      exitCode: code,
      timestamp: new Date().toISOString(),
    });

    // Record crash timestamp in the sliding window
    crashTimestamps.push(Date.now());

    // Check circuit breaker
    if (isCircuitOpen()) {
      logger.error('Circuit breaker opened — too many crashes', {
        crashCount: crashTimestamps.length,
        windowMs: crashWindow,
      });
      onStatusChange('circuit-open');
      return;
    }

    // Schedule restart after delay
    onStatusChange('restarting');
    restartTimeout = setTimeout(() => {
      restartTimeout = null;
      currentProcess = spawnBot();
      onStatusChange('restarted');
    }, restartDelay);
  }

  /**
   * Start the bot process and begin monitoring.
   * Calls spawnBot(), stores the process reference, and attaches the 'close'
   * event listener for crash detection.
   * @returns {import('child_process').ChildProcess}
   */
  function start() {
    currentProcess = spawnBot();
    currentProcess.on('close', handleExit);
    return currentProcess;
  }

  /**
   * Stop monitoring and kill the bot process.
   * Clears any pending restart timeout and kills the current process if running.
   */
  function stop() {
    // Clear any pending restart
    if (restartTimeout !== null) {
      clearTimeout(restartTimeout);
      restartTimeout = null;
    }

    // Kill the current process if it exists
    if (currentProcess) {
      currentProcess.kill();
      currentProcess = null;
    }

    // Reset crash history
    crashTimestamps = [];
  }

  return {
    start,
    stop,
    isCircuitOpen,
    getProcess,
    handleExit,
  };
}
