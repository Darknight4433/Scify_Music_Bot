// Properties 1, 2: Log output formatting and log routing by severity
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { createLogger } from '../logger.js';

/**
 * Property 1: Log output formatting
 * For any random message string and any severity level (INFO, WARN, ERROR),
 * the formatted output matches [YYYY-MM-DDTHH:mm:ss.sssZ] [LEVEL] message
 *
 * Validates: Requirements 8.1, 8.2
 */
describe('Property 1: Log output formatting', () => {
  const ISO8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const LOG_PATTERN = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\] \[(INFO|WARN|ERROR)\] (.*)$/;
  const LEVELS = ['INFO', 'WARN', 'ERROR'];
  const MAX_MESSAGE_LENGTH = 4096;

  let consoleSpy;

  beforeEach(() => {
    consoleSpy = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('formatted output matches [ISO8601] [LEVEL] message pattern for any message and level', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.constantFrom('INFO', 'WARN', 'ERROR'),
        (message, level) => {
          // Reset spies between iterations
          consoleSpy.log.mockClear();
          consoleSpy.warn.mockClear();
          consoleSpy.error.mockClear();

          const logger = createLogger();

          // Call the appropriate log method
          if (level === 'INFO') logger.info(message);
          else if (level === 'WARN') logger.warn(message);
          else logger.error(message);

          // Determine which console method was called
          const spy =
            level === 'ERROR' ? consoleSpy.error :
            level === 'WARN' ? consoleSpy.warn :
            consoleSpy.log;

          expect(spy).toHaveBeenCalledOnce();

          const output = spy.mock.calls[0][0];

          // Verify the output matches the expected pattern
          const match = output.match(LOG_PATTERN);
          expect(match).not.toBeNull();

          // Verify extracted level matches input level
          expect(match[2]).toBe(level);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('timestamp in console output is a valid ISO 8601 date', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.constantFrom('INFO', 'WARN', 'ERROR'),
        (message, level) => {
          consoleSpy.log.mockClear();
          consoleSpy.warn.mockClear();
          consoleSpy.error.mockClear();

          const logger = createLogger();

          if (level === 'INFO') logger.info(message);
          else if (level === 'WARN') logger.warn(message);
          else logger.error(message);

          const spy =
            level === 'ERROR' ? consoleSpy.error :
            level === 'WARN' ? consoleSpy.warn :
            consoleSpy.log;

          const output = spy.mock.calls[0][0];
          const match = output.match(LOG_PATTERN);
          expect(match).not.toBeNull();

          const timestamp = match[1];

          // Timestamp matches ISO 8601 format
          expect(timestamp).toMatch(ISO8601_REGEX);

          // Timestamp parses to a valid Date
          const parsed = new Date(timestamp);
          expect(parsed.getTime()).not.toBeNaN();

          // The parsed date re-serializes to the same string
          expect(parsed.toISOString()).toBe(timestamp);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('level tag in console output is one of [INFO], [WARN], [ERROR]', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.constantFrom('INFO', 'WARN', 'ERROR'),
        (message, level) => {
          consoleSpy.log.mockClear();
          consoleSpy.warn.mockClear();
          consoleSpy.error.mockClear();

          const logger = createLogger();

          if (level === 'INFO') logger.info(message);
          else if (level === 'WARN') logger.warn(message);
          else logger.error(message);

          const spy =
            level === 'ERROR' ? consoleSpy.error :
            level === 'WARN' ? consoleSpy.warn :
            consoleSpy.log;

          const output = spy.mock.calls[0][0];
          const match = output.match(LOG_PATTERN);
          expect(match).not.toBeNull();

          // Extracted level is one of the valid levels
          expect(LEVELS).toContain(match[2]);
          // And matches what we passed in
          expect(match[2]).toBe(level);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('messages with newlines are sanitized to single-line output', () => {
    // Generate strings that always include newline characters
    const messageWithNewlines = fc.tuple(fc.string(), fc.string(), fc.string()).map(
      ([a, b, c]) => a + '\n' + b + '\r\n' + c
    );

    fc.assert(
      fc.property(
        messageWithNewlines,
        fc.constantFrom('INFO', 'WARN', 'ERROR'),
        (message, level) => {
          consoleSpy.log.mockClear();
          consoleSpy.warn.mockClear();
          consoleSpy.error.mockClear();

          const logger = createLogger();

          if (level === 'INFO') logger.info(message);
          else if (level === 'WARN') logger.warn(message);
          else logger.error(message);

          const spy =
            level === 'ERROR' ? consoleSpy.error :
            level === 'WARN' ? consoleSpy.warn :
            consoleSpy.log;

          const output = spy.mock.calls[0][0];

          // The output should contain no newlines or carriage returns
          expect(output).not.toMatch(/[\r\n]/);

          // It should still match the log pattern (single line)
          const match = output.match(LOG_PATTERN);
          expect(match).not.toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('messages exceeding 4096 chars are truncated with [truncated] suffix', () => {
    // Generate strings guaranteed to exceed 4096 characters (no newlines to avoid confounding)
    const longMessage = fc.string({ minLength: 4097, maxLength: 8000 }).filter(
      (s) => !s.includes('\n') && !s.includes('\r')
    );

    fc.assert(
      fc.property(
        longMessage,
        fc.constantFrom('INFO', 'WARN', 'ERROR'),
        (message, level) => {
          consoleSpy.log.mockClear();
          consoleSpy.warn.mockClear();
          consoleSpy.error.mockClear();

          const logger = createLogger();

          if (level === 'INFO') logger.info(message);
          else if (level === 'WARN') logger.warn(message);
          else logger.error(message);

          const spy =
            level === 'ERROR' ? consoleSpy.error :
            level === 'WARN' ? consoleSpy.warn :
            consoleSpy.log;

          const output = spy.mock.calls[0][0];

          // Parse the output
          const match = output.match(LOG_PATTERN);
          expect(match).not.toBeNull();

          const outputMessage = match[3];

          // Message should be truncated to MAX_MESSAGE_LENGTH
          expect(outputMessage.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);

          // Should end with [truncated]
          expect(outputMessage.endsWith('[truncated]')).toBe(true);

          // The prefix before [truncated] should match the start of the original message
          const prefixLength = MAX_MESSAGE_LENGTH - '[truncated]'.length;
          expect(outputMessage.slice(0, prefixLength)).toBe(message.slice(0, prefixLength));
        }
      ),
      { numRuns: 100 }
    );
  });
});

/**
 * Property 2: Log routing by severity
 * Validates: Requirements 8.3, 8.4, 8.5
 *
 * For any bot process output string:
 * - stdout output → INFO severity
 * - stderr output → WARN severity
 * - crash/reconnect events → ERROR severity with context data
 */
describe('Property 2: Log routing by severity', () => {
  let consoleSpy;

  beforeEach(() => {
    consoleSpy = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stdout output is routed to INFO severity (console.log) for any random string', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (message) => {
        consoleSpy.log.mockClear();
        consoleSpy.warn.mockClear();
        consoleSpy.error.mockClear();

        const logger = createLogger();
        const entries = [];
        logger.onLogEntry((entry) => entries.push(entry));

        // Simulate stdout routing via logger.info()
        logger.info(message);

        expect(entries).toHaveLength(1);
        expect(entries[0].level).toBe('INFO');

        // Verify console.log was called (not warn or error)
        expect(consoleSpy.log).toHaveBeenCalledOnce();
        expect(consoleSpy.warn).not.toHaveBeenCalled();
        expect(consoleSpy.error).not.toHaveBeenCalled();
      }),
      { numRuns: 100 }
    );
  });

  it('stderr output is routed to WARN severity (console.warn) for any random string', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (message) => {
        consoleSpy.log.mockClear();
        consoleSpy.warn.mockClear();
        consoleSpy.error.mockClear();

        const logger = createLogger();
        const entries = [];
        logger.onLogEntry((entry) => entries.push(entry));

        // Simulate stderr routing via logger.warn()
        logger.warn(message);

        expect(entries).toHaveLength(1);
        expect(entries[0].level).toBe('WARN');

        // Verify console.warn was called (not log or error)
        expect(consoleSpy.warn).toHaveBeenCalledOnce();
        expect(consoleSpy.log).not.toHaveBeenCalled();
        expect(consoleSpy.error).not.toHaveBeenCalled();
      }),
      { numRuns: 100 }
    );
  });

  it('crash/reconnect events are routed to ERROR severity (console.error) with context data', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.integer({ min: 1, max: 255 }),
        fc.integer({ min: 0, max: 10 }),
        (message, exitCode, retryCount) => {
          consoleSpy.log.mockClear();
          consoleSpy.warn.mockClear();
          consoleSpy.error.mockClear();

          const logger = createLogger();
          const entries = [];
          logger.onLogEntry((entry) => entries.push(entry));

          // Simulate crash/reconnect event routing via logger.error() with context
          const context = { exitCode, retryCount };
          logger.error(message, context);

          expect(entries).toHaveLength(1);
          expect(entries[0].level).toBe('ERROR');
          expect(entries[0].context).toBeDefined();
          expect(entries[0].context.exitCode).toBe(exitCode);
          expect(entries[0].context.retryCount).toBe(retryCount);

          // Verify console.error was called (not log or warn)
          expect(consoleSpy.error).toHaveBeenCalledOnce();
          expect(consoleSpy.log).not.toHaveBeenCalled();
          expect(consoleSpy.warn).not.toHaveBeenCalled();
        }
      ),
      { numRuns: 100 }
    );
  });
});
