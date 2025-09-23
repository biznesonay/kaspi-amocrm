# 🚀 Чек-лист запуска интеграции Kaspi → amoCRM

## Этап 1: Подготовка окружения

### 1.1. Установка зависимостей
```bash
npm ci
```
✅ Проверка: `node_modules` создана, ошибок нет

### 1.2. Настройка .env
```bash
cp .env.example .env
```
Заполните обязательные поля в `.env`:
- [ ] `KASPI_API_TOKEN` - токен от Kaspi
- [ ] `AMO_BASE_URL` - ваш субдомен amoCRM
- [ ] `AMO_CLIENT_ID` - из интеграции amoCRM
- [ ] `AMO_CLIENT_SECRET` - из интеграции amoCRM

## Этап 2: Получение токенов и ID

### 2.1. Проверка Kaspi API
```bash
npm run test:kaspi
```
✅ Ожидаемый результат:
- Найден рабочий endpoint
- В `.env` установлен правильный `KASPI_BASE_URL`

### 2.2. Получение OAuth токенов amoCRM
```bash
npm run setup:oauth
# Или:
node src/helpers/setup-amocrm-oauth.js
```
Следуйте инструкциям на экране.

✅ После успеха добавьте в `.env`:
- [ ] `AMO_ACCESS_TOKEN`
- [ ] `AMO_REFRESH_TOKEN`

### 2.3. Получение ID полей из amoCRM
```bash
npm run get:amocrm-ids
```
✅ Найдите и добавьте в `.env`:
- [ ] `AMO_PIPELINE_ID` - ID нужной воронки
- [ ] `AMO_STATUS_ID` - ID начального статуса

## Этап 3: Настройка базы данных

### 3.1. Создание и миграция БД

#### Для SQLite (по умолчанию):
```bash
sqlite3 integrator.db < migrations/sqlite/001_initial.sql
sqlite3 integrator.db < migrations/sqlite/002_indexes.sql
sqlite3 integrator.db < migrations/sqlite/003_seed_meta.sql
sqlite3 integrator.db < migrations/sqlite/004_error_log_and_stats.sql
```

#### Для PostgreSQL:
```bash
# Сначала создайте БД
createdb integrator

# Затем примените миграции
psql integrator < migrations/postgres/001_initial.sql
psql integrator < migrations/postgres/002_indexes.sql
psql integrator < migrations/postgres/003_seed_meta.sql
psql integrator < migrations/postgres/004_error_log_and_stats.sql
```

✅ Проверка:
```bash
# SQLite
sqlite3 integrator.db "SELECT name FROM sqlite_master WHERE type='table';"

# PostgreSQL
psql integrator -c "\dt"
```

## Этап 4: Тестовый запуск

### 4.1. Сухой прогон (без записи данных)
```bash
# В .env установите DRY_RUN=true
npm run dry-run:poll
```

✅ Проверьте логи:
- Соединение с Kaspi успешно
- Заказы получены (если есть)
- Нет критических ошибок

### 4.2. Проверка health endpoint
```bash
# В отдельном терминале
npm run health

# В браузере откройте:
# http://localhost:3000/health
# Логин: admin
# Пароль: из ADMIN_BASIC_PASS в .env
```

## Этап 5: Боевой запуск

### 5.1. Первый реальный запуск
```bash
# В .env установите DRY_RUN=false

# Запуск основного скрипта
npm run poll
```

✅ Проверьте:
- [ ] Заказы появились в amoCRM
- [ ] Контакты созданы
- [ ] Суммы и позиции корректны

### 5.2. Проверка инкрементальной сверки
```bash
npm run reconcile
```

✅ Должно выполниться без ошибок

## Этап 6: Настройка Cron

### 6.1. Добавление в crontab
```bash
crontab -e
```

