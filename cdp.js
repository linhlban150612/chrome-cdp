const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');

const DEFAULT_PORT = 9222;
/**
 * Resolves the browser to launch: CHROME_PATH when set, otherwise the CloakBrowser
 * stealth Chromium (downloaded and cached on first use by the `cloakbrowser` package).
 * @returns {Promise<string>}
 */
async function findChromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const { ensureBinary } = await import('cloakbrowser');
  return ensureBinary();
}

/**
 * CloakBrowser's own launch flags (fingerprint seed, platform). Skipped for a CHROME_PATH
 * override, which may be a stock Chrome that does not understand them.
 * @returns {Promise<string[]>}
 */
async function stealthArgs() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return [];
  const { getDefaultStealthArgs } = await import('cloakbrowser');
  return getDefaultStealthArgs();
}

/**
 * Where the automation profile lives when CHROME_USER_DATA_DIR is unset. Kept out of
 * os.tmpdir() so logins survive a reboot, and away from the user's real profile.
 * @param {{ platform?: string, env?: NodeJS.ProcessEnv, home?: string }} [options]
 * @returns {string}
 */
function defaultUserDataDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (env.CHROME_USER_DATA_DIR) return env.CHROME_USER_DATA_DIR;
  if (platform === 'win32') {
    return path.win32.join(env.LOCALAPPDATA || os.tmpdir(), 'Google', 'Chrome', 'AutomationProfile');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'chrome-cdp', 'profile');
  }
  const dataHome = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(dataHome, 'chrome-cdp', 'profile');
}

function checkCdpReady(port = DEFAULT_PORT) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function waitForCdp(port = DEFAULT_PORT, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = await checkCdpReady(port);
    if (info) return info;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for Chrome CDP on port ${port}`);
}

async function startChrome(options = {}) {
  const port = options.port || Number(process.env.CDP_PORT) || DEFAULT_PORT;
  // Callers that own stdout (e.g. `har -`) route launch chatter elsewhere.
  const log = options.log || console.log;
  const existing = await checkCdpReady(port);
  if (existing) {
    log(`[CDP] Chrome is already running with CDP on port ${port}`);
    log(`[CDP] Browser: ${existing.Browser}`);
    log(`[CDP] WebSocket: ${existing.webSocketDebuggerUrl}`);
    return existing;
  }

  const chromePath = await findChromePath();
  const userDataDir = defaultUserDataDir();

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--test-type',
    ...(await stealthArgs()),
  ];

  log(`[CDP] Launching browser: ${chromePath}`);
  log(`[CDP] User data dir: ${userDataDir}`);
  log(`[CDP] Args: ${args.join(' ')}`);

  const child = spawn(chromePath, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  log(`[CDP] Spawned Chrome (PID: ${child.pid}). Waiting for CDP endpoint...`);
  const info = await waitForCdp(port);

  log(`[CDP] Ready!`);
  log(`[CDP] Browser: ${info.Browser}`);
  log(`[CDP] WebSocket: ${info.webSocketDebuggerUrl}`);
  return info;
}

if (require.main === module) {
  startChrome().catch((err) => {
    console.error(`[CDP] Failed:`, err.message);
    process.exitCode = 1;
  });
}

module.exports = {
  startChrome,
  findChromePath,
  defaultUserDataDir,
  checkCdpReady,
  connect: (opts) => require('./index').connect(opts),
  ChromeClient: require('./src/chrome-client'),
};
