-- Таблица детального логирования ошибок
CREATE TABLE IF NOT EXISTS error_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_code TEXT,
    error_type TEXT NOT NULL, -- 'kaspi_api', 'amocrm_api', 'validation', 'processing'
    error_message TEXT NOT NULL,
    error_details TEXT, -- JSON с дополнительной информацией
    stack_trace TEXT,
    retry_attempt INTEGER DEFAULT 0,
    created_at_utc TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Добавляем недостающие колонки в существующую таблицу error_log
ALTER TABLE error_log ADD COLUMN stack_trace TEXT;
ALTER TABLE error_log ADD COLUMN retry_attempt INTEGER DEFAULT 0;
ALTER TABLE error_log ADD COLUMN created_at_utc TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));

UPDATE error_log
SET created_at_utc = occurred_at_utc
WHERE created_at_utc IS NULL AND occurred_at_utc IS NOT NULL;

-- Таблица ежедневной статистики
CREATE TABLE IF NOT EXISTS daily_stats (
    date TEXT PRIMARY KEY, -- YYYY-MM-DD
    orders_processed INTEGER DEFAULT 0,
    orders_failed INTEGER DEFAULT 0,
    contacts_created INTEGER DEFAULT 0,
    leads_created INTEGER DEFAULT 0,
    total_processing_time_ms INTEGER DEFAULT 0,
    avg_processing_time_ms INTEGER DEFAULT 0,
    total_amount REAL DEFAULT 0,
    api_errors_kaspi INTEGER DEFAULT 0,
    api_errors_amocrm INTEGER DEFAULT 0,
    rate_limit_hits INTEGER DEFAULT 0,
    reconcile_updates INTEGER DEFAULT 0,
    created_at_utc TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at_utc TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Добавляем недостающие колонки в daily_stats
ALTER TABLE daily_stats ADD COLUMN contacts_created INTEGER DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN leads_created INTEGER DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN total_processing_time_ms INTEGER DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN api_errors_kaspi INTEGER DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN api_errors_amocrm INTEGER DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN rate_limit_hits INTEGER DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN reconcile_updates INTEGER DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN created_at_utc TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));

UPDATE daily_stats
SET created_at_utc = COALESCE(created_at_utc, updated_at_utc);

-- Индексы для error_log
CREATE INDEX IF NOT EXISTS idx_error_log_order_code ON error_log (order_code);
CREATE INDEX IF NOT EXISTS idx_error_log_created_at ON error_log (created_at_utc);
CREATE INDEX IF NOT EXISTS idx_error_log_type ON error_log (error_type);