Добавьте строки:
```cron
# Опрос Kaspi каждую минуту
* * * * * cd /path/to/project && /usr/bin/node src/poll-and-create.js >> logs/integrator.log 2>&1

# Сверка каждые 10 минут
*/10 * * * * cd /path/to/project && /usr/bin/node src/reconcile.js >> logs/integrator.log 2>&1

# Health check (опционально, если нужен постоянный мониторинг)
@reboot cd /path/to/project && /usr/bin/node src/health-check.js >> logs/health.log 2>&1
```

✅ Проверка cron:
```bash
# Просмотр текущих задач
crontab -l

# Проверка логов cron
tail -f /var/log/cron
```

## Этап 7: Мониторинг

### 7.1. Настройка алертов (опционально)

#### Telegram:
1. Создайте бота через @BotFather
2. Получите токен и chat_id
3. Добавьте в `.env`:
   - `ALERT_TELEGRAM_BOT_TOKEN`
   - `ALERT_TELEGRAM_CHAT_ID`

#### Email:
1. Настройте SMTP доступ
2. Добавьте в `.env`:
   - `ALERT_EMAIL_TO`
   - `ALERT_EMAIL_SMTP_*`

### 7.2. Проверка логов
```bash
# Просмотр последних логов
tail -f logs/integrator.log

# Красивый вывод (если установлен pino-pretty)
tail -f logs/integrator.log | npx pino-pretty

# Проверка ошибок
grep ERROR logs/integrator.log | tail -20
```

### 7.3. Просмотр статистики
```bash
# Суммарная статистика
npm run stats:summary

# Через health endpoint
curl -u admin:password http://localhost:3000/health
```

## Устранение проблем

### Проблема: "Kaspi API не отвечает"
- Проверьте токен: `npm run test:kaspi`
- Проверьте URL endpoint в `.env`
- Убедитесь, что токен активен в личном кабинете Kaspi

### Проблема: "amoCRM 401 Unauthorized"
- Токены истекли, обновите: `npm run setup:oauth`
- Проверьте права интеграции в amoCRM

### Проблема: "Too many requests (429)"
- Уменьшите `AMO_RPS` в `.env` (например, до 4)
- Проверьте, нет ли других интеграций

### Проблема: "Дубликаты заказов"
- Проверьте таблицу `processed_orders`
- Убедитесь, что DB lock работает
- Проверьте, не запущено ли несколько cron задач

### Проблема: "Заказы не появляются"
- Проверьте `KASPI_ALLOWED_STATES` - возможно, заказы в других статусах
- Проверьте логи на наличие ошибок валидации
- Убедитесь, что `AMO_PIPELINE_ID` и `AMO_STATUS_ID` правильные

## Полезные команды

```bash
# Очистка старых ошибок (старше 30 дней)
npm run clean:errors

# Просмотр последних ошибок в БД
sqlite3 integrator.db "SELECT * FROM error_log ORDER BY created_at_utc DESC LIMIT 10;"

# Проверка последнего heartbeat
sqlite3 integrator.db "SELECT * FROM meta WHERE key='heartbeat_utc';"

# Статистика за сегодня
sqlite3 integrator.db "SELECT * FROM daily_stats WHERE date=date('now');"

# Принудительная разблокировка (если процесс завис)
sqlite3 integrator.db "UPDATE locks SET locked_until_utc=datetime('now') WHERE name='poll';"
```

## Контрольные точки успешного запуска

- [ ] `.env` полностью настроен
- [ ] Kaspi API отвечает (test:kaspi успешен)
- [ ] amoCRM токены работают (get:amocrm-ids успешен)
- [ ] БД создана и мигрирована
- [ ] Тестовый запуск прошел без ошибок
- [ ] Первый заказ успешно перенесен
- [ ] Cron задачи добавлены и работают
- [ ] Health check доступен и показывает "ok"
- [ ] Логи пишутся и не содержат критических ошибок

---

🎉 **Поздравляем!** Если все пункты выполнены, интеграция работает!

При возникновении проблем:
1. Проверьте логи: `tail -100 logs/integrator.log`
2. Проверьте health: `http://localhost:3000/health`
3. Обратитесь к документации: `README.md`