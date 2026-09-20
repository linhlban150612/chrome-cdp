'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ChromeClient = require('../src/chrome-client');
const WorkerController = require('../src/worker-controller');
const SourceController = require('../src/source-controller');
const ConsoleController = require('../src/console-controller');
const NetworkController = require('../src/network-controller');
const WebSocketController = require('../src/websocket-controller');
const DebugController = require('../src/debug-controller');
const { buildHar } = require('../src/har');
const { waitUntil, assertEventually, waitForEvent } = require('../src/waiting');
const cdpModule = require('../cdp');
const { findChromePath, defaultUserDataDir } = cdpModule;

// `../index` is deliberately NOT required here: the auto-launch test reloads it
// from a clean require.cache after stubbing cdp, and a top-level require would
// freeze the real bindings into index.js first.

/** Lets the WorkerController's async target tracking settle before asserting. */
const settle = () => new Promise((r) => setTimeout(r, 20));

test('WorkerController tracks dedicated worker with raw CDP worker type and ignores unrelated other', async () => {
  const browserEmitter = new EventEmitter();
  const browserSession = {
    send: async () => ({}),
    detach: async () => {},
  };
  const mockTargets = [];
  const browser = Object.assign(browserEmitter, {
    target: () => ({
      createCDPSession: async () => browserSession,
    }),
    targets: () => mockTargets,
  });

  const controller = new WorkerController(browser);
  await controller.ready;

  function createMockTarget({ rawType, puppeteerType, targetId, url }) {
    const session = {
      send: async (method) => {
        if (method === 'Target.getTargetInfo') {
          return { targetInfo: { targetId, type: rawType } };
        }
        return {};
      },
      detach: async () => {},
    };
    return {
      type: () => puppeteerType,
      _getTargetInfo: () => ({ type: rawType, targetId }),
      url: () => url,
      createCDPSession: async () => session,
    };
  }

  // 1. Dedicated worker: Puppeteer reports 'other', CDP raw type is 'worker'
  const dedicatedWorker = createMockTarget({
    rawType: 'worker',
    puppeteerType: 'other',
    targetId: 'worker-target-1',
    url: 'https://example.com/worker.js',
  });
  browserEmitter.emit('targetcreated', dedicatedWorker);
  await settle();

  assert.equal(controller.list().length, 1);
  assert.deepEqual(controller.list()[0], {
    id: 'worker-target-1',
    type: 'worker',
    url: 'https://example.com/worker.js',
  });

  // 2. Unrelated Puppeteer 'other' target: CDP raw type is 'other'
  const unrelatedOther = createMockTarget({
    rawType: 'other',
    puppeteerType: 'other',
    targetId: 'other-target-2',
    url: 'https://example.com/other',
  });
  browserEmitter.emit('targetcreated', unrelatedOther);
  await settle();

  assert.equal(controller.list().length, 1, 'Unrelated "other" target should be ignored');

  // 3. Service worker: CDP raw type 'service_worker'
  const serviceWorker = createMockTarget({
    rawType: 'service_worker',
    puppeteerType: 'service_worker',
    targetId: 'sw-target-3',
    url: 'https://example.com/sw.js',
  });
  browserEmitter.emit('targetcreated', serviceWorker);
  await settle();

  assert.equal(controller.list().length, 2);
  const swItem = controller.list().find((w) => w.id === 'sw-target-3');
  assert.ok(swItem);
  assert.equal(swItem.type, 'service_worker');

  // 4. Shared worker: CDP raw type 'shared_worker'
  const sharedWorker = createMockTarget({
    rawType: 'shared_worker',
    puppeteerType: 'shared_worker',
    targetId: 'shared-target-4',
    url: 'https://example.com/shared.js',
  });
  browserEmitter.emit('targetcreated', sharedWorker);
  await settle();

  assert.equal(controller.list().length, 3);
  const sharedItem = controller.list().find((w) => w.id === 'shared-target-4');
  assert.ok(sharedItem);
  assert.equal(sharedItem.type, 'shared_worker');

  controller.close();
});

test('SourceController enable sends both Debugger.enable and Runtime.enable; disable omits Runtime.disable', async () => {
  const sentMethods = [];
  const cdpSession = new EventEmitter();
  cdpSession.send = async (method) => {
    sentMethods.push(method);
    return {};
  };

  const sources = new SourceController(cdpSession);

  await sources.enable();
  assert.ok(sentMethods.includes('Debugger.enable'), 'enable must send Debugger.enable');
  assert.ok(sentMethods.includes('Runtime.enable'), 'enable must send Runtime.enable');

  sentMethods.length = 0;
  await sources.disable();
  assert.ok(sentMethods.includes('Debugger.disable'), 'disable must send Debugger.disable');
  assert.ok(!sentMethods.includes('Runtime.disable'), 'disable must NOT send Runtime.disable');
});

