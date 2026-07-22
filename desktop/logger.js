/**
 * logger.js — Structured timestamped logging module for Scify Music.
 *
 * Provides a createLogger() factory that returns a Logger instance with
 * info(), warn(), error() methods. Each log entry is formatted with an
 * ISO 8601 timestamp and severity level tag. Supports forwarding log
 * entries to the renderer via onLogEntry() callbacks.
 */

const MAX_MESSAGE_LENGTH = 4096;
const TRUNCATED_SUFFIX = '[truncated]';

/**
 * Sanitize a message string: replace newlines/carriage returns with spaces
 * to preserve single-line log format.
 * @param {string} message
 * @returns {string}
 */
function sanitize(message) {
  return String(message).replace(/\r\n|\r|\n/g, ' ');
}

/**
 * Truncate a message if it exceeds MAX_MESSAGE_LENGTH characters.
 * Appends [truncated] suffix when truncated.
 * @param {string} message
 * @returns {string}
 */
function truncate(message) {
  if (message.length <= MAX_MESSAGE_LENGTH) {
    return message;
  }
  return message.slice(0, MAX_MESSAGE_LENGTH - TRUNCATED_SUFFIX.length) + TRUNCATED_SUFFIX;
}

/**
 * Format a log entry into a single-line string.
 * Pattern: [2024-01-15T10:30:45.123Z] [INFO] Bot process started
 * @param {string} timestamp
 * @param {string} level
 * @param {string} message
 * @param {object} [context]
 * @returns {string}
 */
function formatEntry(timestamp, level, message, context) {
  let formatted = `[${timestamp}] [${level}] ${message}`;
  if (context && Object.keys(context).length > 0) {
    formatted += ' ' + JSON.stringify(context);
  }
  return formatted;
}

/**
 * Create a structured logger instance.
 *
 * @returns {{
 *   info: (message: string, context?: object) => void,
 *   warn: (message: string, context?: object) => void,
 *   error: (message: string, context?: object) => void,
 *   onLogEntry: (callback: (entry: import('./logger.js').LogEntry) => void) => void
 * }}
 */
export function createLogger() {
  /** @type {Array<(entry: object) => void>} */
  const listeners = [];

  /**
   * Register a callback to receive log entries.
   * @param {(entry: object) => void} callback
   */
  function onLogEntry(callback) {
    if (typeof callback === 'function') {
      listeners.push(callback);
    }
  }

  /**
   * Internal log method that formats, outputs, and notifies listeners.
   * @param {'INFO' | 'WARN' | 'ERROR'} level
   * @param {string} message
   * @param {object} [context]
   */
  function log(level, message, context) {
    const timestamp = new Date().toISOString();
    const sanitized = sanitize(message);
    const truncated = truncate(sanitized);

    const formatted = formatEntry(timestamp, level, truncated, context);

    // Output to console with appropriate method
    if (level === 'ERROR') {
      console.error(formatted);
    } else if (level === 'WARN') {
      console.warn(formatted);
    } else {
      console.log(formatted);
    }

    // Build log entry object for listeners
    const entry = {
      timestamp,
      level,
      message: truncated,
    };
    if (context !== undefined && context !== null) {
      entry.context = context;
    }

    // Notify all registered listeners
    for (const listener of listeners) {
      try {
        listener(entry);
      } catch {
        // Swallow listener errors to prevent logging from crashing the app
      }
    }
  }

  return {
    info(message, context) {
      log('INFO', message, context);
    },
    warn(message, context) {
      log('WARN', message, context);
    },
    error(message, context) {
      log('ERROR', message, context);
    },
    onLogEntry,
  };
}
