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

-- Индексы для error_log
CREATE INDEX IF NOT EXISTS idx_error_log_order_code ON error_log (order_code);
CREATE INDEX IF NOT EXISTS idx_error_log_created_at ON error_log (created_at_utc);
CREATE INDEX IF NOT EXISTS idx_error_log_type ON error_log (error_type);