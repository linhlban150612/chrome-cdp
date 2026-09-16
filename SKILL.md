---
name: chrome-cdp
description: Drive a real Chrome over the DevTools Protocol to audit a live page - dump forms and hidden inputs, capture raw HTTP and WebSocket frames for Burp, trace event listeners and postMessage handlers back to source, search and deobfuscate loaded JS bundles, query the V8 heap, and extract page content as Markdown. Use this whenever the question is about what a real site actually does at runtime rather than what its static HTML says - reverse engineering a signing or token algorithm, finding an undocumented API, replaying a request, auditing a login flow, inspecting a WebSocket protocol, unminifying a bundle, or debugging why a page behaves the way it does. Reach for it even when the user only says "look at this site", "how does this site do X", or "find the API behind this page" without naming Chrome, CDP, or DevTools.
license: ISC
---

# Chrome CDP

Toolkit for inspecting a **live** page: real Chrome, real JS execution, real network. Built on `puppeteer-extra` + stealth and raw CDP domains (`Network`, `Debugger`, `Runtime`, `DOMDebugger`).

Use it against targets you are authorized to test. It reads and records; it does not attack.

Every path below is relative to this skill's own directory — the one holding `SKILL.md`, `cli.js`, and `index.js`. Run commands from there.

---

## The one thing to understand first

One Chrome process listens on port 9222. `connect()` attaches to it, takes over an existing tab, and **immediately starts recording** network, WebSocket, console, and parsed scripts.

That ordering is the whole game:

```
connect()   <- recording starts here
  goto()    <- everything from this load is captured
  wait      <- late XHR / WS frames land here
  read      <- getTraffic(), getFrames(), getScripts()
```

Anything that happened before `connect()` is invisible. If you navigate first and connect second, you get nothing and it looks like a bug.

---

## CLI or script?

This is the decision that determines whether the task takes 20 seconds or 5 minutes of confused reloading.

Every `cli.js` command is a self-contained round trip: connect → goto → do one thing → **closePage** → disconnect. That is perfect for one question with one answer, and wrong for anything else, because the next command starts from a cold page with no login, no SPA route, and no recorded traffic.

**Use the CLI** when a single page load answers the question:

```bash
node cli.js dump-forms https://target.com/login
node cli.js traffic https://target.com --json
node cli.js search-sources https://target.com "api_key"
```

Full command list: `node cli.js --help`.

**Write a script** the moment the task needs a second look at the page. Three signals:

- *Chained lookups.* `deobfuscate`, `unpack`, `ast-search`, and `download-bundle` all take a `queryOrId` you only learn from `search-sources`. Doing that over the CLI reloads the page for every step; in a script it is one load.
- *State matters.* Log in, click through, change an SPA route, then inspect. The CLI throws that state away between commands.
- *Timing matters.* You need to interact and then read what the interaction produced.

Before you open the page at all, write down every question you want answered — including the follow-ups you can already see coming, and the edge cases you would otherwise go back for. One session can answer all of them; each extra page load costs a full navigation, re-records traffic you already had, and invalidates the `scriptId`s you were holding. The expensive mistake is not writing a script that turns out too big, it is discovering question six after you closed the page.

Note `cli.js eval` is the odd one out: it does **not** navigate, it evaluates against whatever tab is currently open. Since every other CLI command closes its page on exit, running `eval` after one of them hits a blank tab. Use it to poke at a page you opened yourself, otherwise put the expression in a script.

### Running a script

`require('../index')` resolves relative to the script file, so scratch scripts live **inside the skill directory**. Put them in `.tmp/` — that path is already gitignored — and delete them when done.

```javascript
// .tmp/probe.js
const { connect } = require('../index');

(async () => {
  const client = await connect({ port: 9222 });
  try {
    await client.goto('https://target.com');
    console.log(await client.title());
  } finally {
    await client.closePage();
    client.disconnect();
  }
})();
```

```bash
node .tmp/probe.js
```

Always `closePage()` + `disconnect()` in a `finally`. A leaked connection keeps the tab alive and the next run inherits a dirty page.

---

## Setup

