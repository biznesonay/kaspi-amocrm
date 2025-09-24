import test from 'node:test';
import assert from 'node:assert/strict';

process.env.KASPI_API_TOKEN = 'test-token';
process.env.KASPI_ALLOWED_STATES = 'NEW';
process.env.KASPI_PAGE_SIZE = '2';
process.env.AMO_BASE_URL = 'https://example.amocrm.ru';
process.env.AMO_CLIENT_ID = 'client-id';
process.env.AMO_CLIENT_SECRET = 'client-secret';
process.env.AMO_REDIRECT_URI = 'https://example.com/callback';
process.env.AMO_ACCESS_TOKEN = 'access-token';
process.env.AMO_REFRESH_TOKEN = 'refresh-token';
process.env.AMO_PIPELINE_ID = '1';
process.env.AMO_STATUS_ID = '1';
process.env.DB_URL = 'file:memdb-poll?mode=memory&cache=shared';
process.env.DB_CLIENT = 'sqlite';
process.env.DRY_RUN = 'false';
process.env.LOG_LEVEL = 'fatal';
process.env.USE_FREE_POSITIONS = 'false';
process.env.ALERT_BACKLOG_THRESHOLD = '1';

const initialSigtermHandlers = process.listeners('SIGTERM');
const initialSigintHandlers = process.listeners('SIGINT');

const { default: config } = await import('../src/config/env.js');
const { pollAndCreate } = await import('../src/poll-and-create.js');
const { default: repository } = await import('../src/db/repository.js');
const { default: kaspiService } = await import('../src/services/kaspi.js');
const { default: alertService } = await import('../src/utils/alerts.js');
const { default: db } = await import('../src/config/database.js');

const addedSigtermHandlers = process
  .listeners('SIGTERM')
  .filter(handler => !initialSigtermHandlers.includes(handler));
const addedSigintHandlers = process
  .listeners('SIGINT')
  .filter(handler => !initialSigintHandlers.includes(handler));

const removeAddedSignalHandlers = () => {
  for (const handler of addedSigtermHandlers) {
    process.removeListener('SIGTERM', handler);
  }
  for (const handler of addedSigintHandlers) {
    process.removeListener('SIGINT', handler);
  }
};

removeAddedSignalHandlers();

const sampleOrder = {
  id: '1',
  code: 'ORDER-1',
  totalPrice: 1000,
  state: 'NEW',
  createdAt: new Date().toISOString(),
  buyer: {},
  items: []
};

function stubAsyncMethod(target, methodName, implementation = async () => {}) {
  const descriptor = Object.getOwnPropertyDescriptor(target, methodName);
  const original = descriptor?.value ?? target[methodName];
  const calls = [];
  const wrapped = async function(...args) {
    calls.push(args);
    return await implementation.apply(this, args);
  };
  if (descriptor && descriptor.configurable === true) {
    Object.defineProperty(target, methodName, {
      value: wrapped,
      configurable: true,
      enumerable: descriptor.enumerable,
      writable: true
    });
    return {
      calls,
      restore: () => {
        Object.defineProperty(target, methodName, descriptor);
      }
    };
  }

  target[methodName] = wrapped;
  return { calls, restore: () => { target[methodName] = original; } };
}

function stubMethod(target, methodName, implementation = () => undefined) {
  const descriptor = Object.getOwnPropertyDescriptor(target, methodName);
  const original = descriptor?.value ?? target[methodName];
  const calls = [];
  const wrapped = function(...args) {
    calls.push(args);
    return implementation.apply(this, args);
  };
  if (descriptor && descriptor.configurable === true) {
    Object.defineProperty(target, methodName, {
      value: wrapped,
      configurable: true,
      enumerable: descriptor.enumerable,
      writable: true
    });
    return {
      calls,
      restore: () => {
        Object.defineProperty(target, methodName, descriptor);
      }
    };
  }

  target[methodName] = wrapped;
  return { calls, restore: () => { target[methodName] = original; } };
}

