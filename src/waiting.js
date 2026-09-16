'use strict';

const DEFAULTS = { timeout: 20000, every: 300, min: 1 };

/**
 * Polls until `fn` returns a ready value. Synchronization, not a claim: on timeout
 * it returns the last value observed, so a partial capture survives.
 * @template T
 * @param {() => T | Promise<T>} fn
 * @param {{ timeout?: number, every?: number, min?: number }} [options]
 * @returns {Promise<T>} The first ready value, else the last one observed.
 */
async function waitUntil(fn, options = {}) {
  const { timeout, every, min } = { ...DEFAULTS, ...options };
  const deadline = Date.now() + timeout;
  let observed = await fn();

  while (!isReady(observed, min) && hasTimeForAnotherPoll(deadline, every)) {
    await sleep(every);
    observed = await fn();
  }

  return observed;
}

/**
 * Polls like `waitUntil`, but throws when the condition never holds. Use it when the
 * next statement is only meaningful if the condition is true.
 * @template T
 * @param {() => T | Promise<T>} fn
 * @param {{ timeout?: number, every?: number, min?: number, describe?: string }} [options]
 * @returns {Promise<T>} The ready value.
 * @throws {Error} When the condition never became ready within the timeout.
 */
async function assertEventually(fn, options = {}) {
  const { min } = { ...DEFAULTS, ...options };
  const observed = await waitUntil(fn, options);
  if (isReady(observed, min)) return observed;
  throw new Error(describeFailedWait(observed, { ...DEFAULTS, ...options }));
}

/**
 * Collects emitted payloads instead of polling for their effects. Returns what it
 * collected, partial included.
 * @param {{ on: Function, off: Function }} emitter
 * @param {string} eventName
 * @param {{ timeout?: number, count?: number, where?: (payload: any) => boolean }} [options]
 * @returns {Promise<any[]>} Collected payloads, in arrival order.
 */
function waitForEvent(emitter, eventName, { timeout = 20000, count = 1, where } = {}) {
  return new Promise((resolve, reject) => {
    const collected = [];
    let timer;

    const settle = (finish) => (value) => {
      clearTimeout(timer);
      emitter.off(eventName, collect);
      finish(value);
    };
    const stopListening = settle(resolve);
    const fail = settle(reject);

    function collect(payload) {
      try {
        if (where && !where(payload)) return;
      } catch (error) {
        fail(error);
        return;
      }
      collected.push(payload);
      if (collected.length >= count) stopListening(collected);
    }

    emitter.on(eventName, collect);
    timer = setTimeout(() => stopListening(collected), timeout);
  });
}

function isReady(value, min) {
  if (!value) return false;
  if (typeof value.length === 'number') return value.length >= min;
  return true;
}

function hasTimeForAnotherPoll(deadline, every) {
  return Date.now() + every < deadline;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeFailedWait(observed, { timeout, min, describe }) {
  const shortfall = min > 1 ? `, needed at least ${min}` : '';
  return (
    `assertEventually: ${describe || 'condition'} never became true within ${timeout}ms ` +
    `(last value: ${summarize(observed)}${shortfall}). ` +
    `Do not report this as "not observed" -- the wait itself failed.`
  );
}

function summarize(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value.length === 'number') return `length ${value.length}`;
  return typeof value;
}

module.exports = { waitUntil, assertEventually, waitForEvent };
