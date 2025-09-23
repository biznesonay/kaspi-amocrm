-- Таблица обработанных заказов
CREATE TABLE IF NOT EXISTS processed_orders (
  order_code TEXT PRIMARY KEY,
  amocrm_lead_id BIGINT,
  kaspi_state TEXT,
  checksum TEXT,
  processing_time_ms INTEGER,
  retry_count INTEGER DEFAULT 0,
  last_error TEXT,
  last_synced_at_utc TIMESTAMPTZ NOT NULL,
  created_at_utc TIMESTAMPTZ DEFAULT NOW(),
  updated_at_utc TIMESTAMPTZ DEFAULT NOW()
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
  id SERIAL PRIMARY KEY,
  amo_access_token TEXT,
  amo_refresh_token TEXT,
  expires_at_utc TIMESTAMPTZ,
  updated_at_utc TIMESTAMPTZ NOT NULL
);

-- Вставляем начальные токены из env (если таблица пустая)
INSERT INTO tokens (id, amo_access_token, amo_refresh_token, updated_at_utc)
VALUES (1, 'from_env', 'from_env', NOW())
ON CONFLICT (id) DO NOTHING;

-- Локи для предотвращения параллельных запусков
CREATE TABLE IF NOT EXISTS locks (
  name TEXT PRIMARY KEY,
  locked_until_utc TIMESTAMPTZ NOT NULL,
  locked_by TEXT,
  updated_at_utc TIMESTAMPTZ DEFAULT NOW()
);

-- Инициализация локов
INSERT INTO locks (name, locked_until_utc)
VALUES 
  ('poll', NOW() - INTERVAL '1 minute'),
  ('reconcile', NOW() - INTERVAL '1 minute')
ON CONFLICT (name) DO NOTHING;

-- Метаданные и счетчики
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at_utc TIMESTAMPTZ DEFAULT NOW()
);

-- Инициализация метаданных
INSERT INTO meta (key, value)
VALUES
  ('heartbeat_utc', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
  ('reconcile_watermark_utc', to_char((NOW() - INTERVAL '1 day') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
  ('consecutive_failures', '0'),
  ('total_orders_processed', '0'),
  ('total_orders_failed', '0'),
  ('last_error_utc', ''),
  ('last_error_message', '')
ON CONFLICT (key) DO NOTHING;

-- История ошибок для анализа
CREATE TABLE IF NOT EXISTS error_log (
  id SERIAL PRIMARY KEY,
  error_type TEXT NOT NULL,
  error_message TEXT NOT NULL,
  error_details TEXT,
  order_code TEXT,
  occurred_at_utc TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_error_log_occurred_at
  ON error_log (occurred_at_utc);

CREATE INDEX IF NOT EXISTS idx_error_log_order_code
  ON error_log (order_code);

-- Статистика по дням
CREATE TABLE IF NOT EXISTS daily_stats (
  date DATE PRIMARY KEY,
  orders_processed INTEGER DEFAULT 0,
  orders_failed INTEGER DEFAULT 0,
  total_amount DECIMAL(12,2) DEFAULT 0,
  avg_processing_time_ms INTEGER DEFAULT 0,
  updated_at_utc TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_daily_stats_date
  ON daily_stats (date);

-- Функция для автоматического обновления updated_at_utc
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at_utc = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Триггеры для автоматического обновления updated_at_utc
DROP TRIGGER IF EXISTS update_processed_orders_updated_at ON processed_orders;
CREATE TRIGGER update_processed_orders_updated_at 
  BEFORE UPDATE ON processed_orders 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_tokens_updated_at ON tokens;
CREATE TRIGGER update_tokens_updated_at 
  BEFORE UPDATE ON tokens 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_locks_updated_at ON locks;
CREATE TRIGGER update_locks_updated_at 
  BEFORE UPDATE ON locks 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_meta_updated_at ON meta;
CREATE TRIGGER update_meta_updated_at 
  BEFORE UPDATE ON meta 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_daily_stats_updated_at ON daily_stats;
CREATE TRIGGER update_daily_stats_updated_at 
  BEFORE UPDATE ON daily_stats 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();