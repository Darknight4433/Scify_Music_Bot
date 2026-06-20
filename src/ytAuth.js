/**
 * ytAuth.js — YouTube OAuth2 device-code login via yt-dlp.
 *
 * yt-dlp has built-in Google/YouTube OAuth2 support.
 * When triggered, yt-dlp prints a URL + code the user enters on google.com/device.
 * After login, yt-dlp caches the token in its own config dir (~/.cache/yt-dlp/).
 * All future yt-dlp calls automatically use the cached token.
 *
 * No cookies file needed after this!
 */

import { execFile, spawn } from 'node:child_process';
import { promisify }       from 'node:util';
import { createRequire }   from 'node:module';
import path                from 'node:path';
import process             from 'node:process';

const execFileAsync = promisify(execFile);
const require       = createRequire(import.meta.url);

function resolveYtDlpPath() {
  try {
    const pkgJson = require.resolve('youtube-dl-exec/package.json');
    const pkgDir  = path.dirname(pkgJson);
    const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    return path.join(pkgDir, 'bin', binName);
  } catch {
    return 'yt-dlp'; // fall back to PATH
  }
}

const YT_DLP = resolveYtDlpPath();

// A harmless YouTube video we use to trigger the OAuth flow
const TEST_VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

let authProcess = null;

/**
 * Start the YouTube OAuth device-code flow.
 *
 * Spawns yt-dlp with --username oauth2 and captures its stdout to extract
 * the verification URL + user code that yt-dlp prints.
 *
 * @returns {Promise<{ verificationUrl: string, userCode: string }>}
 */
export async function startYouTubeLogin() {
  return new Promise((resolve, reject) => {
    // Kill any existing auth attempt
    if (authProcess) {
      authProcess.kill();
      authProcess = null;
    }

    const args = [
      '--username', 'oauth2',
      '--password', '',
      '--skip-download',
      '--quiet',
      '--no-warnings',
      TEST_VIDEO,
    ];

    authProcess = spawn(YT_DLP, args, { windowsHide: true });

    let output = '';
    let resolved = false;

    function tryParse(text) {
      if (resolved) return;
      // yt-dlp prints something like:
      // "Please open https://www.google.com/device and enter code XXXX-XXXX"
      const urlMatch  = text.match(/https:\/\/www\.google\.com\/device/);
      const codeMatch = text.match(/code\s+([A-Z0-9]{4}-[A-Z0-9]{4})/i);

      if (urlMatch && codeMatch) {
        resolved = true;
        resolve({
          verificationUrl: 'https://www.google.com/device',
          userCode: codeMatch[1],
        });
      }
    }

    authProcess.stdout.on('data', (chunk) => {
      output += chunk.toString();
      tryParse(output);
    });

    authProcess.stderr.on('data', (chunk) => {
      output += chunk.toString();
      tryParse(output);
    });

    authProcess.on('close', (code) => {
      authProcess = null;
      if (!resolved) {
        if (code === 0) {
          // Completed without printing a code — already authenticated!
          resolve({ verificationUrl: null, userCode: null, alreadyAuth: true });
        } else {
          reject(new Error(`yt-dlp auth process exited with code ${code}.\nOutput: ${output.slice(0, 500)}`));
        }
      }
    });

    // Timeout after 30s if we never get the code
    setTimeout(() => {
      if (!resolved) {
        if (authProcess) authProcess.kill();
        reject(new Error('Timed out waiting for YouTube auth code. Is yt-dlp up to date?'));
      }
    }, 30_000);
  });
}

/**
 * Check if yt-dlp already has a cached YouTube OAuth token
 * by doing a quick info fetch. Returns true if authenticated.
 */
export async function checkYouTubeAuth() {
  try {
    await execFileAsync(YT_DLP, [
      '--username', 'oauth2',
      '--password', '',
      '--skip-download',
      '--quiet',
      '--no-warnings',
      '--print', 'title',
      TEST_VIDEO,
    ], { timeout: 15_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Cancel an in-progress auth flow.
 */
export function cancelYouTubeLogin() {
  if (authProcess) {
    authProcess.kill();
    authProcess = null;
  }
}