test('ConsoleController inspectObject handles float expression 1.2 as primitive and real 3-segment IDs directly', async () => {
  const sentCommands = [];
  const cdpSession = new EventEmitter();
  cdpSession.send = async (method, params) => {
    sentCommands.push({ method, params });
    if (method === 'Runtime.evaluate') {
      if (params.expression === '1.2') {
        return { result: { type: 'number', value: 1.2, description: '1.2' } };
      }
      return { result: { objectId: '99999.1.1' } };
    }
    if (method === 'Runtime.getProperties') {
      return {
        result: [
          { name: 'val', value: { type: 'string', value: 'hello' }, writable: true },
        ],
      };
    }
    return {};
  };

  const mockPage = {};
  const consoleController = new ConsoleController(mockPage, cdpSession);

  // 1. inspectObject('1.2') should evaluate as expression and return primitive preview
  sentCommands.length = 0;
  const floatResult = await consoleController.inspectObject('1.2');
  assert.deepEqual(floatResult, [
    {
      name: '(primitive)',
      value: 1.2,
      type: 'number',
      isGetter: false,
      isSetter: false,
    },
  ]);
  assert.equal(sentCommands[0].method, 'Runtime.evaluate');
  assert.equal(sentCommands[0].params.expression, '1.2');

  // 2. inspectObject with negative 3-segment Chrome ID should directly call Runtime.getProperties
  sentCommands.length = 0;
  const negIdResult = await consoleController.inspectObject('-4225222387882249596.1.1');
  assert.equal(sentCommands.length, 1);
  assert.equal(sentCommands[0].method, 'Runtime.getProperties');
  assert.equal(sentCommands[0].params.objectId, '-4225222387882249596.1.1');
  assert.equal(negIdResult[0].name, 'val');
  assert.equal(negIdResult[0].value, 'hello');

  // 3. inspectObject with positive 3-segment Chrome ID should directly call Runtime.getProperties
  sentCommands.length = 0;
  const posIdResult = await consoleController.inspectObject('7383723597292307119.1.1');
  assert.equal(sentCommands.length, 1);
  assert.equal(sentCommands[0].method, 'Runtime.getProperties');
  assert.equal(sentCommands[0].params.objectId, '7383723597292307119.1.1');
  assert.equal(posIdResult[0].name, 'val');
});

test('NetworkController keeps the pre-redirect hop instead of overwriting it', async () => {
  const cdp = new EventEmitter();
  cdp.send = async () => ({});
  const net = new NetworkController({}, cdp);
  await net.startRecording();

  cdp.emit('Network.requestWillBeSent', {
    requestId: 'R1',
    request: {
      url: 'https://example.test/authenticate',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: 'username=tomsmith&password=hunter2',
    },
    type: 'Document',
    timestamp: 1,
  });
  cdp.emit('Network.requestWillBeSent', {
    requestId: 'R1',
    request: { url: 'https://example.test/secure', method: 'GET', headers: {} },
    type: 'Document',
    timestamp: 2,
    redirectResponse: {
      url: 'https://example.test/authenticate',
      status: 303,
      statusText: 'See Other',
      headers: { location: '/secure', 'set-cookie': 'session=abc; HttpOnly' },
    },
  });
  cdp.emit('Network.responseReceived', {
    requestId: 'R1',
    timestamp: 3,
    response: { status: 200, statusText: 'OK', headers: {} },
  });

  const posts = net.getTraffic({ method: 'POST' });
  assert.equal(posts.length, 1, 'the POST must survive the redirect');
  assert.equal(posts[0].url, 'https://example.test/authenticate');
  assert.equal(posts[0].status, 303, 'the redirect status belongs to the POST, not the GET');
  assert.equal(posts[0].postData, 'username=tomsmith&password=hunter2');
  assert.equal(posts[0].responseHeaders['set-cookie'], 'session=abc; HttpOnly');
  assert.equal(posts[0].redirectedTo, 'https://example.test/secure');
  assert.equal(posts[0].cdpRequestId, 'R1', 'CDP calls still address the real request');

  const final = net.getTraffic({ method: 'GET' });
  assert.equal(final.length, 1);
  assert.equal(final[0].status, 200);
  assert.equal(final[0].redirectedFrom, 'https://example.test/authenticate');
  assert.equal(net.getTraffic().length, 2, 'both hops are addressable');

  const raw = await net.toRawRequest(posts[0].id);
  assert.match(raw, /^POST \/authenticate HTTP\/1\.1/);
  assert.match(raw, /username=tomsmith/);
});

test('waitUntil returns as soon as the value is ready instead of burning the whole timeout', async () => {
  let polls = 0;
  const started = Date.now();
  const frames = await waitUntil(() => (++polls >= 3 ? ['a', 'b'] : []), { every: 10, timeout: 5000 });

  assert.deepEqual(frames, ['a', 'b']);
  assert.equal(polls, 3);
  assert.ok(Date.now() - started < 1000, 'succeed fast: must not wait out the timeout');
});

test('waitUntil synchronizes rather than claims, so a timeout yields the partial capture', async () => {
  const partial = await waitUntil(() => ['only-one'], { min: 5, every: 10, timeout: 60 });
  assert.deepEqual(partial, ['only-one'], 'seven frames are still seven frames');
});

test('assertEventually throws a diagnostic instead of letting a failed wait read as absence', async () => {
  await assert.rejects(
    () => assertEventually(() => [], { every: 10, timeout: 60, describe: 'a server PING frame' }),
    (err) => {
      assert.match(err.message, /a server PING frame never became true within 60ms/);
      assert.match(err.message, /last value: length 0/);
      assert.match(err.message, /not observed/, 'the message must warn against misreporting');
      return true;
    },
  );

  const value = await assertEventually(() => ['here'], { every: 10, timeout: 60 });
  assert.deepEqual(value, ['here']);
});

