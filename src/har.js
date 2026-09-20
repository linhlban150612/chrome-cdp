'use strict';

/**
 * Pure HAR 1.2 builder over what NetworkController and WebSocketController recorded.
 * No CDP calls here: bodies are fetched by the caller and passed in, so the mapping
 * stays testable and the export never reaches back into a page that may be gone.
 * Spec: http://www.softwareishard.com/blog/har-12-spec/
 */

const pkg = require('../package.json');

const PAGE_ID = 'page_1';

/**
 * Whether a recorded request belongs in the HAR. data: URLs carry their own payload
 * and never hit the network, so they are left out.
 * @param {{ url?: string }} entry
 * @returns {boolean}
 */
function isHarEntry(entry) {
  return Boolean(entry.url) && !entry.url.startsWith('data:');
}

/**
 * @param {{
 *   entries: object[],
 *   sockets?: object[],
 *   bodies?: Map<string, { body?: string, base64Encoded?: boolean, error?: string }>,
 *   page?: { title?: string, url?: string },
 *   truncation?: object,
 * }} input
 * @returns {{ log: object }}
 */
function buildHar({ entries, sockets = [], bodies = new Map(), page = {}, truncation = null }) {
  const clock = createWallClock(entries);

  const harEntries = entries
    .filter(isHarEntry)
    .map((entry) => toHarEntry(entry, bodies.get(entry.id), clock));
  harEntries.push(...sockets.map(toHarSocketEntry));
  harEntries.sort((a, b) => Date.parse(a.startedDateTime) - Date.parse(b.startedDateTime));

  const firstStart = harEntries[0]?.startedDateTime || new Date().toISOString();

  const log = {
    version: '1.2',
    creator: { name: pkg.name, version: pkg.version },
    pages: [
      {
        startedDateTime: firstStart,
        id: PAGE_ID,
        title: page.title || page.url || '',
        pageTimings: { onContentLoad: -1, onLoad: -1 },
      },
    ],
    entries: harEntries,
  };

  // A HAR that silently omits the oldest requests reads as a complete capture.
  if (truncation && Object.values(truncation).some((n) => n > 0)) {
    log._truncation = truncation;
    log.comment = `Capture truncated, oldest items dropped: ${JSON.stringify(truncation)}`;
  }

  return { log };
}

/**
 * Entries carry CDP monotonic `startTime` (ms) and, from requestWillBeSent, epoch `wallTime` (s).
 * Anchors the monotonic clock to the wall clock once so entries seen mid-flight still get a
 * plausible startedDateTime instead of 1970.
 * @private
 */
function createWallClock(entries) {
  const anchor = entries.find((e) => e.wallTime && e.startTime);
  const offsetMs = anchor ? anchor.wallTime * 1000 - anchor.startTime : null;
  const fallback = Date.now();

  return (entry) => {
    if (entry.wallTime) return entry.wallTime * 1000;
    if (entry.startTime && offsetMs !== null) return entry.startTime + offsetMs;
    return fallback;
  };
}

/** @private */
function toHarEntry(entry, bodyResult, clock) {
  const requestHeaders = toHeaderList(entry.rawHeaders || entry.headers);
  const responseHeaders = toHeaderList(entry.rawResponseHeaders || entry.responseHeaders);
  const httpVersion = toHttpVersion(entry.protocol);
  const timings = toTimings(entry);

  const harEntry = {
    pageref: PAGE_ID,
    startedDateTime: new Date(clock(entry)).toISOString(),
    time: sumTimings(timings),
    request: {
      method: entry.method || 'GET',
      url: entry.url,
      httpVersion,
      cookies: parseCookieHeader(findHeader(requestHeaders, 'cookie')),
      headers: requestHeaders,
      queryString: toQueryString(entry.url),
      headersSize: -1,
      bodySize: entry.postData ? Buffer.byteLength(entry.postData) : 0,
    },
    response: toHarResponse(entry, responseHeaders, httpVersion, bodyResult),
    cache: {},
    timings,
    _resourceType: (entry.resourceType || 'Other').toLowerCase(),
  };

  if (entry.postData) {
    harEntry.request.postData = {
      mimeType: findHeader(requestHeaders, 'content-type') || '',
      text: entry.postData,
    };
  }
  if (entry.remoteIPAddress) harEntry.serverIPAddress = entry.remoteIPAddress;
  if (entry.initiator) harEntry._initiator = entry.initiator;
  if (entry.id !== entry.cdpRequestId) harEntry._requestId = entry.id;

  return harEntry;
}