Run `npm install` in the skill directory if `node_modules/` is not there yet — nothing works without it, and the failure mode is a bare `Cannot find module 'puppeteer-extra'`.

Chrome itself auto-launches on first `connect()`, so usually there is nothing else to do. To start it explicitly:

```bash
node cli.js start        # or: npm start
```

### When it does not work

| Symptom | Cause | Fix |
|---|---|---|
| `Chrome executable not found` | Chrome is not in a standard install path | Set `CHROME_PATH` to the chrome.exe path |
| Connects but you are logged out everywhere | Chrome runs a **separate** `AutomationProfile`, not your daily profile — by design, so automation never touches your real cookies | Log in once inside the automation browser (it persists), or point `CHROME_USER_DATA_DIR` at another profile **with your normal Chrome fully closed** — Chrome refuses to share a live profile directory |
| `ECONNREFUSED 127.0.0.1:9222` | Chrome died, or something else owns the port | `node cli.js start`, or pass `--port` / `{ port }` to use another |
| Page opens `chrome://newtab` and reads as empty | `connect()` reuses tab 0 and resets `chrome://` URLs to `about:blank` | Expected — just `goto()` your target |
| Hangs ~30s then `ProtocolError` | A CDP call exceeded the 30s protocol timeout | `connect({ protocolTimeout: 120000 })` for heavy work like `unpackBundle` on a big bundle |

---

## Timing: the trap that produces empty results

`goto()` defaults to `waitUntil: 'domcontentloaded'` with a 15s timeout, and deliberately swallows the timeout if the DOM already parsed. This keeps SPAs, games, and streaming sites from failing outright — but it means **`goto()` usually resolves while the page is still fetching.**

So reading immediately after `goto()` gives you the first few requests and nothing else. Empty `getFrames()` and half-empty `getTraffic()` almost always mean "read too early", not "nothing there".

Wait for the signal you actually care about — not for a number of seconds you guessed. Three primitives, and the choice between them is the whole point:

```javascript
const { connect, waitForEvent, waitUntil, assertEventually } = require('../index');
```

**Listen when you can.** The controllers emit `frame` / `frameSent` / `frameReceived` / `socketCreated` / `request` / `response`, so you can return on the event itself rather than on the next poll tick. Listening never lags behind the data and never misses a value that appeared and was replaced between two samples:

```javascript
const trades = await waitForEvent(client.websocket, 'frame', {
  count: 10,
  timeout: 30000,
  where: (f) => f.direction === 'received',
});
```

**Poll when there is no event** — a bundle parsed, the network going quiet, a DOM node appearing:

```javascript
await client.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
const bundle = await waitUntil(() => client.sources.getScripts({ url: /app\./ }));
```

**Say which one you mean.** `waitUntil` and `assertEventually` run the same loop; the names carry the intent, and that distinction is load-bearing. `waitUntil` *synchronizes* — on timeout it hands back whatever it saw, because seven captured frames are still seven frames. `assertEventually` *claims* — on timeout it throws with a diagnostic, because a claim that quietly returns an empty array is exactly how "the site sends no heartbeat" gets written about something that was never actually waited for:

```javascript
// I need this to be true before the next line means anything
await assertEventually(() => client.websocket.getSockets({ state: 'open' }), {
  describe: 'the market-data socket to open',
});

// I will take whatever arrived and report the real count
const frames = await waitUntil(() => client.websocket.getFrames(id), { min: 10, timeout: 30000 });
console.log(`captured ${frames.length} frames`);
```

Options: `{ timeout = 20000, every = 300, min = 1 }`. `min` is how you say "wait for enough frames to see the pattern" rather than "wait 30 seconds and hope".

### Proving a negative

"The server never sends a PING" is a much harder claim than it looks, and the tempting move — sleep 70 seconds, see nothing, conclude nothing is there — is wrong twice over. It makes every run slow even when it succeeds, and it cannot distinguish "the site does not do this" from "the site had not gotten around to it yet".

Do not dress a fixed sleep up as a condition either. `waitUntil(() => frames.length >= 100000, { timeout: 70000 })` on a page that produces 700 frames is a 70-second sleep wearing a costume — worse than an honest `setTimeout`, because the next reader thinks a real condition was checked.

