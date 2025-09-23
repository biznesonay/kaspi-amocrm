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
process.env.DB_URL = 'file:memdb_migrations?mode=memory&cache=shared';
process.env.DB_CLIENT = 'sqlite';
process.env.DRY_RUN = 'true';
process.env.LOG_LEVEL = 'fatal';

const { default: runMigrations } = await import('../src/db/migrate.js');
const { default: db } = await import('../src/config/database.js');

test('runMigrations applies sequential SQL migrations', async () => {
  await runMigrations();

  const columns = await db('daily_stats').columnInfo();

  assert.ok('reconcile_updates' in columns, 'reconcile_updates column should exist after migrations');
  assert.ok('created_at_utc' in columns, 'created_at_utc column should exist after migrations');
});

test.after(async () => {
  await db.destroy();
});