test('assertEventually reports the shortfall when min is not reached', async () => {
  await assert.rejects(
    () => assertEventually(() => [1, 2], { min: 10, every: 10, timeout: 60, describe: '10 frames' }),
    /last value: length 2, needed at least 10/,
  );
});

test('waitForEvent listens and resolves on the event itself, filtered by where', async () => {
  const websocket = new EventEmitter();
  const pending = waitForEvent(websocket, 'frame', {
    count: 2,
    timeout: 5000,
    where: (f) => f.direction === 'received',
  });

  websocket.emit('frame', { direction: 'sent', payloadData: 'subscribe' });
  websocket.emit('frame', { direction: 'received', payloadData: 'ack' });
  websocket.emit('frame', { direction: 'sent', payloadData: 'ping' });
  websocket.emit('frame', { direction: 'received', payloadData: 'trade' });

  const frames = await pending;
  assert.deepEqual(frames.map((f) => f.payloadData), ['ack', 'trade']);
  assert.equal(websocket.listenerCount('frame'), 0, 'must not leak its listener');
});

test('waitForEvent returns the partial collection on timeout and still unsubscribes', async () => {
  const websocket = new EventEmitter();
  const pending = waitForEvent(websocket, 'frame', { count: 5, timeout: 50 });
  websocket.emit('frame', { payloadData: 'one' });

  const frames = await pending;
  assert.equal(frames.length, 1);
  assert.equal(websocket.listenerCount('frame'), 0);
});

test('inspectObject keeps ownProperties defaulting to true when given an options object without it', async () => {
  const sent = [];
  const cdpSession = new EventEmitter();
  cdpSession.send = async (method, params) => {
    sent.push({ method, params });
    return { result: [] };
  };
  const controller = new ConsoleController({}, cdpSession);

  await controller.inspectObject('1.1.1', {});
  assert.equal(sent.at(-1).params.ownProperties, true, 'empty options must not drop the default');

  await controller.inspectObject('1.1.1', { generatePreview: true });
  assert.equal(sent.at(-1).params.ownProperties, true, 'an unrelated key must not drop the default');

  await controller.inspectObject('1.1.1');
  assert.equal(sent.at(-1).params.ownProperties, true, 'omitting options keeps the default');

  await controller.inspectObject('1.1.1', { ownProperties: false });
  assert.equal(sent.at(-1).params.ownProperties, false, 'an explicit false is still honoured');
});

test('setBreakpoint rejects a condition passed into the columnNumber slot', async () => {
  const cdp = new EventEmitter();
  const sent = [];
  cdp.send = async (method, params) => {
    sent.push({ method, params });
    return { breakpointId: 'bp-1' };
  };
  const debugCtl = new DebugController(cdp);

  await assert.rejects(
    () => debugCtl.setBreakpoint('https://x.test/app.js', 120, 'price > 5'),
    (err) => {
      assert.match(err.message, /columnNumber must be a number, got string/);
      assert.match(err.message, /setBreakpoint\(url, line, 0, condition\)/);
      return true;
    },
  );
  assert.equal(sent.length, 0, 'nothing should reach Chrome');

  const ok = await debugCtl.setBreakpoint('https://x.test/app.js', 120, 0, 'price > 5');
  assert.equal(ok.breakpointId, 'bp-1');
  assert.deepEqual(sent.at(-1).params, {
    url: 'https://x.test/app.js',
    lineNumber: 120,
    columnNumber: 0,
    condition: 'price > 5',
  });

  await debugCtl.setBreakpoint('https://x.test/app.js', 7);
  assert.equal(sent.at(-1).params.columnNumber, 0, 'the default still applies');
});

test('getResponseBody refuses a redirect hop instead of returning the final response body', async () => {
  const cdp = new EventEmitter();
  cdp.send = async () => ({ body: '<html>SECURE AREA</html>', base64Encoded: false });
  const net = new NetworkController({}, cdp);
  await net.startRecording();

  cdp.emit('Network.requestWillBeSent', {
    requestId: 'R9',
    request: { url: 'https://example.test/authenticate', method: 'POST', headers: {}, postData: 'u=a' },
    type: 'Document',
    timestamp: 1,
  });
  cdp.emit('Network.requestWillBeSent', {
    requestId: 'R9',
    request: { url: 'https://example.test/secure', method: 'GET', headers: {} },
    type: 'Document',
    timestamp: 2,
    redirectResponse: { url: 'https://example.test/authenticate', status: 303, statusText: 'See Other', headers: {} },
  });

  const [hop] = net.getTraffic({ method: 'POST' });
  await assert.rejects(
    () => net.getResponseBody(hop.id),
    (err) => {
      assert.match(err.message, /No response body for redirect hop R9:redirect:0 \(303 to https:\/\/example\.test\/secure\)/);
      assert.match(err.message, /request id R9/);
      return true;
    },
  );

  const final = await net.getResponseBody('R9');
  assert.equal(final.body, '<html>SECURE AREA</html>');
});

test('waitForEvent rejects when the where predicate throws instead of hanging', async () => {
  const websocket = new EventEmitter();
  const pending = waitForEvent(websocket, 'frame', {
    timeout: 5000,
    where: () => { throw new Error('predicate blew up'); },
  });

  assert.doesNotThrow(() => websocket.emit('frame', { payloadData: 'x' }));
  await assert.rejects(() => pending, /predicate blew up/);
  assert.equal(websocket.listenerCount('frame'), 0, 'must unsubscribe on the error path too');
});

