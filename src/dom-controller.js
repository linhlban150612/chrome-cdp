'use strict';

const cheerio = require('cheerio');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const TurndownService = require('turndown');
const { gfm } = require('turndown-plugin-gfm');

/**
 * Controller for DOM queries, interactions, security inspections, and content extraction.
 */
class DOMController {
  /**
   * @param {import('puppeteer').Page} page
   * @param {import('puppeteer').CDPSession} [cdpSession]
   */
  constructor(page, cdpSession = null) {
    if (!page) throw new TypeError('Page instance is required for DOMController');
    this._page = page;
    this._cdp = cdpSession;
  }

  /**
   * Sets or updates active CDP session.
   * @param {import('puppeteer').CDPSession} cdpSession
   */
  setCDPSession(cdpSession) {
    this._cdp = cdpSession;
  }

  /**
   * Finds a single element matching selector.
   * @param {string} selector
   * @returns {Promise<import('puppeteer').ElementHandle | null>}
   */
  async $(selector) {
    return this._page.$(selector);
  }

  /**
   * Finds all elements matching selector.
   * @param {string} selector
   * @returns {Promise<Array<import('puppeteer').ElementHandle>>}
   */
  async $$(selector) {
    return this._page.$$(selector);
  }

  /**
   * Clicks an element matching selector.
   * Uses direct DOM focus and click to prevent IntersectionObserver hang in background/minimized windows.
   * @param {string} selector
   * @param {import('puppeteer').ClickOptions} [options]
   */
  async click(selector, options) {
    await this._page.waitForSelector(selector);
    try {
      await this._page.$eval(selector, (el) => {
        if (typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ block: 'center', inline: 'center' });
        }
        if (typeof el.focus === 'function') {
          el.focus();
        }
        el.click();
      });
    } catch {
      await this._page.click(selector, options);
    }
  }

  /**
   * Types text into an element matching selector.
   * @param {string} selector
   * @param {string} text
   * @param {{ delay?: number }} [options]
   */
  async type(selector, text, options) {
    await this._page.waitForSelector(selector, { visible: true });
    await this._page.type(selector, text, options);
  }

  /**
   * Clears existing value and sets new value for an input or textarea element.
   * @param {string} selector
   * @param {string} value
   */
  async fill(selector, value) {
    await this._page.waitForSelector(selector, { visible: true });
    await this._page.evaluate(
      (sel, val) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error(`Element not found: ${sel}`);
        el.value = val;
        el.setAttribute('value', val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      },
      selector,
      value
    );
  }

  /**
   * Gets current value of an input or textarea element.
   * @param {string} selector
   * @returns {Promise<string>}
   */
  async getValue(selector) {
    await this._page.waitForSelector(selector);
    return this._page.$eval(selector, (el) => el.value);
  }

  /**
   * Gets trimmed text content of an element.
   * @param {string} selector
   * @returns {Promise<string>}
   */
  async getText(selector) {
    await this._page.waitForSelector(selector);
    return this._page.$eval(selector, (el) => el.textContent.trim());
  }

  /**
   * Gets attribute value of an element.
   * @param {string} selector
   * @param {string} attribute
   * @returns {Promise<string | null>}
   */
  async getAttribute(selector, attribute) {
    await this._page.waitForSelector(selector);
    return this._page.$eval(selector, (el, attr) => el.getAttribute(attr), attribute);
  }

  /**
   * Gets outer HTML of element matching selector.
   * @param {string} selector
   * @returns {Promise<string>}
   */
  async getOuterHtml(selector) {
    await this._page.waitForSelector(selector);
    return this._page.$eval(selector, (el) => el.outerHTML);
  }

  /**
   * Gets full page HTML.
   * @returns {Promise<string>}
   */
  async getHtml() {
    return this._page.content();
  }

  /**
   * Inspects detailed properties of an element (attributes, computed styles, visibility, rect).
   * @param {string} selector
   * @returns {Promise<object>}
   */
  async inspectElement(selector) {
    await this._page.waitForSelector(selector);
    const elementData = await this._page.$eval(selector, (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);

      const attributes = {};
      for (const attr of el.attributes) {
        attributes[attr.name] = attr.value;
      }

      const isVisible = !(
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number.parseFloat(style.opacity) === 0 ||
        rect.width === 0 ||
        rect.height === 0
      );

      return {
        tagName: el.tagName.toLowerCase(),
        id: el.id || '',
        className: el.className || '',
        attributes,
        value: el.value !== undefined ? el.value : null,
        text: el.textContent?.trim() || '',
        isVisible,
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
        computedStyle: {
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          zIndex: style.zIndex,
          position: style.position,
        },
        hasShadowRoot: Boolean(el.shadowRoot),
      };
    });

    if (this._cdp) {
      try {
        elementData.eventListeners = await this.getEventListeners(selector);
      } catch {
        elementData.eventListeners = [];
      }
    }

    return elementData;
  }

  /**
   * Audits registered DOM event listeners on an element, 'window', or 'document' via CDP DOMDebugger.
   * Crucial for finding DOM XSS sinks, PostMessage handlers, and hidden action handlers.
   * @param {string} [target='window'] - CSS selector or 'window' or 'document'
   * @returns {Promise<Array<object>>}
   */
  async getEventListeners(target = 'window') {
    if (!this._cdp) {
      throw new Error('CDPSession is required to audit event listeners via DOMDebugger');
    }

    let expression;
    if (target === 'window') {
      expression = 'window';
    } else if (target === 'document') {
      expression = 'document';
    } else {
      expression = `document.querySelector(${JSON.stringify(target)})`;
    }

    const { result } = await this._cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: false,
    });

    if (!result || result.subtype === 'null' || !result.objectId) {
      throw new Error(`Target not found for event listeners: ${target}`);
    }

    const response = await this._cdp.send('DOMDebugger.getEventListeners', {
      objectId: result.objectId,
      depth: -1,
    });

    return (response.listeners || []).map((l) => ({
      type: l.type,
      useCapture: l.useCapture,
      passive: l.passive,
      once: l.once,
      scriptId: l.scriptId,
      lineNumber: l.lineNumber,
      columnNumber: l.columnNumber,
      handlerDescription: l.handler?.description || null,
    }));
  }

  /**
   * Dumps all HTML forms, methods, actions, and their input fields.
   * Essential for bug bounty parameter and endpoint discovery.
   * @returns {Promise<Array<object>>}
   */
  async dumpForms() {
    return this._page.evaluate(() => {
      return Array.from(document.forms).map((form, index) => {
        const inputs = Array.from(form.elements).map((el) => ({
          name: el.name || '',
          id: el.id || '',
          tagName: el.tagName.toLowerCase(),
          type: el.type || '',
          value: el.value || '',
          required: el.required || false,
          disabled: el.disabled || false,
        }));

        return {
          index,
          id: form.id || '',
          name: form.name || '',
          action: form.action || '',
          method: (form.method || 'GET').toUpperCase(),
          enctype: form.enctype || 'application/x-www-form-urlencoded',
          inputs,
        };
      });
    });
  }

  /**
   * Dumps hidden inputs and elements styled with display:none / visibility:hidden.
   * Frequently used to extract CSRF tokens, internal IDs, and hidden API flags.
   * @returns {Promise<Array<object>>}
   */
  async dumpHiddenInputs() {
    return this._page.evaluate(() => {
      const items = [];

      // Hidden inputs
      document.querySelectorAll('input[type="hidden"]').forEach((el) => {
        items.push({
          category: 'input[type="hidden"]',
          name: el.name || '',
          id: el.id || '',
          value: el.value || '',
          formAction: el.form?.action || null,
        });
      });

      // CSS-hidden elements
      document
        .querySelectorAll('[hidden], [style*="display: none"], [style*="display:none"]')
        .forEach((el) => {
          items.push({
            category: 'css_hidden',
            tagName: el.tagName.toLowerCase(),
            id: el.id || '',
            className: el.className || '',
            text: el.textContent?.trim().slice(0, 100) || '',
          });
        });

      return items;
    });
  }

  /**
   * Dumps localStorage and sessionStorage contents.
   * @returns {Promise<{ localStorage: object, sessionStorage: object }>}
   */
  async dumpStorage() {
    return this._page.evaluate(() => {
      const local = {};
      try {
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i);
          local[k] = window.localStorage.getItem(k);
        }
      } catch {}

      const session = {};
      try {
        for (let i = 0; i < window.sessionStorage.length; i++) {
          const k = window.sessionStorage.key(i);
          session[k] = window.sessionStorage.getItem(k);
        }
      } catch {}

      return {
        localStorage: local,
        sessionStorage: session,
      };
    });
  }

  /**
   * Installs an in-page monitor to audit window.postMessage calls and message event listeners.
   * @returns {Promise<void>}
   */
  async hookPostMessage() {
    await this._page.evaluateOnNewDocument(() => {
      if (window.__postMessageHookInstalled) return;
      window.__postMessageHookInstalled = true;
      window.__postMessageLogs = [];

      const originalAddEventListener = window.addEventListener;
      const originalRemoveEventListener = window.removeEventListener;
      // Keep the wrapper addressable, otherwise the page's own removeEventListener('message', fn)
      // silently does nothing and the handler stays attached for the rest of the session.
      const wrappers = new WeakMap();

      window.addEventListener = function (type, listener, options) {
        if (type === 'message' && listener) {
          let wrappedListener = wrappers.get(listener);
          if (!wrappedListener) {
            wrappedListener = function (event) {
              window.__postMessageLogs.push({
                direction: 'received',
                origin: event.origin,
                data: event.data,
                timestamp: Date.now(),
              });
              return typeof listener === 'function'
                ? listener.apply(this, arguments)
                : listener.handleEvent(event);
            };
            wrappers.set(listener, wrappedListener);
          }
          return originalAddEventListener.call(this, type, wrappedListener, options);
        }
        return originalAddEventListener.apply(this, arguments);
      };

      window.removeEventListener = function (type, listener, options) {
        const wrappedListener = type === 'message' && listener ? wrappers.get(listener) : null;
        if (wrappedListener) {
          return originalRemoveEventListener.call(this, type, wrappedListener, options);
        }
        return originalRemoveEventListener.apply(this, arguments);
      };

      const originalPostMessage = window.postMessage;
      window.postMessage = function (message, targetOrigin, transfer) {
        window.__postMessageLogs.push({
          direction: 'sent',
          targetOrigin,
          data: message,
          timestamp: Date.now(),
        });
        return originalPostMessage.apply(this, arguments);
      };
    });
  }

  /**
   * Retrieves recorded postMessage logs.
   * @returns {Promise<Array<object>>}
   */
  async getPostMessageLogs() {
    return this._page.evaluate(() => window.__postMessageLogs || []);
  }

  /**
   * Loads current page HTML into Cheerio for fast local DOM traversal.
   * @returns {Promise<import('cheerio').CheerioAPI>}
   */
  async toCheerio() {
    const html = await this.getHtml();
    return cheerio.load(html);
  }

  /**
   * Extracts primary article content and converts it to GitHub Flavored Markdown.
   * @param {{ headingStyle?: 'setext' | 'atx', codeBlockStyle?: 'indented' | 'fenced' }} [options]
   * @returns {Promise<{ title: string, byline?: string, excerpt?: string, markdown: string, textContent: string } | null>}
   */
  async toMarkdown(options = {}) {
    const html = await this.getHtml();
    const url = this._page.url();

    const dom = new JSDOM(html, { url });
    let article;
    try {
      article = new Readability(dom.window.document, { keepClasses: false }).parse();
    } finally {
      dom.window.close();
    }

    if (!article?.content) {
      return null;
    }

    const turndown = new TurndownService({
      headingStyle: options.headingStyle || 'atx',
      codeBlockStyle: options.codeBlockStyle || 'fenced',
      hr: '---',
      bulletListMarker: '-',
    });
    turndown.use(gfm);

    const markdownBody = turndown.turndown(article.content);
    const fullMarkdown = article.title
      ? `# ${article.title}\n\n${markdownBody}`
      : markdownBody;

    return {
      title: article.title || '',
      byline: article.byline || '',
      excerpt: article.excerpt || '',
      textContent: article.textContent || '',
      markdown: fullMarkdown,
    };
  }
}

module.exports = DOMController;
