---
name: chrome-cdp
description: Chrome DevTools Protocol (CDP) automation skill for deep DOM auditing, raw network and WebSocket frame inspection, console debugging, V8 heap analysis, and source bundle extraction for web security, bug bounty, and reverse engineering.
license: ISC
---

# Chrome CDP Skill

A comprehensive Chrome DevTools Protocol (CDP) automation toolkit tailored for web auditing, security research, bug bounty, and reverse engineering. Built on `puppeteer-extra` stealth mode and direct low-level CDP domains (`Network`, `Debugger`, `Runtime`, `DOMDebugger`).

## Setup

Dependencies are already installed in this directory. If running in a fresh clone:

```bash
pnpm install
```

Start the Chrome CDP daemon (port 9222):
```bash
pnpm start
# or: node cdp.js
```

---

## Quick CLI Usage

You can invoke `cli.js` directly from bash for fast one-liner operations:

```bash
# Extract clean Markdown from an article or documentation page
node cli.js markdown https://example.com/article output.md

# Audit all forms, methods, actions, and hidden parameters on a page
node cli.js dump-forms https://target.com/login

# Dump localStorage, sessionStorage, and cookies
node cli.js dump-storage https://target.com/dashboard

# Audit DOM event listeners (find hidden click handlers, postMessage listeners)
node cli.js listeners https://target.com "window"
node cli.js listeners https://target.com "#submit-btn"

# Search for tokens, secret keys, or endpoints across all loaded JS bundles
node cli.js search-sources https://target.com "api_key"

# Download a matched JavaScript bundle to local disk
node cli.js download-bundle https://target.com "app.bundle" ./downloads/app.js

# Deobfuscate & unminify code using webcrack
node cli.js deobfuscate https://target.com "app.bundle" ./downloads/app.clean.js

# Unpack Webpack/Browserify modules into separate files
node cli.js unpack https://target.com "app.bundle" ./unpacked-src/

# Search structural AST patterns with ast-grep
node cli.js ast-search https://target.com "app.bundle" "fetch($URL, { $$$OPTS })"

# Record and inspect HTTP requests and live WebSocket connections
node cli.js traffic https://target.com --json

# Run a quick JavaScript expression on the active page
node cli.js eval "document.title"
```

---

## Programmatic Node.js API

For complex multi-step workflows, import the client in Node:

```javascript
const { connect } = require('./index');

async function main() {
  // Connects to Chrome on port 9222 (auto-launches Chrome if not running)
  const client = await connect({ port: 9222, autoLaunch: true });

  await client.goto('https://target.com', { waitUntil: 'networkidle2' });

  // Access dedicated controllers:
  // - client.dom       -> DOMController
  // - client.network   -> NetworkController
  // - client.websocket -> WebSocketController
  // - client.console   -> ConsoleController
  // - client.sources   -> SourceController
  // - client.workers   -> WorkerController
  // - client.debug     -> DebugController
  // - client.performance -> PerformanceController

  await client.closePage();
  client.disconnect();
}
```

---

## Root-Cause Debugging, Workers & Performance

```javascript
// Discover and evaluate dedicated, shared, and service workers.
console.log(client.workers.list());
const worker = client.workers.list()[0];
if (worker) console.log(await client.workers.evaluate(worker.id, 'self.location.href'));

// Pause page execution, set breakpoints, and inspect paused call frames.
await client.debug.enable({ pauseOnExceptions: true });
await client.debug.setBreakpoint('https://target.com/app.js', 120);
client.debug.on('paused', ({ callFrames, reason }) => console.log(reason, callFrames));
await client.debug.resume();

// Capture a Chrome trace and collect runtime metrics around a scenario.
await client.performance.startTrace();
const result = await client.performance.measure(() => performance.getEntriesByType('resource').length);
const trace = await client.performance.stopTrace();
require('fs').writeFileSync('./trace.json', trace);
console.log(result);
```

Use the trace to locate long tasks, script execution, layout/paint work, network wait, and CPU-heavy functions. Combine it with `client.console` and `client.network` evidence before claiming a root cause.

## Key Security & Reverse Engineering Workflows