test('global-flag filters survive a stateful /g regex instead of skipping every other entry', async () => {
  const wsCdp = new EventEmitter();
  wsCdp.send = async () => ({});
  const ws = new WebSocketController(wsCdp);
  await ws.startRecording();
  for (const id of ['S1', 'S2', 'S3']) {
    wsCdp.emit('Network.webSocketCreated', { requestId: id, url: `wss://live.test/${id}` });
  }
  assert.equal(ws.getSockets({ url: /live\.test/g }).length, 3, 'lastIndex must not leak between sockets');

  const srcCdp = new EventEmitter();
  srcCdp.send = async () => ({});
  const sources = new SourceController(srcCdp);
  await sources.enable();
  for (const id of ['1', '2', '3']) {
    srcCdp.emit('Debugger.scriptParsed', { scriptId: id, url: `https://cdn.test/app.${id}.js` });
  }
  assert.equal(sources.getScripts({ url: /cdn\.test/g }).length, 3, 'lastIndex must not leak between scripts');
});

test('durationMs stays in the CDP timebase when a request is seen mid-flight', async () => {
  const cdp = new EventEmitter();
  cdp.send = async () => ({});
  const net = new NetworkController({}, cdp);
  await net.startRecording();

  // Recording started after requestWillBeSent, so only the response is ever seen.
  cdp.emit('Network.responseReceived', {
    requestId: 'R9',
    timestamp: 42,
    response: { status: 200, statusText: 'OK', headers: {} },
  });

  const [entry] = net.getTraffic();
  assert.equal(entry.startTime, null, 'no epoch clock may be mixed into the CDP timebase');
  assert.equal(entry.durationMs, null, 'an unknown start must read as unknown, not as a negative age');
});

test('findChromePath prefers CHROME_PATH, else resolves the CloakBrowser binary', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-cdp-test-'));
  const saved = process.env.CHROME_PATH;
  t.after(() => {
    if (saved === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const explicit = path.join(dir, 'my-chrome');
  fs.writeFileSync(explicit, '');
  process.env.CHROME_PATH = explicit;
  assert.equal(await findChromePath(), explicit);
});

test('defaultUserDataDir keeps the automation profile out of tmp on every platform', () => {
  const home = '/home/alice';

  assert.equal(
    defaultUserDataDir({ platform: 'linux', env: { CHROME_USER_DATA_DIR: '/custom' }, home }),
    '/custom',
    'CHROME_USER_DATA_DIR always wins'
  );
  assert.equal(
    defaultUserDataDir({ platform: 'linux', env: { XDG_DATA_HOME: '/xdg' }, home }),
    path.join('/xdg', 'chrome-cdp', 'profile')
  );
  assert.equal(
    defaultUserDataDir({ platform: 'linux', env: {}, home }),
    path.join(home, '.local', 'share', 'chrome-cdp', 'profile')
  );
  assert.equal(
    defaultUserDataDir({ platform: 'darwin', env: {}, home }),
    path.join(home, 'Library', 'Application Support', 'chrome-cdp', 'profile')
  );
  assert.equal(
    defaultUserDataDir({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' }, home }),
    'C:\\Users\\alice\\AppData\\Local\\Google\\Chrome\\AutomationProfile'
  );
});

test('requiring index.js does not load webcrack or ast-grep until they are used', () => {
  // Fresh process: this test file itself may have loaded modules into require.cache.
  const script = `
    const lib = require(${JSON.stringify(path.join(__dirname, '..', 'index.js'))});
    const loaded = (name) => Object.keys(require.cache).some((k) => k.includes('node_modules/' + name + '/'));
    const before = { webcrack: loaded('webcrack'), astGrep: loaded('@ast-grep') };
    const exported = typeof lib.webcrack;
    console.log(JSON.stringify({ before, exported, after: loaded('webcrack') }));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }));

  assert.deepEqual(result.before, { webcrack: false, astGrep: false });
  assert.equal(result.exported, 'function', 'the lazy getter still hands back webcrack');
  assert.equal(result.after, true);
});

test('NetworkController evicts the oldest entries past maxEntries and counts them', async () => {
  const cdp = new EventEmitter();
  cdp.send = async () => ({});
  const net = new NetworkController({}, cdp, { maxEntries: 3 });
  await net.startRecording();

  for (let i = 1; i <= 5; i++) {
    cdp.emit('Network.requestWillBeSent', {
      requestId: `R${i}`,
      request: { url: `https://example.test/${i}`, method: 'GET', headers: {} },
      type: 'XHR',
      timestamp: i,
    });
  }

  assert.deepEqual(
    net.getTraffic().map((e) => e.id),
    ['R3', 'R4', 'R5']
  );
  assert.equal(net.droppedCount, 2, 'the loss is reported, not silent');

  net.clear();
  assert.equal(net.droppedCount, 0);
  assert.equal(new NetworkController({}, cdp).maxEntries, NetworkController.DEFAULT_MAX_ENTRIES);
});

test('WebSocketController caps frames per socket and sockets overall, reporting both', async () => {
  const cdp = new EventEmitter();
  cdp.send = async () => ({});
  const ws = new WebSocketController(cdp, { maxFramesPerSocket: 2, maxSockets: 2 });
  await ws.startRecording();

  cdp.emit('Network.webSocketCreated', { requestId: 'S1', url: 'wss://example.test/a' });
  for (let i = 1; i <= 5; i++) {
    cdp.emit('Network.webSocketFrameReceived', {
      requestId: 'S1',
      timestamp: i,
      response: { opcode: 1, payloadData: `msg-${i}` },
    });
  }

  const [socket] = ws.getSockets();
  assert.deepEqual(
    ws.getFrames('S1').map((f) => f.payloadData),
    ['msg-4', 'msg-5']
  );
  assert.equal(socket.droppedFrames, 3);

  cdp.emit('Network.webSocketCreated', { requestId: 'S2', url: 'wss://example.test/b' });
  cdp.emit('Network.webSocketCreated', { requestId: 'S3', url: 'wss://example.test/c' });
  assert.deepEqual(
    ws.getSockets().map((s) => s.requestId),
    ['S2', 'S3']
  );
  assert.equal(ws.droppedSockets, 1);
  assert.equal(ws.getSockets()[0].droppedFrames, 0);
});

test('ConsoleController caps buffered logs and counts what it evicted', () => {
  const cdp = new EventEmitter();
  cdp.send = async () => ({});
  const consoleCtl = new ConsoleController({}, cdp, { maxLogs: 2 });

  for (let i = 1; i <= 4; i++) consoleCtl._pushLog({ type: 'log', text: `line ${i}` });

  assert.deepEqual(
    consoleCtl.getLogs().map((l) => l.text),
    ['line 3', 'line 4']
  );
  assert.equal(consoleCtl.droppedCount, 2);
});

/** Asserts the fields HAR 1.2 marks required, so viewers that validate strictly accept the file. */
function assertHar12(har) {
  const { log } = har;
  assert.equal(log.version, '1.2');
  assert.ok(log.creator.name && log.creator.version);
  for (const page of log.pages) {
    for (const key of ['startedDateTime', 'id', 'title', 'pageTimings']) assert.ok(key in page, key);
  }
  for (const entry of log.entries) {
    assert.ok(!Number.isNaN(Date.parse(entry.startedDateTime)), 'startedDateTime is ISO 8601');
    assert.equal(typeof entry.time, 'number');
    for (const key of ['method', 'url', 'httpVersion', 'cookies', 'headers', 'queryString', 'headersSize', 'bodySize']) {
      assert.ok(key in entry.request, `request.${key}`);
    }
    for (const key of ['status', 'statusText', 'httpVersion', 'cookies', 'headers', 'content', 'redirectURL', 'headersSize', 'bodySize']) {
      assert.ok(key in entry.response, `response.${key}`);
    }
    assert.equal(typeof entry.response.content.size, 'number');
    assert.equal(typeof entry.response.content.mimeType, 'string');
    assert.deepEqual(entry.cache, {});
    for (const key of ['send', 'wait', 'receive']) assert.ok(entry.timings[key] >= 0, `timings.${key}`);
    const phases = ['blocked', 'dns', 'connect', 'send', 'wait', 'receive'].map((k) => entry.timings[k]);
    const sum = phases.filter((v) => v > 0).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(entry.time - sum) < 0.01, `time ${entry.time} equals the phase sum ${sum}`);
    for (const h of [...entry.request.headers, ...entry.response.headers]) {
      assert.equal(typeof h.name, 'string');
      assert.equal(typeof h.value, 'string');
    }
  }
}

