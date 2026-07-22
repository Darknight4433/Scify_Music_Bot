/**
 * Property 2: Log routing by severity
 *
 * For any bot process output string, if it originates from stdout it SHALL be
 * logged with INFO severity, if it originates from stderr it SHALL be logged
 * with WARN severity, and if it represents a crash recovery or reconnect event
 * it SHALL be logged with ERROR severity including context data (exit code or
 * retry count).
 *
 * Validates: Requirements 8.3, 8.4, 8.5
 */

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { createLogger } from '../logger.js';

describe('Feature: desktop-app-enhancements, Property 2: Log routing by severity', () => {
  it('info() routes to console.log with [INFO] tag for any message', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 200 }), (message) => {
        const logger = createLogger();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        logger.info(message);

        // console.log must have been called (INFO routes to console.log)
        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();

        // Output must contain [INFO] tag
        const output = logSpy.mock.calls[0][0];
        expect(output).toContain('[INFO]');

        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }),
      { numRuns: 100 }
    );
  });

  it('warn() routes to console.warn with [WARN] tag for any message', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 200 }), (message) => {
        const logger = createLogger();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        logger.warn(message);

        // console.warn must have been called (WARN routes to console.warn)
        expect(logSpy).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy).not.toHaveBeenCalled();

        // Output must contain [WARN] tag
        const output = warnSpy.mock.calls[0][0];
        expect(output).toContain('[WARN]');

        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }),
      { numRuns: 100 }
    );
  });

  it('error() routes to console.error with [ERROR] tag for any message', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 200 }), (message) => {
        const logger = createLogger();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        logger.error(message);

        // console.error must have been called (ERROR routes to console.error)
        expect(logSpy).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledTimes(1);

        // Output must contain [ERROR] tag
        const output = errorSpy.mock.calls[0][0];
        expect(output).toContain('[ERROR]');

        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }),
      { numRuns: 100 }
    );
  });

  it('error() with context includes context JSON in output (crash/reconnect events)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -127, max: -1 }).chain((neg) =>
          fc.integer({ min: 1, max: 127 }).map((pos) => (Math.random() > 0.5 ? pos : neg))
        ),
        fc.nat({ max: 100 }),
        (exitCode, retryCount) => {
          // Ensure exitCode is non-zero
          const nonZeroExitCode = exitCode === 0 ? 1 : exitCode;

          const logger = createLogger();
          const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

          logger.error('Bot crashed', { exitCode: nonZeroExitCode, retryCount });

          expect(errorSpy).toHaveBeenCalledTimes(1);

          const output = errorSpy.mock.calls[0][0];

          // Output must contain [ERROR] tag
          expect(output).toContain('[ERROR]');

          // Output must contain the context data as JSON
          expect(output).toContain(JSON.stringify({ exitCode: nonZeroExitCode, retryCount }));

          errorSpy.mockRestore();
        }
      ),
      { numRuns: 100 }
    );
  });
});