test('dry run skips persistence and alerts', async () => {
  const originalDryRun = config.DRY_RUN;
  config.DRY_RUN = true;

  const restorers = [];

  const registerAsyncStub = (target, method, impl) => {
    const stub = stubAsyncMethod(target, method, impl);
    restorers.push(stub.restore);
    return stub;
  };

  const registerStub = (target, method, impl) => {
    const stub = stubMethod(target, method, impl);
    restorers.push(stub.restore);
    return stub;
  };

  const acquireLockStub = registerAsyncStub(repository, 'acquireLock', async () => true);
  registerAsyncStub(db, 'raw', async () => 1);
  registerAsyncStub(repository, 'releaseLock', async () => {});
  registerAsyncStub(repository, 'getProcessedOrder', async () => null);
  registerAsyncStub(repository, 'saveProcessedOrder', async () => {});
  const updateDailyStatsStub = registerAsyncStub(repository, 'updateDailyStats', async () => {});
  const getMetaStub = registerAsyncStub(repository, 'getMeta', async () => '0');
  const setMetaStub = registerAsyncStub(repository, 'setMeta', async () => {});
  const resetFailuresStub = registerAsyncStub(repository, 'resetFailures', async () => {});
  const updateHeartbeatStub = registerAsyncStub(repository, 'updateHeartbeat', async () => {});
  const sendWarningStub = registerAsyncStub(alertService, 'sendWarningAlert', async () => {});
  registerStub(kaspiService, 'calculateChecksum', () => 'checksum');
  registerAsyncStub(kaspiService, 'getAllOrders', async () => [sampleOrder]);

  try {
    await pollAndCreate();

    assert.equal(acquireLockStub.calls.length, 1, 'ожидался захват лока');
    assert.equal(updateDailyStatsStub.calls.length, 0, 'не должно обновляться daily_stats в DRY_RUN');
    assert.equal(getMetaStub.calls.length, 0, 'не должно считываться meta в DRY_RUN');
    assert.equal(setMetaStub.calls.length, 0, 'не должно обновляться meta в DRY_RUN');
    assert.equal(resetFailuresStub.calls.length, 0, 'не должен сбрасываться счетчик ошибок в DRY_RUN');
    assert.equal(updateHeartbeatStub.calls.length, 0, 'не должен обновляться heartbeat в DRY_RUN');
    assert.equal(sendWarningStub.calls.length, 0, 'не должно отправляться предупреждение о backlog в DRY_RUN');
  } finally {
    config.DRY_RUN = originalDryRun;
    removeAddedSignalHandlers();
    while (restorers.length > 0) {
      const restore = restorers.pop();
      restore();
    }
  }
});

test('normal run updates stats, meta and alerts', async () => {
  const originalDryRun = config.DRY_RUN;
  config.DRY_RUN = false;

  const restorers = [];

  const registerAsyncStub = (target, method, impl) => {
    const stub = stubAsyncMethod(target, method, impl);
    restorers.push(stub.restore);
    return stub;
  };

  const registerStub = (target, method, impl) => {
    const stub = stubMethod(target, method, impl);
    restorers.push(stub.restore);
    return stub;
  };

  registerAsyncStub(repository, 'acquireLock', async () => true);
  registerAsyncStub(db, 'raw', async () => 1);
  registerAsyncStub(repository, 'releaseLock', async () => {});
  registerAsyncStub(repository, 'getProcessedOrder', async () => null);
  registerAsyncStub(repository, 'saveProcessedOrder', async () => {});
  const updateDailyStatsStub = registerAsyncStub(repository, 'updateDailyStats', async () => {});
  const getMetaStub = registerAsyncStub(repository, 'getMeta', async () => '0');
  const setMetaStub = registerAsyncStub(repository, 'setMeta', async () => {});
  const resetFailuresStub = registerAsyncStub(repository, 'resetFailures', async () => {});
  const updateHeartbeatStub = registerAsyncStub(repository, 'updateHeartbeat', async () => {});
  const sendWarningStub = registerAsyncStub(alertService, 'sendWarningAlert', async () => {});
  registerStub(kaspiService, 'calculateChecksum', () => 'checksum');
  registerAsyncStub(kaspiService, 'getAllOrders', async () => [sampleOrder]);

  try {
    await pollAndCreate();

    assert.equal(updateDailyStatsStub.calls.length, 1, 'должно обновляться daily_stats в обычном режиме');
    assert.equal(getMetaStub.calls.length, 2, 'должно считываться meta для статистики');
    assert.equal(setMetaStub.calls.length, 2, 'должно обновляться meta для статистики');
    assert.equal(resetFailuresStub.calls.length, 1, 'должен сбрасываться счетчик ошибок в обычном режиме');
    assert.equal(updateHeartbeatStub.calls.length, 1, 'должен обновляться heartbeat в обычном режиме');
    assert.equal(sendWarningStub.calls.length, 1, 'должно отправляться предупреждение о backlog при достижении порога');
  } finally {
    config.DRY_RUN = originalDryRun;
    removeAddedSignalHandlers();
    while (restorers.length > 0) {
      const restore = restorers.pop();
      restore();
    }
  }
});

