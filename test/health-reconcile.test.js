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
process.env.DB_URL = 'file:memdb2?mode=memory&cache=shared';
process.env.DB_CLIENT = 'sqlite';
process.env.DRY_RUN = 'true';
process.env.LOG_LEVEL = 'fatal';

const repositoryModule = await import('../src/db/repository.js');
const repository = repositoryModule.default;
const dbModule = await import('../src/config/database.js');
const db = dbModule.default;
const { getHealthStatus } = await import('../src/health-check.js');

if (!(await db.schema.hasTable('meta'))) {
  await db.schema.createTable('meta', (table) => {
    table.string('key').primary();
    table.text('value').notNullable();
    table.text('updated_at_utc');
  });
}

await db.schema.dropTableIfExists('daily_stats');
await db.schema.createTable('daily_stats', (table) => {
  table.string('date').primary();
  table.integer('orders_processed').notNullable().defaultTo(0);
  table.integer('orders_failed').notNullable().defaultTo(0);
  table.integer('contacts_created').notNullable().defaultTo(0);
  table.integer('leads_created').notNullable().defaultTo(0);
  table.integer('total_processing_time_ms').notNullable().defaultTo(0);
  table.integer('avg_processing_time_ms').notNullable().defaultTo(0);
  table.decimal('total_amount').notNullable().defaultTo(0);
  table.integer('api_errors_kaspi').notNullable().defaultTo(0);
  table.integer('api_errors_amocrm').notNullable().defaultTo(0);
  table.integer('rate_limit_hits').notNullable().defaultTo(0);
  table.integer('reconcile_updates').notNullable().defaultTo(0);
  table.text('created_at_utc');
  table.text('updated_at_utc');
});

repository._dailyStatsColumns = null;

test('health check includes reconcile stats after order updates', async () => {
  await repository.updateOrderStats({
    success: true,
    amount: 1500,
    reconcileUpdate: true
  });

  await repository.updateOrderStats({
    success: false,
    amount: 0,
    reconcileUpdate: false
  });

  const status = await getHealthStatus();

  assert.ok(status.checks.todayStats, 'todayStats should be present');
  assert.equal(status.checks.todayStats.orders_processed, 1);
  assert.equal(status.checks.todayStats.orders_failed, 1);
  assert.equal(status.checks.todayStats.reconcile_updates, 1);
});

test.after(async () => {
  await db.destroy();
});
