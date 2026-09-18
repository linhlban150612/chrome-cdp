# chrome-cdp API reference

Complete surface of `connect()` and its controllers. `SKILL.md` covers the common workflows; this file is the lookup table for everything else.

- [Getting a client](#getting-a-client)
- [client — page level](#client--page-level)
- [client.dom](#clientdom--domcontroller)
- [client.network](#clientnetwork--networkcontroller)
- [client.websocket](#clientwebsocket--websocketcontroller)
- [client.console](#clientconsole--consolecontroller)
- [client.sources](#clientsources--sourcecontroller)
- [client.debug](#clientdebug--debugcontroller)
- [client.workers](#clientworkers--workercontroller)
- [client.performance](#clientperformance--performancecontroller)
- [Shared conventions](#shared-conventions)
- [CLI commands](#cli-commands)

---

## Getting a client

```javascript
const { connect, waitForEvent, waitUntil, assertEventually, startChrome, findChromePath, defaultUserDataDir, checkCdpReady, webcrack, astGrep } = require('../index');
```

`connect(options)` → `Promise<ChromeClient>`

| Option | Default | Notes |
|---|---|---|
| `port` | `9222` | CDP port |
| `autoLaunch` | `true` | Launches Chrome if the port is not already answering |
| `log` | `console.log` | Where auto-launch messages go. Pass `console.error` when stdout carries data (JSON, HAR) |
| `browserURL` | `http://127.0.0.1:<port>` | Explicit HTTP endpoint |
| `browserWSEndpoint` | — | Attach by WebSocket URL instead of port |
| `autoEnableAll` | `true` | Starts network + websocket + console + sources recording on connect. Set `false` only if you want to enable them selectively |
| `protocolTimeout` | `30000` | Per-CDP-call timeout in ms. Raise it for `unpackBundle` / `deobfuscateBundle` on large bundles |
| `maxEntries` | `5000` | HTTP requests kept; oldest evicted first, counted in `network.droppedCount` |
| `maxFramesPerSocket` | `10000` | Frames kept per WebSocket; evictions counted in each socket's `droppedFrames` |
| `maxSockets` | `500` | WebSocket connections kept; evictions counted in `websocket.droppedSockets` |
| `maxLogs` | `5000` | Console entries kept; evictions counted in `console.droppedCount` |

`newPage()` inherits the buffer limits of the client it is called on unless it is passed its own.

`webcrack` and `astGrep` are lazy exports: they are only loaded the first time they (or `deobfuscateBundle` / `unpackBundle` / `searchAst`) are used.

`findChromePath()` checks `CHROME_PATH`, then the standard Windows, macOS, and Linux install paths, then `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, and `chrome` on `PATH`. `defaultUserDataDir()` returns the automation profile path (`CHROME_USER_DATA_DIR` overrides it).

### Waiting

Three primitives, following ch. 27 of *Growing Object-Oriented Software, Guided by Tests*. They share one bounded-wait engine; the names exist to keep synchronization and claims apart, because conflating them is how a wait that silently gave up gets reported as an observed absence.

| Function | Purpose | On timeout |
|---|---|---|
| `waitForEvent(emitter, eventName, options)` | **Listening.** Subscribe to `client.websocket` / `client.network` / `client.console` and return on the event itself | Resolves with the payloads collected so far |
| `waitUntil(fn, options)` | **Sampling, synchronization.** Poll for state with no event behind it | Returns the last value observed |
| `assertEventually(fn, options)` | **Sampling, claim.** The next thing you write depends on this being true | Throws with a diagnostic naming the condition and the last value |

Prefer `waitForEvent` when an event exists — it neither lags a poll interval behind nor misses a value that appeared and was replaced between two samples. Emitted events: `frame`, `frameSent`, `frameReceived`, `socketCreated`, `handshakeRequest`, `handshakeResponse`, `socketError`, `socketClosed` (websocket); `request`, `response`, `finished`, `failed` (network); `message`, `exception` (console).

| Option | Default | Applies to | Notes |
|---|---|---|---|
| `timeout` | `20000` | all | Every wait is bounded; there is no unbounded form on purpose |
| `every` | `300` | the sampling pair | Poll interval |
| `min` | `1` | the sampling pair | For array/string results, how many items count as ready. `{ min: 10 }` = "wait for enough frames to see the pattern" |
| `describe` | — | `assertEventually` | Names the condition in the thrown message |
| `count` | `1` | `waitForEvent` | How many payloads to collect |
| `where` | — | `waitForEvent` | Predicate to filter payloads, e.g. `(f) => f.direction === 'received'` |

Ready means truthy, and for anything with a `.length` at least `min` items.

**Proving a negative** needs a marker, not a long sleep. Wait for something the page reliably does that completes *after* the event you are checking for would have occurred, then report the absence together with the window it holds over: "no control frame across 630 frames / 76s", never "the server sends no PING". A predicate that cannot become true (`frames.length >= 100000` on a page that produces 700) is a fixed sleep in disguise and is worse than an honest one, because the next reader believes a condition was checked.

Also exported: `startChrome({ port, log })`, `findChromePath()`, `checkCdpReady(port)` (resolves the `/json/version` payload or `null`), plus the raw `webcrack` and `astGrep` modules if you want to run them on code you obtained some other way.

---

## client — page level

| Method | Returns | Notes |
|---|---|---|
| `newPage({ autoEnableAll })` | `ChromeClient` | New tab with its own CDP session and controllers; shares the worker tracker |
| `goto(url, options)` | navigation response or `null` | Defaults `waitUntil: 'domcontentloaded'`, `timeout: 15000`. Returns `null` instead of throwing when it times out but the DOM already parsed |
| `setViewport({ width, height, deviceScaleFactor, isMobile })` | — | Defaults 1280×800 desktop |
| `title()` / `content()` | `string` | Rendered title / full HTML |
| `screenshot({ path, fullPage })` | buffer | |
| `evaluate(expressionOrFn, ...args)` | value | Runs in page context |
| `toMarkdown(options)` | `{ title, markdown, ... }` | Readability + Turndown GFM |
| `toCheerio()` | CheerioAPI | Rendered DOM, not the raw served HTML |
| `toHar({ includeBodies = true })` | `{ log }` HAR 1.2 | All recorded requests plus WebSocket entries with `_webSocketMessages`. Call before `closePage()`. Missing bodies say why in `content.comment`; truncation lands in `log.comment` / `log._truncation`. Custom fields: `_resourceType`, `_initiator`, `_error` (failed request), `_droppedFrames` |
| `closePage()` | — | Closes this tab |
| `disconnect()` | — | Detaches, leaves Chrome running |
| `closeBrowser()` | — | Kills Chrome entirely |

Pair `closePage()` + `disconnect()` in a `finally`.

---

## client.dom — DOMController

**Interaction** (needed for anything behind a login or a click):

| Method | Notes |
|---|---|
| `click(selector, options)` | |
| `type(selector, text, options)` | Keystroke-by-keystroke; fires the events a real user would |
| `fill(selector, value)` | Sets the value directly — faster, but skips per-key handlers |
| `getValue(selector)` / `getText(selector)` | |
| `getAttribute(selector, attribute)` | |
| `getOuterHtml(selector)` / `getHtml()` | |
| `inspectElement(selector)` | Tag, attributes, computed box, position |
| `$(selector)` / `$$(selector)` | Raw puppeteer `ElementHandle` / handle array, for the cases the helpers above do not cover |

**Audit:**

| Method | Returns |
|---|---|
| `getEventListeners(target = 'window')` | Listeners via CDP `DOMDebugger`, each with `type`, `scriptId`, `lineNumber`, `columnNumber`, `useCapture`. `target` is a selector or the literal `'window'` |
| `dumpForms()` | Every form: action, method, and all inputs including hidden ones |
| `dumpHiddenInputs()` | `type=hidden` **and** CSS-hidden elements |
| `dumpStorage()` | `{ localStorage, sessionStorage }` |
| `hookPostMessage()` | Installs a `postMessage` + message-listener recorder. **Must be called before `goto()`** — it uses `evaluateOnNewDocument` and only affects subsequent loads |
| `getPostMessageLogs()` | `{ direction, origin/targetOrigin, data, timestamp }[]` |
| `toCheerio()` / `toMarkdown(options)` | Same as the page-level versions |

---

## client.network — NetworkController

| Method | Notes |
|---|---|
| `startRecording()` / `stopRecording()` / `clear()` | Recording is already on after `connect()` unless `autoEnableAll: false` |
| `getTraffic(filter)` | Filter: `url` (string/RegExp), `method`, `resourceType`, `status`, `failedOnly` |
| `getRequestPostData(query)` | Raw request body |
| `getResponseBody(query)` | Response body. Only available while the response is still in Chrome's buffer — fetch it before navigating away |
| `toRawRequest(query)` | RFC 7230 text with unnormalized headers, including `:method` / `:path` / `:authority`. Paste straight into Burp Repeater |
| `toRawResponse(query)` | Same, for the response |
| `searchTraffic(query)` | Scans URL + headers + bodies across every recorded request |
| `getCookies(urls)` | |
| `clearCache()` / `clearCookies()` | Useful to force a cold load |

`query` for the per-request methods is a `requestId` string, a URL substring, a RegExp, or `{ url }` / `{ requestId }`.

**Redirects.** Chrome reuses one `requestId` for a whole redirect chain, so each hop is recorded separately under the id `<requestId>:redirect:<n>` and the final hop keeps the bare `requestId`. This matters for login and OAuth flows: the request worth auditing is usually the one that redirected away, and it would otherwise be overwritten by its own destination. Each hop carries `redirectedFrom` / `redirectedTo` and the status that caused it, so `getTraffic({ method: 'POST' })` still finds the POST with its body and its `Set-Cookie` intact. `getResponseBody` throws on a redirect hop rather than answering: Chrome keeps no body for a redirect, and the underlying call would hand back the *final* hop's body under the earlier hop's id.

---

## client.websocket — WebSocketController

| Method | Notes |
|---|---|
| `startRecording()` / `stopRecording()` / `clear()` | |
| `getSockets(filter)` | Filter: `url`, `state` (`connecting` \| `open` \| `closed` \| `error`). Each socket carries handshake headers and its `frames` array |
| `getFrames(socketIdOrUrl, filter)` | Omit the first argument for all sockets. Filter: `direction` (`sent` \| `received`), `opcode`, `query`, `jsonOnly` (only frames that parsed as JSON — `frame.parsedJson` holds the object) |
| `searchFrames(query, { direction })` | `{ socketId, url, frame }[]` across every connection |

Frames only exist after the handshake, and many only appear in response to interaction. See the timing section in `SKILL.md`.

---

## client.console — ConsoleController

| Method | Notes |
|---|---|
| `startRecording()` / `stopRecording()` / `clear()` | |
| `getLogs(filter)` | Filter: `type` (`log`, `error`, `warning`, …), `query`, `hasStackTrace`. Entries carry the full call stack with file, line, and column |
| `evaluate(expressionOrFn, ...args)` | Via CDP `Runtime.evaluate`, returns the unwrapped value |
| `inspectObject(objectIdOrExpression, { ownProperties })` | Deep property dump that survives objects `JSON.stringify` chokes on (cycles, DOM nodes, functions) |
| `queryObjects(prototypeExpression)` | Every live instance of a class in the V8 heap, e.g. `'UserSession.prototype'`. The class must be reachable from the page's global scope |

---

## client.sources — SourceController

| Method | Notes |
|---|---|
| `enable()` / `disable()` / `clear()` | |
| `getScripts(filter)` | Filter: `url` (string/RegExp), `excludeInternal` (drops `pptr:` and `chrome-extension:`). Entries: `scriptId`, `url`, line/column range, `hash`, `sourceMapURL` |
| `getScriptSource(scriptIdOrUrl)` | `{ source, ... }` |
| `searchInSources(query, options)` | Chrome's own Ctrl+Shift+F index — fast across huge bundles. Options: `scriptId`, `caseSensitive`, `isRegex`, `excludeInternal`. Returns `{ scriptId, url, matches: [{ lineNumber, lineContent }] }[]`. Pass a RegExp directly and `isRegex` is inferred |
| `downloadBundle(scriptIdOrUrl, outputPath)` | `{ filePath, bytesWritten }` |
| `deobfuscateBundle(scriptIdOrUrl, options)` | webcrack: unminify, undo obfuscator.io string arrays, restore control flow. Returns `{ code }` |
| `unpackBundle(scriptIdOrUrl, outputDirectory, options)` | Splits webpack/browserify into one file per module. Returns `{ moduleCount, outputDirectory }` |
| `searchAst(scriptIdOrUrl, pattern, { deobfuscateFirst })` | ast-grep structural match. Returns `{ text, range, metaMatches }[]` where `metaMatches` maps each `$VAR` in the pattern to the matched source text. `deobfuscateFirst: true` runs webcrack before parsing — usually necessary on minified code, since the AST shape you are matching often only exists after unminification |

`scriptId` values are invalidated on navigation — the script table is cleared when the execution context resets. Re-run `searchInSources` after a `goto()` rather than reusing an old id.

---

## client.debug — DebugController

| Method | Notes |
|---|---|
| `enable({ pauseOnExceptions })` | |
| `setBreakpoint(url, lineNumber, columnNumber = 0, condition)` | `condition` is a JS expression — the breakpoint only fires when it is truthy |
| `removeBreakpoint(breakpointId)` | |
| `pause()` / `resume()` / `stepOver()` / `stepInto()` / `stepOut()` | |
| `evaluateOnCallFrame(callFrameId, expression, options)` | Reads locals and closure variables at the paused frame — the way to capture a value that exists for one tick |
| `disable()` | |

Emits `paused` with `{ callFrames, reason }`, and `client.debug.paused` holds that same payload (or `null`) if you would rather poll than subscribe. The page is frozen until `resume()`, so always resume — including on the error path.

---

## client.workers — WorkerController

| Method | Notes |
|---|---|
| `list()` | `{ id, type, url }[]` for dedicated, shared, and service workers |
| `info(item)` | |
| `evaluate(id, expression, options)` | Runs inside the worker's own scope, e.g. `'self.location.href'` |
| `close()` | Stops tracking |

Worth checking when a site's crypto or network code is not in the main bundle — service workers frequently hold the interesting request rewriting.

---

## client.performance — PerformanceController

| Method | Notes |
|---|---|
| `metrics()` | CDP `Performance.getMetrics` snapshot |
| `startTrace(options)` / `stopTrace()` | Returns Chrome trace JSON — load it in `chrome://tracing` or the DevTools Performance panel to find long tasks, layout thrash, and CPU-heavy frames |
| `measure(fn, ...args)` | Runs `fn` in the page and returns its result alongside timing |

---

## Shared conventions

- **String vs RegExp.** Anywhere a filter takes `query` or `url`, a string means substring match and a RegExp means `.test()`. There is no glob syntax.
- **Recording is cumulative.** `getTraffic()` and friends return everything since `connect()` or the last `clear()`, across navigations. Call `clear()` before the action you want to isolate.
- **Recording is bounded.** Each buffer keeps the newest items up to its cap (see `connect()` options) and counts what it evicted: `network.droppedCount`, `websocket.droppedSockets`, each socket's `droppedFrames`, `console.droppedCount`. A non-zero count means the capture was **truncated**, not that the data was absent. `clear()` resets the count.
- **`getResponseBody` is the exception to the above** — bodies live in Chrome's buffer, not in this library's memory, and disappear on navigation.
- **Everything is read-only against the target.** The controllers observe and extract; they do not modify requests in flight.

---

## CLI commands

`node cli.js --help` prints the authoritative list. Each command is a full connect → goto → act → closePage cycle.

| Command | Notes |
|---|---|
| `start` | Launch Chrome with remote debugging |
| `markdown <url> [destFile]` | Clean article text as GFM |
| `dump-forms <url>` | Forms + hidden inputs as JSON |
| `dump-storage <url>` | localStorage, sessionStorage, cookies |
| `listeners <url> [selector]` | Defaults to `window` |
| `search-sources <url> <query>` | Find the bundle before using the four commands below |
| `download-bundle <url> <queryOrId> <destFile>` | |
| `deobfuscate <url> <queryOrId> [destFile]` | Prints to stdout when `destFile` is omitted |
| `unpack <url> <queryOrId> <destDir>` | |
| `ast-search <url> <queryOrId> <pattern>` | |
| `screenshot <url> [destFile]` | `--viewport WxH`, `--fullPage` |
| `traffic <url> [--json]` | HTTP + WebSocket summary for the page load. JSON output carries a `truncation` object (`droppedRequests`, `droppedSockets`, `droppedFrames`) |
| `har <url> [destFile] [--no-bodies]` | HAR 1.2 export of the page load (waits for `networkidle2`). Defaults to `<host>.har`; `-` writes to stdout with launch logs moved to stderr |
| `eval <expression>` | Does **not** navigate — runs against the currently open tab |

Global flags: `--port <n>`, `--json`, `--help`.
