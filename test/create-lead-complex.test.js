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
process.env.DB_URL = 'file:memdb-create-lead?mode=memory&cache=shared';
process.env.DB_CLIENT = 'sqlite';
process.env.DRY_RUN = 'false';
process.env.LOG_LEVEL = 'fatal';
process.env.USE_FREE_POSITIONS = 'false';

const amoCRMModule = await import('../src/services/amocrm.js');
const amoCRMService = amoCRMModule.default;

test('createLeadComplex отправляет catalog_id и возвращает сделку с позициями', async () => {
  const items = [
    { sku: 'SKU-1', name: 'Товар 1', quantity: 2, price: 1500, catalog_id: 321 },
    { sku: 'SKU-2', quantity: '1' },
  ];

  const leadId = 987654;

  const originalClientPost = amoCRMService.client.post;
  let receivedPayload;

  amoCRMService.client.post = async (url, payload) => {
    assert.equal(url, '/leads/complex');
    receivedPayload = payload;

    const responseCatalogElements = (payload[0]?._embedded?.catalog_elements || []).map((element, index) => ({
      id: 100 + index,
      ...element,
    }));

    return {
      data: {
        _embedded: {
          leads: [
            {
              id: leadId,
              ...payload[0],
              _embedded: {
                ...payload[0]._embedded,
                catalog_elements: responseCatalogElements,
              },
            }
          ]
        }
      }
    };
  };

  try {
    const lead = await amoCRMService.createLeadComplex({
      name: 'Kaspi заказ',
      price: 5000,
      contactId: 12345,
      items,
    });

    assert.ok(receivedPayload, 'Ожидался вызов amoCRM API для создания сделки');
    assert.equal(receivedPayload.length, 1, 'Должен быть создан один комплексный запрос');

    const leadPayload = receivedPayload[0];
    assert.ok(Array.isArray(leadPayload._embedded.catalog_elements), 'catalog_elements должен быть массивом');
    assert.equal(leadPayload._embedded.catalog_elements.length, items.length, 'Все позиции должны попасть в payload');

    const payloadElements = leadPayload._embedded.catalog_elements.map(element => ({
      catalog_id: element.catalog_id,
      name: element.name,
      quantity: element.quantity,
      price: element.price,
    }));

    assert.deepEqual(
      payloadElements,
      [
        { catalog_id: 321, name: 'Товар 1', quantity: 2, price: 1500 },
        { catalog_id: 321, name: 'SKU-2', quantity: 1, price: 0 },
      ],
      'catalog_id и остальные поля должны корректно формироваться для каждой позиции'
    );

    assert.ok(Array.isArray(lead._embedded?.catalog_elements), 'Созданная сделка должна содержать товары');
    assert.equal(lead._embedded.catalog_elements.length, items.length, 'Количество товаров в сделке должно совпадать');

    assert.deepEqual(
      lead._embedded.catalog_elements.map(element => ({
        catalog_id: element.catalog_id,
        name: element.name,
        quantity: element.quantity,
        price: element.price,
      })),
      payloadElements,
      'Сделка должна возвращать те же позиции, что и в запросе'
    );
  } finally {
    amoCRMService.client.post = originalClientPost;
  }
});