test('buildHar maps redirects, POST bodies, cookies, timings, and missing bodies onto HAR 1.2', async () => {
  const cdp = new EventEmitter();
  cdp.send = async () => ({});
  const net = new NetworkController({}, cdp);
  await net.startRecording();

  cdp.emit('Network.requestWillBeSent', {
    requestId: 'R1',
    request: {
      url: 'https://example.test/login?next=%2Fhome&x=1',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: 'a=1; b=two' },
      postData: 'user=alice',
    },
    type: 'Document',
    timestamp: 100,
    wallTime: 1_700_000_000,
  });
  cdp.emit('Network.requestWillBeSent', {
    requestId: 'R1',
    request: { url: 'https://example.test/home', method: 'GET', headers: {} },
    type: 'Document',
    timestamp: 100.2,
    wallTime: 1_700_000_000.2,
    redirectResponse: {
      url: 'https://example.test/login?next=%2Fhome&x=1',
      status: 302,
      statusText: 'Found',
      protocol: 'h2',
      headers: {
        location: '/home',
        'set-cookie': 'sid=xyz; Path=/; HttpOnly; Secure; SameSite=Lax\ntheme=dark; Expires=Wed, 21 Oct 2037 07:28:00 GMT',
      },
    },
  });
  cdp.emit('Network.responseReceived', {
    requestId: 'R1',
    timestamp: 100.35,
    response: {
      status: 200,
      statusText: 'OK',
      protocol: 'h2',
      mimeType: 'text/html',
      headers: { 'content-type': 'text/html' },
      remoteIPAddress: '93.184.216.34',
      timing: {
        requestTime: 100.21,
        dnsStart: 1, dnsEnd: 5,
        connectStart: 5, connectEnd: 40,
        sslStart: 20, sslEnd: 40,
        sendStart: 41, sendEnd: 42,
        receiveHeadersEnd: 120,
      },
    },
  });
  cdp.emit('Network.loadingFinished', { requestId: 'R1', timestamp: 100.4, encodedDataLength: 500 });

  cdp.emit('Network.requestWillBeSent', {
    requestId: 'R2',
    request: { url: 'https://example.test/logo.png', method: 'GET', headers: {} },
    type: 'Image',
    timestamp: 100.5,
  });
  cdp.emit('Network.responseReceived', {
    requestId: 'R2',
    timestamp: 100.6,
    response: { status: 200, statusText: 'OK', mimeType: 'image/png', headers: {} },
  });

  cdp.emit('Network.requestWillBeSent', {
    requestId: 'R3',
    request: { url: 'https://blocked.test/ad.js', method: 'GET', headers: {} },
    type: 'Script',
    timestamp: 100.7,
  });
  cdp.emit('Network.loadingFailed', { requestId: 'R3', errorText: 'net::ERR_BLOCKED_BY_CLIENT' });

  const bodies = new Map([
    ['R1', { body: '<h1>hi</h1>', base64Encoded: false }],
    ['R2', { body: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), base64Encoded: true }],
    ['R1:redirect:0', { error: 'redirect hop, Chrome keeps no body' }],
  ]);
  const har = buildHar({
    entries: net.getTraffic(),
    bodies,
    page: { title: 'Home' },
    truncation: { droppedRequests: 0, droppedSockets: 0, droppedFrames: 0 },
  });

  assertHar12(har);
  assert.equal(har.log.pages[0].title, 'Home');
  assert.equal(har.log.comment, undefined, 'no truncation note when nothing was dropped');
  assert.equal(har.log.entries.length, 4, 'both redirect hops, the image, and the blocked script');

  const post = har.log.entries.find((e) => e.request.method === 'POST');
  const logo = har.log.entries.find((e) => e.request.url.endsWith('logo.png'));
  const blocked = har.log.entries.find((e) => e.request.url.startsWith('https://blocked.test'));
  assert.equal(blocked.response._error, 'net::ERR_BLOCKED_BY_CLIENT');

  assert.equal(post.startedDateTime, new Date(1_700_000_000_000).toISOString());
  assert.equal(post.response.status, 302);
  assert.equal(post.response.redirectURL, 'https://example.test/home');
  assert.equal(post.response.httpVersion, 'HTTP/2');
  assert.deepEqual(post.request.postData, { mimeType: 'application/x-www-form-urlencoded', text: 'user=alice' });
  assert.equal(post.request.bodySize, 10);
  assert.deepEqual(post.request.queryString, [{ name: 'next', value: '/home' }, { name: 'x', value: '1' }]);
  assert.deepEqual(post.request.cookies, [{ name: 'a', value: '1' }, { name: 'b', value: 'two' }]);
  assert.equal(post.response.headers.filter((h) => h.name === 'set-cookie').length, 2, 'folded Set-Cookie is split');
  assert.deepEqual(post.response.cookies[0], { name: 'sid', value: 'xyz', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' });
  assert.equal(post.response.cookies[1].expires, '2037-10-21T07:28:00.000Z');
  assert.match(post.response.content.comment, /redirect hop/);

  const final = har.log.entries.find((e) => e.request.url === 'https://example.test/home');
  assert.equal(final.response.content.text, '<h1>hi</h1>');
  assert.equal(final.response.content.size, 11);
  assert.equal(final.serverIPAddress, '93.184.216.34');
  assert.equal(final.timings.dns, 4);
  assert.equal(final.timings.connect, 35);
  assert.equal(final.timings.ssl, 20);
  assert.equal(final.timings.wait, 78);
  assert.equal(final.time, 200, 'phases add back up to the recorded duration');

  assert.equal(logo.response.content.encoding, 'base64');
  assert.equal(logo.response.content.size, 4, 'size is the decoded byte count');
  assert.equal(logo._resourceType, 'image');
  assert.ok(!Number.isNaN(Date.parse(logo.startedDateTime)), 'mid-flight entry anchored to the wall clock');
});