Instead, wait for a **marker**: something you know the page does, that completes *after* the thing you are checking for would have happened. Then the absence is bounded by an event rather than by a guess:

```javascript
// Ten kline frames is roughly a minute of traffic — if a PING were coming, it came.
await waitUntil(() => client.websocket.getFrames(id, { direction: 'received' }), { min: 10 });

const control = client.websocket.getFrames(id).filter((f) => f.opcode === 9 || f.opcode === 10);
// Now the claim has a shape: not "there is no ping" but "no ping in this window".
console.log(`no control frames across ${frames.length} frames / ${windowSeconds}s`);
```

Report the window along with the absence. "No PING observed in 76s across 630 frames" is a fact a reader can act on; "the server sends no PING" is a guess that will strand whoever writes a client against it.

For WebSockets specifically, frames arrive *after* the handshake and often only in response to user action — connect, navigate, interact, **then** wait, then read.

`hookPostMessage()` has the opposite constraint: it installs via `evaluateOnNewDocument`, so it only affects loads that happen after it. **Call it before `goto()`.**

---

## Reading too late: response bodies expire

The timing trap has a mirror image. Everything this library records — URLs, headers, status, timings, WebSocket frames — lives in its own memory and survives the whole session. **Response bodies do not.** They stay in Chrome's network buffer, which Chrome evicts under memory pressure and clears on navigation. `getResponseBody()` reaches into that buffer, so it fails for anything Chrome has already thrown away.

So drain bodies as you capture them, not at the end:

```javascript
const captured = [];
for (const request of await waitUntil(() => client.network.getTraffic({ resourceType: 'XHR' }), { min: 5 })) {
  const body = await client.network.getResponseBody(request.id).catch(() => null);
  captured.push({ url: request.url, status: request.status, body });
}
```

The failure is quiet and it lands late. You scroll a page twenty times, collect thirty requests, then loop over them at the end and find the first few have bodies and the rest return an error string — by which time the page state that produced them is gone. Pull each body while its request is fresh, and if one comes back empty, say so in that row rather than leaving a `null` for a reader to misread as an empty response.

Two related habits worth the same discipline:

- **Stop driving the page once it tells you it is done.** A `has_next: false`, a spinner that disappears, an empty result array — that is the site's own stop condition. Firing ten more scroll events past it produces phantom requests that you then have to explain, or worse, silently report as real.
- **Check what your capture actually holds before you write about it.** One pass over the saved artifact answers it: `captured.filter((c) => !c.body).length` is the number you owe the reader.

---

## Workflows

### Replay a request in Burp
Raw, unnormalized headers including the HTTP/2 pseudo-headers (`:method`, `:path`, `:authority`) plus the raw body, formatted as RFC 7230 text.

```javascript
const posts = client.network.getTraffic({ method: 'POST' });
console.log(await client.network.toRawRequest(posts[0].id));
console.log(await client.network.toRawResponse(posts[0].id));

// Where does this token appear? URL, headers, and bodies all at once.
client.network.searchTraffic(/bearer|auth_token|signature/i);
```

### Inspect a WebSocket protocol
```javascript
const [socket] = await assertEventually(() => client.websocket.getSockets({ state: 'open' }), {
  describe: 'a WebSocket to open',
});

// Frames trickle in. Wait for a handful so you see the shape, not just the handshake.
await waitUntil(() => client.websocket.getFrames(socket.requestId), { min: 10, timeout: 30000 });

const sent = client.websocket.getFrames(socket.requestId, { direction: 'sent', jsonOnly: true });

// Or search every frame on every connection at once
client.websocket.searchFrames('challenge_token')
  .forEach(({ url, frame }) => console.log(`[${frame.direction}] ${url}:`, frame.payloadData));
```

