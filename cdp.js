const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');

const DEFAULT_PORT = 9222;
const WINDOWS_PATHS = [
  String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
  String.raw`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
  path.join(process.env.LOCALAPPDATA || '', String.raw`Google\Chrome\Application\chrome.exe`),
];
const MAC_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
];
const LINUX_PATHS = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];
// Looked up on PATH when none of the fixed locations exist.
const BINARY_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'];

function candidatePaths(platform = process.platform) {
  if (platform === 'win32') return WINDOWS_PATHS;
  if (platform === 'darwin') return MAC_PATHS;
  return LINUX_PATHS;
}

function isExecutable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scans PATH for a Chrome binary without shelling out to `which`.
 * @param {string} [pathEnv]
 * @returns {string | null}
 */
function findOnPath(pathEnv = process.env.PATH || '') {
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const name of BINARY_NAMES) {
      for (const ext of exts) {
        const file = path.join(dir, name + ext);
        if (isExecutable(file)) return file;
      }
    }
  }
  return null;
}

function findChromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  for (const p of candidatePaths()) {
    if (fs.existsSync(p)) return p;
  }
  const onPath = findOnPath();
  if (onPath) return onPath;
  throw new Error(
    'Chrome executable not found in standard install paths or on PATH. ' +
      'Set CHROME_PATH to the Chrome/Chromium binary.'
  );
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

  const chromePath = findChromePath();
  const userDataDir = defaultUserDataDir();

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--test-type',
  ];

  log(`[CDP] Launching Chrome: ${chromePath}`);
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
  findOnPath,
  defaultUserDataDir,
  checkCdpReady,
  connect: (opts) => require('./index').connect(opts),
  ChromeClient: require('./src/chrome-client'),
};
