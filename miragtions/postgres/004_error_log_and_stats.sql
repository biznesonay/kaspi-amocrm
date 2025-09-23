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