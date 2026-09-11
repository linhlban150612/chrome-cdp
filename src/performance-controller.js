'use strict';

const { performance } = require('node:perf_hooks');

/** Lightweight timing, metrics and trace capture for bottleneck analysis. */
class PerformanceController {
  constructor(page, cdp) {
    this._page = page;
    this._cdp = cdp;
    this._tracing = false;
    this._metricsEnabled = false;
  }
  async metrics() {
    if (!this._metricsEnabled) {
      await this._cdp.send('Performance.enable');
      this._metricsEnabled = true;
    }
    const result = await this._cdp.send('Performance.getMetrics');
    return Object.fromEntries((result.metrics || []).map((metric) => [metric.name, metric.value]));
  }
  async startTrace(options = {}) {
    if (this._tracing) throw new Error('A performance trace is already running');
    await this.metrics();
    await this._cdp.send('Tracing.start', {
      categories: options.categories || 'devtools.timeline,v8.execute,disabled-by-default-v8.cpu_profiler',
      transferMode: 'ReturnAsStream',
    });
    this._tracing = true;
  }
  async stopTrace() {
    if (!this._tracing) throw new Error('No performance trace is running');
    let stream;
    try {
      stream = await new Promise((resolve, reject) => {
        const onComplete = (event) => {
          this._cdp.off('Tracing.tracingComplete', onComplete);
          resolve(event.stream);
        };
        this._cdp.on('Tracing.tracingComplete', onComplete);
        this._cdp.send('Tracing.end').catch((error) => {
          this._cdp.off('Tracing.tracingComplete', onComplete);
          reject(error);
        });
      });
    } catch (error) {
      this._tracing = false;
      throw error;
    }
    let trace = '';
    try {
      while (true) {
        const chunk = await this._cdp.send('IO.read', { handle: stream });
        trace += chunk.data || '';
        if (chunk.eof) break;
      }
    } finally {
      await this._cdp.send('IO.close', { handle: stream }).catch(() => {});
      this._tracing = false;
    }
    return trace;
  }
  async measure(fn, ...args) {
    const before = await this.metrics();
    const started = performance.now();
    const value = await this._page.evaluate(fn, ...args);
    return { value, durationMs: performance.now() - started, before, after: await this.metrics() };
  }
}

module.exports = PerformanceController;