test('buildHar reports truncation and blocked requests instead of implying a complete capture', async () => {
  const cdp = new EventEmitter();
  cdp.send = async () => ({});
  const net = new NetworkController({}, cdp);
  await net.startRecording();
  cdp.emit('Network.requestWillBeSent', {
    requestId: 'F1',
    request: { url: 'https://blocked.test/ad.js', method: 'GET', headers: {} },
    type: 'Script',
    timestamp: 5,
    wallTime: 1_700_000_000,
  });
  cdp.emit('Network.loadingFailed', { requestId: 'F1', errorText: 'net::ERR_BLOCKED_BY_CLIENT' });

  const har = buildHar({ entries: net.getTraffic(), truncation: { droppedRequests: 7, droppedFrames: 0 } });
  assertHar12(har);
  assert.equal(har.log.entries[0].response.status, 0);
  assert.equal(har.log.entries[0].response._error, 'net::ERR_BLOCKED_BY_CLIENT');
  assert.equal(har.log._truncation.droppedRequests, 7);
  assert.match(har.log.comment, /truncated/);
});

test('client.toHar skips body fetches for redirect hops and failures, and exports WebSocket frames', async () => {
  const fetched = [];
  const fake = {
    network: {
      droppedCount: 0,
      getTraffic: () => [
        { id: 'R1:redirect:0', cdpRequestId: 'R1', url: 'https://a.test/', method: 'GET', status: 301, redirectedTo: 'https://a.test/x' },
        { id: 'R1', cdpRequestId: 'R1', url: 'https://a.test/x', method: 'GET', status: 200 },
        { id: 'R2', cdpRequestId: 'R2', url: 'https://a.test/gone', method: 'GET', status: 200 },
        { id: 'R3', cdpRequestId: 'R3', url: 'https://a.test/fail', method: 'GET', failed: true, errorText: 'net::ERR_FAILED' },
        { id: 'R4', cdpRequestId: 'R4', url: 'data:image/png;base64,AAAA', method: 'GET', status: 200 },
      ],
      getResponseBody: async (id) => {
        fetched.push(id);
        if (id === 'R2') throw new Error('No resource with given identifier found');
        return { body: 'ok', base64Encoded: false };
      },
    },
    websocket: {
      droppedSockets: 0,
      getSockets: () => [
        {
          requestId: 'W1',
          url: 'wss://a.test/ws',
          startTime: 1_700_000_000_000,
          handshakeRequest: { headers: { Upgrade: 'websocket' }, wallTime: 1_700_000_000 },
          handshakeResponse: { status: 101, statusText: 'Switching Protocols', headers: {} },
          droppedFrames: 3,
          frames: [
            { direction: 'sent', wallTime: 1_700_000_001_000, opcode: 1, payloadData: '{"op":"sub"}' },
            { direction: 'received', wallTime: 1_700_000_001_500, opcode: 1, payloadData: '{"ok":true}' },
          ],
        },
      ],
    },
    title: async () => 'A',
    page: { url: () => 'https://a.test/x' },
  };

  const har = await ChromeClient.prototype.toHar.call(fake);
  assertHar12(har);
  assert.deepEqual(fetched, ['R1', 'R2'], 'no body fetch for the redirect hop, the failed request, or a data: URL');

  const byUrl = (u) => har.log.entries.find((e) => e.request.url === u);
  assert.equal(byUrl('https://a.test/x').response.content.text, 'ok');
  assert.match(byUrl('https://a.test/gone').response.content.comment, /No resource with given identifier/);
  assert.match(byUrl('https://a.test/').response.content.comment, /redirect hop/);

  const ws = byUrl('wss://a.test/ws');
  assert.equal(ws.response.status, 101);
  assert.equal(ws._resourceType, 'websocket');
  assert.deepEqual(ws._webSocketMessages, [
    { type: 'send', time: 1_700_000_001, opcode: 1, data: '{"op":"sub"}' },
    { type: 'receive', time: 1_700_000_001.5, opcode: 1, data: '{"ok":true}' },
  ]);
  assert.equal(ws._droppedFrames, 3);
  assert.equal(har.log._truncation.droppedFrames, 3);

  const noBodies = await ChromeClient.prototype.toHar.call(fake, { includeBodies: false });
  assert.equal(fetched.length, 2, 'includeBodies: false fetches nothing');
  assert.equal(noBodies.log.entries.length, har.log.entries.length);
});