/** @private */
function toHarResponse(entry, headers, httpVersion, bodyResult) {
  const headersSize = entry.rawResponseHeadersText
    ? Buffer.byteLength(entry.rawResponseHeadersText)
    : -1;
  const bodySize =
    entry.encodedDataLength != null && headersSize >= 0
      ? Math.max(0, entry.encodedDataLength - headersSize)
      : -1;

  const response = {
    status: entry.failed && !entry.status ? 0 : entry.status || 0,
    statusText: entry.statusText || '',
    httpVersion,
    cookies: parseSetCookieHeaders(headers),
    headers,
    content: toContent(entry, bodyResult),
    redirectURL: entry.redirectedTo || findHeader(headers, 'location') || '',
    headersSize,
    bodySize,
  };
  if (entry.failed) response._error = entry.errorText;
  return response;
}

/** @private */
function toContent(entry, bodyResult) {
  const content = { size: 0, mimeType: entry.mimeType || 'x-unknown' };

  if (bodyResult?.body !== undefined && bodyResult?.body !== null) {
    content.text = bodyResult.body;
    if (bodyResult.base64Encoded) {
      content.encoding = 'base64';
      content.size = Buffer.from(bodyResult.body, 'base64').length;
    } else {
      content.size = Buffer.byteLength(bodyResult.body);
    }
  } else if (bodyResult?.error) {
    // Say why the body is missing so an absent `text` is not read as an empty response.
    content.comment = `body not captured: ${bodyResult.error}`;
  }
  return content;
}

/**
 * Maps CDP ResourceTiming (ms offsets from `requestTime`) onto HAR phases. Without it, the
 * whole duration is booked as `wait`, and unknown phases are -1 as the spec requires.
 * @private
 */
function toTimings(entry) {
  const total = Math.max(0, entry.durationMs || 0);
  const t = entry.timing;
  if (!t) {
    return { blocked: -1, dns: -1, connect: -1, send: 0, wait: total, receive: 0, ssl: -1 };
  }

  const span = (start, end) => (start >= 0 && end >= start ? round(end - start) : -1);
  const queued =
    entry.startTime && t.requestTime ? Math.max(0, t.requestTime * 1000 - entry.startTime) : 0;
  const firstActivity = [t.dnsStart, t.connectStart, t.sendStart].find((v) => v >= 0) ?? 0;

  const timings = {
    blocked: round(queued + firstActivity),
    dns: span(t.dnsStart, t.dnsEnd),
    connect: span(t.connectStart, t.connectEnd),
    send: Math.max(0, span(t.sendStart, t.sendEnd)),
    wait: Math.max(0, span(t.sendEnd, t.receiveHeadersEnd)),
    receive: 0,
    ssl: span(t.sslStart, t.sslEnd),
  };
  // Whatever the phases do not account for is the body download.
  timings.receive = round(Math.max(0, total - sumTimings(timings)));
  return timings;
}

/** HAR `time` is the sum of phases, excluding ssl, which `connect` already contains. */
function sumTimings(timings) {
  return round(
    ['blocked', 'dns', 'connect', 'send', 'wait', 'receive']
      .map((k) => timings[k])
      .filter((v) => v > 0)
      .reduce((sum, v) => sum + v, 0)
  );
}

/**
 * WebSocket entries in the Chrome DevTools HAR shape, `_webSocketMessages`, which Chrome,
 * Firefox, and most HAR viewers read back.
 * @private
 */