### Map the attack surface of a page
```javascript
const forms = await client.dom.dumpForms();            // actions, methods, CSRF tokens
const hidden = await client.dom.dumpHiddenInputs();    // type=hidden + CSS-hidden
const storage = await client.dom.dumpStorage();        // localStorage + sessionStorage
const cookies = await client.network.getCookies();

// Trace a handler back to the exact file and line that registered it
const [handler] = await client.dom.getEventListeners('#checkout-btn');
console.log(handler.scriptId, handler.lineNumber, handler.columnNumber);

// postMessage: hook BEFORE navigating, read after
await client.dom.hookPostMessage();
await client.goto(url);
console.log(await client.dom.getPostMessageLogs());
```

### Reverse a bundle
The natural order is search → narrow → transform. `searchInSources` runs inside Chrome's own debugger index, so it is fast even across huge bundles.

```javascript
const hits = await client.sources.searchInSources(/jwt_secret|X-Signature|api_endpoint/i);
const { scriptId } = hits[0];

const clean = await client.sources.deobfuscateBundle(scriptId);   // webcrack: unminify + undo obfuscator.io
await client.sources.unpackBundle(scriptId, './.tmp/modules/');   // split webpack/browserify into files
await client.sources.downloadBundle(scriptId, './.tmp/app.js');   // raw, as served

// Structural search beats regex once you know the shape you want
const calls = await client.sources.searchAst(scriptId, 'fetch($URL, { $$$OPTS })');
calls.forEach((c) => console.log(c.metaMatches.URL));
```

If the bundle is obfuscated, deobfuscate first and search the *clean* code — names that were mangled become greppable again.

### Read live memory
```javascript
await client.console.queryObjects('UserSession.prototype');  // every live instance of a class
await client.console.inspectObject('window.AppConfig');      // deep props, no JSON serialization errors
client.console.getLogs({ type: 'error', hasStackTrace: true });
```

### Pause and step
```javascript
await client.debug.enable({ pauseOnExceptions: true });
await client.debug.setBreakpoint('https://target.com/app.js', 120);
client.debug.on('paused', ({ callFrames, reason }) => console.log(reason, callFrames));
await client.debug.resume();
```

Breakpoints are how you catch a value that only exists for one tick — a signature computed just before it is sent. Set one on the line `searchInSources` found, then read it out with `evaluateOnCallFrame`.

### Extract content
```javascript
const article = await client.toMarkdown();   // Readability + GFM, strips nav/ads
const $ = await client.toCheerio();          // jQuery-style traversal over the rendered DOM
```
Or one-shot: `node cli.js markdown <url> out.md`

---

## Reporting findings

An investigation is worth what its evidence is worth. Structure the answer so a reader can verify every claim without rerunning anything:

```
## Target
<url>, and what state the page was in (logged in? which route?)

## Findings
For each: what it is, where it lives (file:line, request id, frame direction),
and the raw evidence — the actual header, the actual frame, the actual source line.

## How to reproduce
The exact commands or script that produced the above.

## Not covered
What you did not look at, so nobody mistakes silence for a clean bill of health.
```

Quote real bytes rather than paraphrasing them, and say "not observed" rather than "not present" — a live page only shows you what it happened to do while you were watching.

**Every number in the report gets re-derived from the artifact as you write it.** Not recalled from the run, not carried over from a console line you scrolled past an hour ago — read it back out of the file:

```javascript
const calls = JSON.parse(fs.readFileSync('./.tmp/api-calls.json', 'utf8'));
console.log(calls.length, 'requests captured, pages', calls.map((c) => c.page).join(','));
```

This sounds pedantic until you notice how the mistake happens. Counts drift while you work — you capture three pages, reason about ten, and write "10 pages" because that is the number you had in your head. The quoted bytes stay correct, so nothing looks wrong, and the one claim a reader can cheaply check against your own attached file is the one that is false. That is worse than a gap: it makes the reader distrust the evidence that *was* right.

So when you write "N frames", "M symbols", "K bytes", a status code, or a depth, the artifact is the source of truth. If you did not save an artifact for it, you do not have the number — say what you observed instead ("the capture stopped at page 3, so later pages are unverified"). An honest bound beats a confident invention every time.

---

## Full API reference

`references/api.md` lists every controller method with signatures and filter options. Read it when you need something not shown above — roughly half the surface (page interaction, response bodies, worker evaluation, performance traces, cache and cookie control) is not covered here.
