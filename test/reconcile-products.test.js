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
process.env.DRY_RUN = 'false';
process.env.LOG_LEVEL = 'fatal';
process.env.USE_FREE_POSITIONS = 'true';

const kaspiServiceModule = await import('../src/services/kaspi.js');
const kaspiService = kaspiServiceModule.default;
const amoCRMModule = await import('../src/services/amocrm.js');
const amoCRMService = amoCRMModule.default;
const repositoryModule = await import('../src/db/repository.js');
const repository = repositoryModule.default;
const dbModule = await import('../src/config/database.js');
const db = dbModule.default;
const migrateModule = await import('../src/db/migrate.js');
const runMigrations = migrateModule.default;
const reconcileModule = await import('../src/reconcile.js');
const { reconcileOrder } = reconcileModule;

await runMigrations();

test('повторная сверка заменяет старые позиции актуальными данными', async () => {
  const leadId = 555555;

  let linkedItemsState = [
    { id: 101, catalog_id: -1, name: 'Старый товар', quantity: 1, price: 3000 },
    { id: 102, catalog_id: -1, name: 'Еще старый товар', quantity: 2, price: 4000 },
  ];

  let unlinkCalls = 0;
  let linkCalls = 0;
  const unlinkPayloads = [];
  const linkPayloads = [];
  let updatedLeadPrice = null;
  let noteText = null;
  let savedOrder;

  const originalGetLeadById = amoCRMService.getLeadById;
  const originalClientPost = amoCRMService.client.post;
  const originalUpdateLead = amoCRMService.updateLead;
  const originalAddNoteToLead = amoCRMService.addNoteToLead;
  const originalSaveProcessedOrder = repository.saveProcessedOrder;
  const originalUpdateOrderStats = repository.updateOrderStats;

  amoCRMService.getLeadById = async (requestedLeadId) => {
    assert.equal(requestedLeadId, leadId);
    return {
      id: requestedLeadId,
      _embedded: {
        catalog_elements: linkedItemsState.map(item => ({
          id: item.id,
          catalog_id: item.catalog_id,
          name: item.name,
          quantity: item.quantity,
          price: item.price,
        }))
      }
    };
  };

  amoCRMService.client.post = async (url, payload) => {
    if (url === `/leads/${leadId}/unlink`) {
      unlinkCalls++;
      unlinkPayloads.push(payload);
      const idsToRemove = new Set((payload.catalog_elements || []).map(element => element.id));
      linkedItemsState = linkedItemsState.filter(item => !idsToRemove.has(item.id));
      return { data: { success: true } };
    }

    if (url === `/leads/${leadId}/link`) {
      linkCalls++;
      linkPayloads.push(payload);
      linkedItemsState = (payload.catalog_elements || []).map((element, index) => ({
        id: 1000 + index,
        catalog_id: element.catalog_id,
        name: element.name,
        quantity: element.quantity,
        price: element.price,
      }));
      return { data: { _embedded: { catalog_elements: linkedItemsState } } };
    }

    throw new Error(`Unexpected URL called in test: ${url}`);
  };

  amoCRMService.updateLead = async (requestedLeadId, data) => {
    assert.equal(requestedLeadId, leadId);
    updatedLeadPrice = data.price;
    return { id: requestedLeadId, ...data };
  };

  amoCRMService.addNoteToLead = async (requestedLeadId, text) => {
    assert.equal(requestedLeadId, leadId);
    noteText = text;
    return { id: requestedLeadId, text };
  };

  repository.saveProcessedOrder = async (payload) => {
    savedOrder = payload;
  };

  repository.updateOrderStats = async () => {
    // Статистика не нужна для целей теста
  };

  const kaspiOrder = {
    code: 'ORDER-123',
    totalPrice: 15000,
    state: 'NEW',
    items: [
      { sku: 'SKU-1', name: 'Новый товар', quantity: 1, price: 5000 },
      { sku: 'SKU-2', name: 'Еще товар', quantity: 2, price: 5000 },
    ]
  };

  const processedOrder = {
    amocrm_lead_id: leadId,
    checksum: 'old-checksum',
    kaspi_state: 'NEW',
    retry_count: 2,
  };

  try {
    await reconcileOrder(kaspiOrder, processedOrder);

    assert.equal(unlinkCalls, 1, 'Старые позиции должны быть удалены');
    assert.equal(linkCalls, 1, 'Новые позиции должны быть привязаны один раз');
    assert.equal(unlinkPayloads.length, 1, 'Должна быть отправлена одна операция отвязки');
    assert.equal(linkPayloads.length, 1, 'Должна быть отправлена одна операция привязки');

    assert.deepEqual(
      unlinkPayloads[0].catalog_elements.map(element => element.id),
      [101, 102],
      'Все старые позиции должны быть переданы на отвязку'
    );

    const expectedLinkPayload = kaspiOrder.items.map(item => ({
      name: item.name,
      quantity: item.quantity,
      price: Math.round(item.price),
      catalog_id: -1,
    }));

    assert.deepEqual(
      linkPayloads[0].catalog_elements.map(element => ({
        name: element.name,
        quantity: element.quantity,
        price: element.price,
        catalog_id: element.catalog_id,
      })),
      expectedLinkPayload,
      'Payload привязки должен соответствовать актуальным позициям из Kaspi'
    );

    assert.deepEqual(
      linkedItemsState.map(element => ({
        name: element.name,
        quantity: element.quantity,
        price: element.price,
        catalog_id: element.catalog_id,
      })),
      expectedLinkPayload,
      'После обновления должны остаться только новые позиции без дублей'
    );

    assert.equal(updatedLeadPrice, Math.round(kaspiOrder.totalPrice), 'Сумма сделки должна обновляться');

    const expectedItemsText = kaspiService.formatItemsForNote(kaspiOrder.items);
    assert.ok(noteText.includes(expectedItemsText), 'Заметка должна содержать актуальный список товаров');

    assert.equal(savedOrder.orderCode, kaspiOrder.code);
    assert.equal(savedOrder.leadId, leadId);
    assert.equal(savedOrder.kaspiState, kaspiOrder.state);
    assert.equal(savedOrder.retryCount, 0);
    assert.equal(savedOrder.processingTimeMs, 0);
    assert.equal(savedOrder.checksum, kaspiService.calculateChecksum(kaspiOrder));
  } finally {
    amoCRMService.getLeadById = originalGetLeadById;
    amoCRMService.client.post = originalClientPost;
    amoCRMService.updateLead = originalUpdateLead;
    amoCRMService.addNoteToLead = originalAddNoteToLead;
    repository.saveProcessedOrder = originalSaveProcessedOrder;
    repository.updateOrderStats = originalUpdateOrderStats;
  }
});

test.after(async () => {
  await db.destroy();
});

