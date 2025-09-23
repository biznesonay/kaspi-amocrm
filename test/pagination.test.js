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
process.env.DB_URL = 'file:memdb1?mode=memory&cache=shared';
process.env.DB_CLIENT = 'sqlite';
process.env.DRY_RUN = 'true';
process.env.LOG_LEVEL = 'fatal';

const kaspiServiceModule = await import('../src/services/kaspi.js');
const kaspiService = kaspiServiceModule.default;
const reconcileModule = await import('../src/reconcile.js');
const { fetchUpdatedKaspiOrders } = reconcileModule;

test('getAllOrders fetches data from all pages', async () => {
  const originalGetOrders = kaspiService.getOrders;
  const calls = [];

  kaspiService.getOrders = async (params) => {
    calls.push(params.page);

    if (params.page === 1) {
      return {
        data: [
          { code: 'ORDER-1' },
          { code: 'ORDER-2' }
        ],
        meta: { page: 1, totalPages: 2, totalCount: 4 }
      };
    }

    if (params.page === 2) {
      return {
        data: [
          { code: 'ORDER-3' },
          { code: 'ORDER-4' }
        ],
        meta: { page: 2, totalPages: 2, totalCount: 4 }
      };
    }

    return { data: [], meta: { page: params.page, totalPages: 2, totalCount: 4 } };
  };

  try {
    const orders = await kaspiService.getAllOrders({ state: ['NEW'] });
    assert.equal(orders.length, 4);
    assert.deepEqual(orders.map(order => order.code), ['ORDER-1', 'ORDER-2', 'ORDER-3', 'ORDER-4']);
    assert.deepEqual(calls, [1, 2]);
  } finally {
    kaspiService.getOrders = originalGetOrders;
  }
});

test('fetchUpdatedKaspiOrders iterates through all pages', async () => {
  const originalMethod = kaspiService.getOrdersUpdatedAfter;
  const requestedPages = [];

  kaspiService.getOrdersUpdatedAfter = async (date, params) => {
    requestedPages.push(params.page);

    if (params.page === 1) {
      return {
        data: [
          { code: 'UPDATED-1' },
          { code: 'UPDATED-2' }
        ],
        meta: { page: 1, totalPages: 3, totalCount: 5 }
      };
    }

    if (params.page === 2) {
      return {
        data: [
          { code: 'UPDATED-3' },
          { code: 'UPDATED-4' }
        ],
        meta: { page: 2, totalPages: 3, totalCount: 5 }
      };
    }

    if (params.page === 3) {
      return {
        data: [
          { code: 'UPDATED-5' }
        ],
        meta: { page: 3, totalPages: 3, totalCount: 5 }
      };
    }

    return { data: [], meta: { page: params.page, totalPages: 3, totalCount: 5 } };
  };

  try {
    const orders = await fetchUpdatedKaspiOrders(new Date('2024-01-01T00:00:00Z'), { state: ['NEW'] });
    assert.equal(orders.length, 5);
    assert.deepEqual(orders.map(order => order.code), [
      'UPDATED-1',
      'UPDATED-2',
      'UPDATED-3',
      'UPDATED-4',
      'UPDATED-5'
    ]);
    assert.deepEqual(requestedPages, [1, 2, 3]);
  } finally {
    kaspiService.getOrdersUpdatedAfter = originalMethod;
  }
});
