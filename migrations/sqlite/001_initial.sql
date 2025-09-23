-- Включаем поддержку внешних ключей
PRAGMA foreign_keys = ON;

-- Таблица обработанных заказов
CREATE TABLE IF NOT EXISTS processed_orders (
  order_code TEXT PRIMARY KEY,
  amocrm_lead_id INTEGER,
  kaspi_state TEXT,
  checksum TEXT,
  processing_time_ms INTEGER,
  retry_count INTEGER DEFAULT 0,
  last_error TEXT,
  last_synced_at_utc TEXT NOT NULL,
  created_at_utc TEXT DEFAULT (datetime('now')),
  updated_at_utc TEXT DEFAULT (datetime('now'))
);

-- Индексы для processed_orders
CREATE INDEX IF NOT EXISTS idx_processed_orders_synced_at
  ON processed_orders (last_synced_at_utc);

CREATE INDEX IF NOT EXISTS idx_processed_orders_state
  ON processed_orders (kaspi_state);

CREATE INDEX IF NOT EXISTS idx_processed_orders_lead_id
  ON processed_orders (amocrm_lead_id);

-- OAuth токены amoCRM
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY,
  amo_access_token TEXT,
  amo_refresh_token TEXT,
  expires_at_utc TEXT,
  updated_at_utc TEXT NOT NULL
);

-- Вставляем начальные токены из env (если таблица пустая)
INSERT OR IGNORE INTO tokens (id, amo_access_token, amo_refresh_token, updated_at_utc)
VALUES (1, 'from_env', 'from_env', datetime('now'));

-- Локи для предотвращения параллельных запусков
CREATE TABLE IF NOT EXISTS locks (
  name TEXT PRIMARY KEY,
  locked_until_utc TEXT NOT NULL,
  locked_by TEXT,
  updated_at_utc TEXT DEFAULT (datetime('now'))
);

-- Инициализация локов
INSERT OR IGNORE INTO locks (name, locked_until_utc)
VALUES 
  ('poll', datetime('now', '-1 minute')),
  ('reconcile', datetime('now', '-1 minute'));

-- Метаданные и счетчики
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at_utc TEXT DEFAULT (datetime('now'))
);

-- Инициализация метаданных
INSERT OR IGNORE INTO meta (key, value)
VALUES
  ('heartbeat_utc', datetime('now')),
  ('reconcile_watermark_utc', datetime('now', '-1 day')),
  ('consecutive_failures', '0'),
  ('total_orders_processed', '0'),
  ('total_orders_failed', '0'),
  ('last_error_utc', ''),
  ('last_error_message', '');

-- История ошибок для анализа
CREATE TABLE IF NOT EXISTS error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  error_type TEXT NOT NULL,
  error_message TEXT NOT NULL,
  error_details TEXT,
  order_code TEXT,
  occurred_at_utc TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_error_log_occurred_at
  ON error_log (occurred_at_utc);

CREATE INDEX IF NOT EXISTS idx_error_log_order_code
  ON error_log (order_code);

-- Статистика по дням
CREATE TABLE IF NOT EXISTS daily_stats (
  date TEXT PRIMARY KEY,
  orders_processed INTEGER DEFAULT 0,
  orders_failed INTEGER DEFAULT 0,
  total_amount REAL DEFAULT 0,
  avg_processing_time_ms INTEGER DEFAULT 0,
  updated_at_utc TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_daily_stats_date
  ON daily_stats (date);