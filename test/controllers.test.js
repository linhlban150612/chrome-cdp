'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');

const WorkerController = require('../src/worker-controller');
const SourceController = require('../src/source-controller');
const ConsoleController = require('../src/console-controller');

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
  await new Promise((r) => setTimeout(r, 20));

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
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(controller.list().length, 1, 'Unrelated "other" target should be ignored');

  // 3. Service worker: CDP raw type 'service_worker'
  const serviceWorker = createMockTarget({
    rawType: 'service_worker',
    puppeteerType: 'service_worker',
    targetId: 'sw-target-3',
    url: 'https://example.com/sw.js',
  });
  browserEmitter.emit('targetcreated', serviceWorker);
  await new Promise((r) => setTimeout(r, 20));

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
  await new Promise((r) => setTimeout(r, 20));

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