### 1. Raw HTTP Traffic & Burp Suite Repeater Export
Capture raw unnormalized headers (including `:path`, `:authority`, `:method`), raw request POST payloads, and format requests into standard RFC 7230 text:

```javascript
const traffic = client.network.getTraffic({ method: 'POST' });
if (traffic.length > 0) {
  // Lấy raw request text để copy thẳng vào Burp Suite Repeater
  const burpRequest = await client.network.toRawRequest(traffic[0].id);
  console.log(burpRequest);

  // Lấy raw response text
  const rawResponse = await client.network.toRawResponse(traffic[0].id);
  console.log(rawResponse);
}

// Tìm kiếm token xuyên suốt toàn bộ URL, request body, headers
const matches = client.network.searchTraffic(/bearer|auth_token/i);
```

### 2. WebSocket Frame Inspection & Pattern Search
Intercept WebSocket handshake headers and all individual sent/received frames:

```javascript
const sockets = client.websocket.getSockets();
const frames = client.websocket.getFrames(sockets[0].requestId, {
  direction: 'sent',
  jsonOnly: true,
});

// Search across all WebSocket frames across all connections
const hits = client.websocket.searchFrames('challenge_token');
hits.forEach(({ url, frame }) => {
  console.log(`[${frame.direction}] ${url}:`, frame.payloadData);
});
```

### 3. DOM Security Audit & Parameter Discovery
Extract form actions, CSRF tokens, hidden inputs, and audit event listeners via CDP `DOMDebugger`:

```javascript
// 1. Cào endpoints và tham số form
const forms = await client.dom.dumpForms();

// 2. Cào input hidden và CSS-hidden elements
const hiddenInputs = await client.dom.dumpHiddenInputs();

// 3. Truy vết file JS và dòng code của event listener
const clickListeners = await client.dom.getEventListeners('#checkout-btn');
console.log(`Handler registered at scriptId ${clickListeners[0].scriptId}, line ${clickListeners[0].lineNumber}`);

// 4. Audit PostMessage listeners
const winListeners = await client.dom.getEventListeners('window');
const messageHandlers = winListeners.filter(l => l.type === 'message');
```

### 4. Reverse Engineering Script Bundles (webcrack & ast-grep)
Search across all loaded bundles in memory, deobfuscate obfuscator.io / webpack code, unpack bundle modules, and search code structures via AST patterns:

```javascript
// 1. Tìm vị trí chuỗi hoặc regex trong toàn bộ scripts (CDP Debugger search)
const searchResults = await client.sources.searchInSources(/jwt_secret|api_endpoint/i);

// 2. Deobfuscate & unminify code bằng webcrack
const deobf = await client.sources.deobfuscateBundle(searchResults[0].scriptId);
console.log('Clean code preview:', deobf.code.slice(0, 300));

// 3. Unpack Webpack / Browserify bundle ra các file module riêng biệt
await client.sources.unpackBundle(searchResults[0].scriptId, './unpacked-modules/');

// 4. Tìm kiếm cấu trúc AST bằng ast-grep (ví dụ: tìm mọi lệnh fetch hoặc axios)
const apiCalls = await client.sources.searchAst(searchResults[0].scriptId, 'fetch($URL, { $$$OPTS })');
apiCalls.forEach(call => {
  console.log('Target URL AST match:', call.metaMatches.URL);
});
```

### 5. V8 Heap Inspection & Call Stack Traces
Query in-memory class instances directly from the V8 heap and capture deep call stacks:

```javascript
// 1. Quét toàn bộ instance của một class trong V8 heap
const activeSessions = await client.console.queryObjects('UserSession.prototype');

// 2. Soi properties của object phức tạp không lo lỗi JSON serialization
const props = await client.console.inspectObject('window.AppConfig');

// 3. Đọc console logs kèm full call stack (hàm nào gọi hàm nào, dòng, cột)
const errorLogs = client.console.getLogs({ type: 'error', hasStackTrace: true });
```

### 6. Clean Content Extraction to Markdown
Extract clean article content stripping navigation, headers, and ads using Mozilla Readability and convert to GitHub Flavored Markdown (GFM):

```javascript
const article = await client.toMarkdown();
console.log(article.title);
console.log(article.markdown);
```