function toHarSocketEntry(sock) {
  const request = toHeaderList(sock.handshakeRequest?.headers);
  const response = toHeaderList(sock.handshakeResponse?.headers);
  const started = sock.handshakeRequest?.wallTime
    ? sock.handshakeRequest.wallTime * 1000
    : sock.startTime;

  const entry = {
    pageref: PAGE_ID,
    startedDateTime: new Date(started).toISOString(),
    time: 0,
    request: {
      method: 'GET',
      url: sock.url,
      httpVersion: 'HTTP/1.1',
      cookies: parseCookieHeader(findHeader(request, 'cookie')),
      headers: request,
      queryString: toQueryString(sock.url),
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      status: sock.handshakeResponse?.status || 0,
      statusText: sock.handshakeResponse?.statusText || '',
      httpVersion: 'HTTP/1.1',
      cookies: parseSetCookieHeaders(response),
      headers: response,
      content: { size: 0, mimeType: 'x-unknown' },
      redirectURL: '',
      headersSize: -1,
      bodySize: 0,
    },
    cache: {},
    timings: { blocked: -1, dns: -1, connect: -1, send: 0, wait: 0, receive: 0, ssl: -1 },
    _resourceType: 'websocket',
    _webSocketMessages: sock.frames.map((f) => ({
      type: f.direction === 'sent' ? 'send' : 'receive',
      time: f.wallTime / 1000,
      opcode: f.opcode,
      data: f.payloadData,
    })),
  };
  if (sock.droppedFrames) {
    entry._droppedFrames = sock.droppedFrames;
    entry.comment = `${sock.droppedFrames} oldest frames dropped (maxFramesPerSocket)`;
  }
  return entry;
}

/**
 * CDP folds repeated headers into one value joined by newlines (Set-Cookie especially);
 * HAR wants one name/value pair per line.
 * @private
 */
function toHeaderList(headers) {
  if (!headers) return [];
  return Object.entries(headers).flatMap(([name, value]) =>
    String(value)
      .split('\n')
      .map((line) => ({ name, value: line }))
  );
}

/** @private */
function findHeader(headers, name) {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value || null;
}

/** @private */
function toHttpVersion(protocol) {
  if (!protocol) return '';
  const p = protocol.toLowerCase();
  if (p === 'h2' || p.startsWith('http/2')) return 'HTTP/2';
  if (p === 'h3' || p.startsWith('http/3') || p.startsWith('quic')) return 'HTTP/3';
  return protocol.toUpperCase();
}

/** @private */
function toQueryString(url) {
  try {
    return Array.from(new URL(url).searchParams, ([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

/** @private */
function parseCookieHeader(value) {
  if (!value) return [];
  return value
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=');
      return eq === -1
        ? { name: part, value: '' }
        : { name: part.slice(0, eq), value: part.slice(eq + 1) };
    });
}

/** @private */
function parseSetCookieHeaders(headers) {
  return headers
    .filter((h) => h.name.toLowerCase() === 'set-cookie')
    .map(({ value }) => {
      const [pair, ...attrs] = value.split(';').map((s) => s.trim());
      const [cookie] = parseCookieHeader(pair);
      if (!cookie) return null;
      for (const attr of attrs) {
        const eq = attr.indexOf('=');
        const key = (eq === -1 ? attr : attr.slice(0, eq)).toLowerCase();
        const val = eq === -1 ? '' : attr.slice(eq + 1);
        if (key === 'path') cookie.path = val;
        else if (key === 'domain') cookie.domain = val;
        else if (key === 'expires') {
          const date = new Date(val);
          if (!Number.isNaN(date.getTime())) cookie.expires = date.toISOString();
        } else if (key === 'httponly') cookie.httpOnly = true;
        else if (key === 'secure') cookie.secure = true;
        else if (key === 'samesite') cookie.sameSite = val;
      }
      return cookie;
    })
    .filter(Boolean);
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

module.exports = { buildHar, isHarEntry };
