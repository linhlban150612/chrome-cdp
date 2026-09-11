'use strict';

const EventEmitter = require('node:events');
const matchesQuery = require('./match-query');

/**
 * Advanced Network Controller built on raw Chrome DevTools Protocol (CDP) events.
 * Captures raw headers, unnormalized pseudo-headers, raw request POST data,
 * response bodies, cookies, and formats traffic for security research and reverse engineering.
 */
class NetworkController extends EventEmitter {
  /**
   * @param {import('puppeteer').Page} page
   * @param {import('puppeteer').CDPSession} cdpSession
   */
  constructor(page, cdpSession) {
    super();
    if (!page) throw new TypeError('Page instance is required for NetworkController');
    if (!cdpSession) throw new TypeError('CDPSession is required for NetworkController');

    this._page = page;
    this._cdp = cdpSession;
    /** @type {Map<string, object>} */
    this._entries = new Map();
    this._isRecording = false;

    this._onRequestWillBeSent = this._onRequestWillBeSent.bind(this);
    this._onRequestExtraInfo = this._onRequestExtraInfo.bind(this);
    this._onResponseReceived = this._onResponseReceived.bind(this);
    this._onResponseExtraInfo = this._onResponseExtraInfo.bind(this);
    this._onLoadingFinished = this._onLoadingFinished.bind(this);
    this._onLoadingFailed = this._onLoadingFailed.bind(this);
  }

  /**
   * Initializes network domain and hooks into raw CDP network events.
   * @returns {Promise<void>}
   */
  async startRecording() {
    if (this._isRecording) return;

    this._cdp.on('Network.requestWillBeSent', this._onRequestWillBeSent);
    this._cdp.on('Network.requestWillBeSentExtraInfo', this._onRequestExtraInfo);
    this._cdp.on('Network.responseReceived', this._onResponseReceived);
    this._cdp.on('Network.responseReceivedExtraInfo', this._onResponseExtraInfo);
    this._cdp.on('Network.loadingFinished', this._onLoadingFinished);
    this._cdp.on('Network.loadingFailed', this._onLoadingFailed);

    await this._cdp.send('Network.enable');
    this._isRecording = true;
  }

  /**
   * Stops capturing network traffic.
   */
  stopRecording() {
    if (!this._isRecording) return;

    this._cdp.off('Network.requestWillBeSent', this._onRequestWillBeSent);
    this._cdp.off('Network.requestWillBeSentExtraInfo', this._onRequestExtraInfo);
    this._cdp.off('Network.responseReceived', this._onResponseReceived);
    this._cdp.off('Network.responseReceivedExtraInfo', this._onResponseExtraInfo);
    this._cdp.off('Network.loadingFinished', this._onLoadingFinished);
    this._cdp.off('Network.loadingFailed', this._onLoadingFailed);

    this._isRecording = false;
  }

  /**
   * Clears recorded network history.
   */
  clear() {
    this._entries.clear();
  }

  /**
   * Retrieves recorded network traffic with optional filtering.
   * @param {{
   *   url?: string | RegExp,
   *   method?: string,
   *   resourceType?: string,
   *   status?: number,
   *   failedOnly?: boolean
   * }} [filter]
   * @returns {Array<object>}
   */
  getTraffic(filter = {}) {
    const list = Array.from(this._entries.values());
    return list.filter((item) => {
      if (filter.url) {
        const matches = matchesQuery(item.url, filter.url);
        if (!matches) return false;
      }
      if (filter.method && item.method?.toUpperCase() !== filter.method.toUpperCase()) {
        return false;
      }
      if (filter.resourceType && item.resourceType !== filter.resourceType) {
        return false;
      }
      if (filter.status !== undefined && item.status !== filter.status) {
        return false;
      }
      if (filter.failedOnly && !item.failed) {
        return false;
      }
      return true;
    });
  }

  /**
   * Resolves a target entry ID by either requestId, URL string, or RegExp.
   * @param {string | { url?: string | RegExp, requestId?: string }} query
   * @returns {string}
   * @private
   */
  _resolveRequestId(query) {
    if (typeof query === 'string') {
      if (this._entries.has(query)) {
        return query;
      }
      const entry = this.getTraffic({ url: query })[0];
      if (entry) return entry.id;
    } else if (query && query.requestId) {
      return query.requestId;
    } else if (query && query.url) {
      const entry = this.getTraffic({ url: query.url })[0];
      if (entry) return entry.id;
    }
    throw new Error(`No recorded network entry found for query: ${JSON.stringify(query)}`);
  }