test('buffer limits reject values that would silently disable or distort the cap', () => {
  const cdp = new EventEmitter();
  cdp.send = async () => ({});
  const browser = Object.assign(new EventEmitter(), {
    target: () => ({ createCDPSession: async () => ({ send: async () => ({}), detach: async () => {} }) }),
    targets: () => [],
  });

  for (const bad of [NaN, 0, -1, 1.5, '5']) {
    assert.throws(() => new ChromeClient(browser, {}, cdp, null, { maxEntries: bad }), /maxEntries must be a positive integer/);
  }
  const client = new ChromeClient(browser, {}, cdp, null, { maxEntries: 10, maxFramesPerSocket: Infinity });
  assert.equal(client.network.maxEntries, 10);
  assert.equal(client.websocket.maxFramesPerSocket, Infinity);
  client.workers.close();
});

test('late events for an evicted request are ignored instead of resurrecting a blank entry', async () => {
  const cdp = new EventEmitter();
  cdp.send = async () => ({});
  const net = new NetworkController({}, cdp, { maxEntries: 2 });
  await net.startRecording();

  const request = (id) =>
    cdp.emit('Network.requestWillBeSent', {
      requestId: id,
      request: { url: `https://example.test/${id}`, method: 'GET', headers: {} },
      type: 'XHR',
      timestamp: 1,
    });
  const finished = [];
  net.on('finished', (e) => finished.push(e.id));

  request('R1');
  request('R2');
  request('R3'); // evicts R1

  cdp.emit('Network.responseReceived', { requestId: 'R1', timestamp: 2, response: { status: 200, headers: {} } });
  cdp.emit('Network.responseReceivedExtraInfo', { requestId: 'R1', headers: {}, statusCode: 200 });
  cdp.emit('Network.loadingFinished', { requestId: 'R1', timestamp: 3, encodedDataLength: 10 });
  cdp.emit('Network.loadingFailed', { requestId: 'R1', errorText: 'net::ERR_ABORTED' });

  assert.deepEqual(
    net.getTraffic().map((e) => e.id),
    ['R2', 'R3'],
    'no ghost for R1, and R2 was not pushed out to make room for one'
  );
  assert.equal(net.droppedCount, 1, 'only the real eviction is counted');
  assert.deepEqual(finished, [], 'no events are emitted for an entry that is gone');

  // A fresh requestWillBeSent under that ID is a real request again (e.g. a new redirect hop).
  request('R1');
  assert.deepEqual(
    net.getTraffic().map((e) => e.id),
    ['R3', 'R1']
  );
  cdp.emit('Network.loadingFinished', { requestId: 'R1', timestamp: 4, encodedDataLength: 5 });
  assert.equal(net.getTraffic().find((e) => e.id === 'R1').encodedDataLength, 5);
});

