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

const repositoryModule = await import('../src/db/repository.js');
const repository = repositoryModule.default;
const dbModule = await import('../src/config/database.js');
const db = dbModule.default;

if (!(await db.schema.hasTable('meta'))) {
  await db.schema.createTable('meta', (table) => {
    table.string('key').primary();
    table.text('value').notNullable();
    table.text('updated_at_utc');
  });
}

test('logError works with occurred_at_utc column', async () => {
  await db.schema.dropTableIfExists('error_log');
  await db.schema.createTable('error_log', (table) => {
    table.increments('id').primary();
    table.string('order_code');
    table.string('error_type').notNullable();
    table.string('error_message').notNullable();
    table.text('error_details');
    table.text('occurred_at_utc').notNullable();
  });

  repository._errorLogTimestampColumn = null;

  try {
    await repository.logError('kaspi_api', 'Test occurred message', { foo: 'bar' }, 'ORDER-1');
    const row = await db('error_log').first();

    assert.equal(row.error_type, 'kaspi_api');
    assert.equal(row.error_message, 'Test occurred message');
    assert.equal(row.order_code, 'ORDER-1');
    assert.equal(row.error_details, '{"foo":"bar"}');
    assert.ok(row.occurred_at_utc, 'occurred_at_utc should be set');
    assert.equal('created_at_utc' in row, false);
  } finally {
    await db.schema.dropTableIfExists('error_log');
  }
});

test('logError works with created_at_utc column', async () => {
  await db.schema.dropTableIfExists('error_log');
  await db.schema.createTable('error_log', (table) => {
    table.increments('id').primary();
    table.string('order_code');
    table.string('error_type').notNullable();
    table.string('error_message').notNullable();
    table.text('error_details');
    table.text('created_at_utc').notNullable();
  });

  repository._errorLogTimestampColumn = null;

  try {
    await repository.logError('amocrm_api', 'Test created message', null, null);
    const row = await db('error_log').first();

    assert.equal(row.error_type, 'amocrm_api');
    assert.equal(row.error_message, 'Test created message');
    assert.equal(row.order_code, null);
    assert.equal(row.error_details, null);
    assert.ok(row.created_at_utc, 'created_at_utc should be set');
    assert.equal('occurred_at_utc' in row, false);
  } finally {
    await db.schema.dropTableIfExists('error_log');
  }
});

test.after(async () => {
  await db.destroy();
});