  /**
   * Reads the raw POST data / request payload via direct CDP call.
   * @param {string | { url?: string | RegExp, requestId?: string }} query
   * @returns {Promise<string | null>}
   */
  async getRequestPostData(query) {
    const requestId = this._resolveRequestId(query);
    const entry = this._entries.get(requestId);

    try {
      const res = await this._cdp.send('Network.getRequestPostData', { requestId });
      if (res && res.postData) {
        if (entry) entry.postData = res.postData;
        return res.postData;
      }
    } catch {
      // Fall back to cached postData captured during requestWillBeSent
      if (entry && entry.postData) {
        return entry.postData;
      }
    }
    return entry?.postData || null;
  }

  /**
   * Reads the response body of a request via direct CDP Network.getResponseBody.
   * @param {string | { url?: string | RegExp, requestId?: string }} query
   * @returns {Promise<{ body: string, base64Encoded: boolean, parsedJson?: object | null }>}
   */
  async getResponseBody(query) {
    const requestId = this._resolveRequestId(query);
    const entry = this._entries.get(requestId);

    try {
      const result = await this._cdp.send('Network.getResponseBody', {
        requestId,
      });

      let parsedJson = null;
      if (!result.base64Encoded && typeof result.body === 'string') {
        const trimmed = result.body.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try {
            parsedJson = JSON.parse(trimmed);
          } catch {}
        }
      }

      if (entry) {
        entry.responseBody = result.body;
        entry.responseBase64 = result.base64Encoded || false;
      }

      return {
        body: result.body,
        base64Encoded: result.base64Encoded || false,
        parsedJson,
      };
    } catch (err) {
      throw new Error(`Failed to retrieve response body for request ${requestId}: ${err.message}`);
    }
  }

  /**
   * Generates a raw HTTP request string suitable for Burp Suite Repeater or analysis.
   * @param {string | { url?: string | RegExp, requestId?: string }} query
   * @returns {Promise<string>}
   */
  async toRawRequest(query) {
    const requestId = this._resolveRequestId(query);
    const entry = this._entries.get(requestId);
    if (!entry) throw new Error(`Entry not found: ${requestId}`);

    const parsedUrl = new URL(entry.url);
    const pathAndQuery = `${parsedUrl.pathname}${parsedUrl.search}`;
    const method = entry.method || 'GET';
    const httpVersion = entry.protocol?.toUpperCase().includes('HTTP/2') ? 'HTTP/2' : 'HTTP/1.1';

    const lines = [`${method} ${pathAndQuery} ${httpVersion}`];

    // Priority to rawHeaders from ExtraInfo, otherwise headers
    const headers = entry.rawHeaders || entry.headers || {};
    if (!headers['host'] && !headers['Host']) {
      lines.push(`Host: ${parsedUrl.host}`);
    }

    for (const [k, v] of Object.entries(headers)) {
      if (k.startsWith(':')) continue; // Skip HTTP/2 pseudo-headers in raw text
      lines.push(`${k}: ${v}`);
    }

    const postData = await this.getRequestPostData(requestId);
    if (postData) {
      lines.push('');
      lines.push(postData);
    }

    return lines.join('\r\n');
  }

  /**
   * Generates a raw HTTP response string suitable for security auditing.
   * @param {string | { url?: string | RegExp, requestId?: string }} query
   * @returns {Promise<string>}
   */
  async toRawResponse(query) {
    const requestId = this._resolveRequestId(query);
    const entry = this._entries.get(requestId);
    if (!entry) throw new Error(`Entry not found: ${requestId}`);

    const lines = [];
    if (entry.rawResponseHeadersText) {
      lines.push(entry.rawResponseHeadersText.trim());
    } else {
      const httpVersion = entry.protocol?.toUpperCase().includes('HTTP/2') ? 'HTTP/2' : 'HTTP/1.1';
      lines.push(`${httpVersion} ${entry.status || 200} ${entry.statusText || 'OK'}`);
      const headers = entry.rawResponseHeaders || entry.responseHeaders || {};
      for (const [k, v] of Object.entries(headers)) {
        if (k.startsWith(':')) continue;
        lines.push(`${k}: ${v}`);
      }
    }

    try {
      const { body, base64Encoded } = await this.getResponseBody(requestId);
      lines.push('');
      lines.push(base64Encoded ? `[Base64 Encoded Binary: ${body.slice(0, 80)}...]` : body);
    } catch {}

    return lines.join('\r\n');
  }

  /**
   * Searches across all captured HTTP requests and responses for strings or regex.
   * Searches in URL, Request Headers, Request Body, and Response Headers.
   * @param {string | RegExp} query
   * @returns {Array<object>}
   */
  searchTraffic(query) {
    const isRegex = query instanceof RegExp;
    const test = (str) => {
      if (typeof str !== 'string') return false;
      if (!isRegex) return str.includes(query);
      query.lastIndex = 0;
      return query.test(str);
    };

    const matches = [];
    for (const entry of this._entries.values()) {
      const matchDetails = [];

      if (test(entry.url)) matchDetails.push('url');
      if (test(entry.postData)) matchDetails.push('postData');
      if (test(JSON.stringify(entry.headers))) matchDetails.push('requestHeaders');
      if (test(JSON.stringify(entry.rawHeaders))) matchDetails.push('rawHeaders');
      if (test(JSON.stringify(entry.responseHeaders))) matchDetails.push('responseHeaders');
      if (test(entry.rawResponseHeadersText)) matchDetails.push('rawResponseHeadersText');

      if (matchDetails.length > 0) {
        matches.push({
          requestId: entry.id,
          url: entry.url,
          method: entry.method,
          status: entry.status,
          matchedFields: matchDetails,
          entry,
        });
      }
    }
    return matches;
  }

  /**
   * Retrieves cookies for the current page or specified URLs via CDP.
   * @param {Array<string>} [urls]
   * @returns {Promise<Array<object>>}
   */
  async getCookies(urls) {
    const params = urls && urls.length > 0 ? { urls } : {};
    const res = await this._cdp.send('Network.getCookies', params);
    return res.cookies || [];
  }

  /**
   * Clears browser cache via CDP.
   * @returns {Promise<void>}
   */
  async clearCache() {
    await this._cdp.send('Network.clearBrowserCache');
  }

  /**
   * Clears browser cookies via CDP.
   * @returns {Promise<void>}
   */
  async clearCookies() {
    await this._cdp.send('Network.clearBrowserCookies');
  }

  /**
   * @private
   */
  _getOrCreateEntry(id) {
    if (!this._entries.has(id)) {
      this._entries.set(id, {
        id,
        url: '',
        method: 'GET',
        resourceType: 'Other',
        headers: {},
        rawHeaders: null,
        postData: null,
        startTime: Date.now(),
        status: null,
        statusText: null,
        responseHeaders: null,
        rawResponseHeaders: null,
        rawResponseHeadersText: null,
        mimeType: null,
        remoteIPAddress: null,
        remotePort: null,
        protocol: null,
        encodedDataLength: null,
        durationMs: null,
        failed: false,
        errorText: null,
      });
    }
    return this._entries.get(id);
  }

  /**
   * @private
   */
  _onRequestWillBeSent(event) {
    const entry = this._getOrCreateEntry(event.requestId);
    entry.url = event.request.url;
    entry.method = event.request.method;
    entry.headers = event.request.headers;
    entry.postData = event.request.postData || null;
    entry.resourceType = event.type || 'Other';
    entry.startTime = event.timestamp * 1000;
    entry.wallTime = event.wallTime;
    entry.initiator = event.initiator;

    this.emit('request', entry);
  }

  /**
   * @private
   */
  _onRequestExtraInfo(event) {
    const entry = this._getOrCreateEntry(event.requestId);
    entry.rawHeaders = event.headers;
    entry.associatedCookies = event.associatedCookies || [];
    entry.clientSecurityState = event.clientSecurityState || null;
  }

  /**
   * @private
   */
  _onResponseReceived(event) {
    const entry = this._getOrCreateEntry(event.requestId);
    const resp = event.response;
    entry.status = resp.status;
    entry.statusText = resp.statusText;
    entry.responseHeaders = resp.headers;
    entry.mimeType = resp.mimeType;
    entry.remoteIPAddress = resp.remoteIPAddress || null;
    entry.remotePort = resp.remotePort || null;
    entry.protocol = resp.protocol || null;
    entry.securityState = resp.securityState || null;

    if (entry.startTime) {
      entry.durationMs = Math.round(event.timestamp * 1000 - entry.startTime);
    }

    this.emit('response', entry);
  }

  /**
   * @private
   */
  _onResponseExtraInfo(event) {
    const entry = this._getOrCreateEntry(event.requestId);
    entry.rawResponseHeaders = event.headers;
    entry.rawResponseHeadersText = event.headersText || null;
    entry.rawStatusCode = event.statusCode;
  }

  /**
   * @private
   */
  _onLoadingFinished(event) {
    const entry = this._getOrCreateEntry(event.requestId);
    entry.encodedDataLength = event.encodedDataLength;
    if (entry.startTime) {
      entry.durationMs = Math.round(event.timestamp * 1000 - entry.startTime);
    }
    this.emit('finished', entry);
  }

  /**
   * @private
   */
  _onLoadingFailed(event) {
    const entry = this._getOrCreateEntry(event.requestId);
    entry.failed = true;
    entry.errorText = event.errorText || 'Loading failed';
    entry.canceled = event.canceled || false;
    this.emit('failed', entry);
  }
}

module.exports = NetworkController;