test('late frames for an evicted WebSocket are ignored instead of resurrecting a blank socket', async () => {
  const cdp = new EventEmitter();
  cdp.send = async () => ({});
  const ws = new WebSocketController(cdp, { maxSockets: 2 });
  await ws.startRecording();

  cdp.emit('Network.webSocketCreated', { requestId: 'S1', url: 'wss://example.test/a' });
  cdp.emit('Network.webSocketCreated', { requestId: 'S2', url: 'wss://example.test/b' });
  cdp.emit('Network.webSocketCreated', { requestId: 'S3', url: 'wss://example.test/c' }); // evicts S1

  const frames = [];
  ws.on('frame', (f) => frames.push(f));
  cdp.emit('Network.webSocketFrameReceived', { requestId: 'S1', timestamp: 1, response: { opcode: 1, payloadData: 'late' } });
  cdp.emit('Network.webSocketFrameSent', { requestId: 'S1', timestamp: 2, response: { opcode: 1, payloadData: 'late' } });
  cdp.emit('Network.webSocketClosed', { requestId: 'S1', timestamp: 3 });

  assert.deepEqual(
    ws.getSockets().map((s) => s.requestId),
    ['S2', 'S3']
  );
  assert.equal(ws.droppedSockets, 1);
  assert.deepEqual(frames, []);
});

test('newPage validates buffer limits before opening a tab, so a bad value leaks nothing', async () => {
  let opened = 0;
  const fake = { _limits: {}, browser: { newPage: async () => (opened++, {}) } };
  await assert.rejects(ChromeClient.prototype.newPage.call(fake, { maxEntries: 0 }), /maxEntries must be a positive integer/);
  assert.equal(opened, 0, 'no orphan tab left behind in the long-lived Chrome');
});

test('connect() with an explicit endpoint neither probes nor launches a local Chrome', async () => {
  const indexPath = require.resolve('../index');

  const calls = [];
  const original = {
    checkCdpReady: cdpModule.checkCdpReady,
    startChrome: cdpModule.startChrome,
    connect: ChromeClient.connect,
  };
  cdpModule.checkCdpReady = async () => (calls.push('probe'), null);
  cdpModule.startChrome = async () => calls.push('launch');
  ChromeClient.connect = async (opts) => (calls.push('connect'), opts);
  delete require.cache[indexPath];

  try {
    const { connect } = require('../index');
    await connect({ browserWSEndpoint: 'ws://remote.test:9222/devtools/browser/x' });
    await connect({ browserURL: 'http://remote.test:9222' });
    assert.deepEqual(calls, ['connect', 'connect']);

    calls.length = 0;
    await connect({ port: 9333 });
    assert.deepEqual(calls, ['probe', 'launch', 'connect'], 'the local default still auto-launches');
  } finally {
    Object.assign(cdpModule, { checkCdpReady: original.checkCdpReady, startChrome: original.startChrome });
    ChromeClient.connect = original.connect;
    delete require.cache[indexPath];
  }
});

test('cli parses --keep-open and --wait without consuming a positional slot', () => {
  const cli = require('../cli');

  const plain = cli.parseGlobalOptions(['eval', 'a + b']);
  assert.equal(plain.keepOpen, false);
  assert.equal(plain.waitMs, 0);
  assert.deepEqual(plain.positional, ['eval', 'a + b']);

  const flagged = cli.parseGlobalOptions(['traffic', '-', '--keep-open', '--wait', '2500', '--json']);
  assert.equal(flagged.keepOpen, true);
  assert.equal(flagged.waitMs, 2500);
  assert.equal(flagged.isJson, true);
  // The dash is the target, so it must survive as a positional and not read as a flag.
  assert.deepEqual(flagged.positional, ['traffic', '-']);

  assert.throws(() => cli.parseGlobalOptions(['traffic', 'x', '--wait', '-1']), /non-negative/);
  assert.throws(() => cli.parseGlobalOptions(['traffic', 'x', '--wait', 'soon']), /non-negative/);
});

test('cli treats only a bare dash as attach, and names a HAR even without a usable URL', () => {
  const cli = require('../cli');

  assert.equal(cli.isAttach('-'), true);
  assert.equal(cli.isAttach('--json'), false);
  assert.equal(cli.isAttach('https://target.com'), false);
  assert.equal(cli.isAttach(undefined), false);

  assert.equal(cli.harName('https://target.com/login?a=1'), 'target.com.har');
  // An attached page can be about:blank or a file URL; a default name must still come out.
  assert.equal(cli.harName('about:blank'), 'capture.har');
  assert.equal(cli.harName('-'), 'capture.har');
});

test('cli eval reads its expression from -f, from stdin, and from argv', async () => {
  const cli = require('../cli');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-cli-'));
  const file = path.join(dir, 'expr.js');
  fs.writeFileSync(file, 'window.sign("x")\n');

  try {
    assert.equal(await cli.readExpression(['-f', file]), 'window.sign("x")');
    assert.equal(await cli.readExpression(['--file', file]), 'window.sign("x")');
    // Joined back together: an unquoted expression arrives as several argv slots.
    assert.equal(await cli.readExpression(['document.title', '+', '1']), 'document.title + 1');
    await assert.rejects(() => cli.readExpression(['-f']), /needs a file path/);
    assert.equal(
      await cli.readExpression([], { isTty: true }),
      '',
      'an interactive shell must report the missing expression, not block on stdin'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
