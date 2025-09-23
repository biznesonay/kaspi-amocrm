-- Таблица детального логирования ошибок
CREATE TABLE IF NOT EXISTS error_log (
    id SERIAL PRIMARY KEY,
    order_code TEXT,
    error_type TEXT NOT NULL, -- 'kaspi_api', 'amocrm_api', 'validation', 'processing'
    error_message TEXT NOT NULL,
    error_details JSONB, -- JSON с дополнительной информацией
    stack_trace TEXT,
    retry_attempt INTEGER DEFAULT 0,
    created_at_utc TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);

-- Добавляем недостающие колонки в существующую таблицу error_log
ALTER TABLE IF EXISTS error_log ADD COLUMN IF NOT EXISTS stack_trace TEXT;
ALTER TABLE IF EXISTS error_log ADD COLUMN IF NOT EXISTS retry_attempt INTEGER DEFAULT 0;
ALTER TABLE IF EXISTS error_log ADD COLUMN IF NOT EXISTS created_at_utc TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC');

UPDATE error_log
SET created_at_utc = occurred_at_utc
WHERE created_at_utc IS NULL AND occurred_at_utc IS NOT NULL;

-- Таблица ежедневной статистики
CREATE TABLE IF NOT EXISTS daily_stats (
    date DATE PRIMARY KEY,
    orders_processed INTEGER DEFAULT 0,
    orders_failed INTEGER DEFAULT 0,
    contacts_created INTEGER DEFAULT 0,
    leads_created INTEGER DEFAULT 0,
    total_processing_time_ms BIGINT DEFAULT 0,
    avg_processing_time_ms INTEGER DEFAULT 0,
    total_amount DECIMAL(15,2) DEFAULT 0,
    api_errors_kaspi INTEGER DEFAULT 0,
    api_errors_amocrm INTEGER DEFAULT 0,
    rate_limit_hits INTEGER DEFAULT 0,
    reconcile_updates INTEGER DEFAULT 0,
    created_at_utc TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at_utc TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);

-- Добавляем недостающие колонки в daily_stats
ALTER TABLE IF EXISTS daily_stats ADD COLUMN IF NOT EXISTS contacts_created INTEGER DEFAULT 0;
ALTER TABLE IF EXISTS daily_stats ADD COLUMN IF NOT EXISTS leads_created INTEGER DEFAULT 0;
ALTER TABLE IF EXISTS daily_stats ADD COLUMN IF NOT EXISTS total_processing_time_ms BIGINT DEFAULT 0;
ALTER TABLE IF EXISTS daily_stats ADD COLUMN IF NOT EXISTS api_errors_kaspi INTEGER DEFAULT 0;
ALTER TABLE IF EXISTS daily_stats ADD COLUMN IF NOT EXISTS api_errors_amocrm INTEGER DEFAULT 0;
ALTER TABLE IF EXISTS daily_stats ADD COLUMN IF NOT EXISTS rate_limit_hits INTEGER DEFAULT 0;
ALTER TABLE IF EXISTS daily_stats ADD COLUMN IF NOT EXISTS reconcile_updates INTEGER DEFAULT 0;
ALTER TABLE IF EXISTS daily_stats ADD COLUMN IF NOT EXISTS created_at_utc TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC');

UPDATE daily_stats
SET created_at_utc = COALESCE(created_at_utc, updated_at_utc);

-- Индексы для error_log
CREATE INDEX IF NOT EXISTS idx_error_log_order_code ON error_log (order_code);
CREATE INDEX IF NOT EXISTS idx_error_log_created_at ON error_log (created_at_utc);
CREATE INDEX IF NOT EXISTS idx_error_log_type ON error_log (error_type);

-- Триггер для обновления updated_at_utc в PostgreSQL
CREATE OR REPLACE FUNCTION update_updated_at_utc()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at_utc = NOW() AT TIME ZONE 'UTC';
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_daily_stats_updated_at
    BEFORE UPDATE ON daily_stats
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_utc();