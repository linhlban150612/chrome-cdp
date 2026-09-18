'use strict';

const ChromeClient = require('./src/chrome-client');
const DOMController = require('./src/dom-controller');
const NetworkController = require('./src/network-controller');
const WebSocketController = require('./src/websocket-controller');
const ConsoleController = require('./src/console-controller');
const SourceController = require('./src/source-controller');
const WorkerController = require('./src/worker-controller');
const DebugController = require('./src/debug-controller');
const PerformanceController = require('./src/performance-controller');
const { startChrome, findChromePath, defaultUserDataDir, checkCdpReady } = require('./cdp');
const { waitUntil, assertEventually, waitForEvent } = require('./src/waiting');

/**
 * Connects to an existing Chrome instance or launches one if not running.
 * @param {{
 *   port?: number,
 *   autoLaunch?: boolean,
 *   log?: (message: string) => void,
 *   browserURL?: string,
 *   browserWSEndpoint?: string,
 *   maxEntries?: number,
 *   maxFramesPerSocket?: number,
 *   maxSockets?: number,
 *   maxLogs?: number
 * }} [options]
 * @returns {Promise<ChromeClient>}
 */
async function connect(options = {}) {
  const port = options.port || 9222;

  if (options.autoLaunch !== false) {
    const isReady = await checkCdpReady(port);
    if (!isReady) {
      await startChrome({ port, log: options.log });
    }
  }

  return ChromeClient.connect(options);
}

module.exports = {
  ChromeClient,
  DOMController,
  NetworkController,
  WebSocketController,
  ConsoleController,
  SourceController,
  WorkerController,
  DebugController,
  PerformanceController,
  connect,
  waitUntil,
  assertEventually,
  waitForEvent,
  startChrome,
  findChromePath,
  defaultUserDataDir,
  checkCdpReady,
};

// Heavy (webcrack pulls in isolated-vm, ast-grep a native binary): load only on first use.
Object.defineProperty(module.exports, 'webcrack', {
  enumerable: true,
  get: () => require('webcrack').webcrack,
});
Object.defineProperty(module.exports, 'astGrep', {
  enumerable: true,
  get: () => require('@ast-grep/napi'),
});
