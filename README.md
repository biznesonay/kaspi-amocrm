# Kaspi → amoCRM Integrator

Автоматическая интеграция для переноса заказов из Kaspi в amoCRM через cron-скрипты.

## 🚀 Возможности

- ✅ Автоматический перенос заказов из Kaspi в amoCRM
- 📱 Создание/поиск контактов по телефону (без email)
- 🛍️ Добавление товарных позиций и заметок к сделкам
- 🔄 Инкрементальная сверка каждые 10 минут
- 🚫 Защита от дублей по order.code
- 📊 Статистика и мониторинг
- 🔔 Алерты через Telegram и Email
- 💾 Поддержка SQLite и PostgreSQL

## 📋 Требования

- Node.js 20 LTS или выше
- SQLite 3 или PostgreSQL 14+
- Доступ к Kaspi API
- Доступ к amoCRM (OAuth2 токены)
- Хостинг с поддержкой cron (например, PS.kz)

## 🛠️ Установка

### 1. Клонируйте репозиторий

```bash
git clone <repository-url>
cd kaspi-amocrm-integrator
```

### 2. Установите зависимости

```bash
npm ci
```

### 3. Настройте переменные окружения

```bash
cp .env.example .env
```

Отредактируйте `.env` и заполните все необходимые параметры:

#### Kaspi API:
- `KASPI_API_TOKEN` - токен доступа к API
- `KASPI_ALLOWED_STATES` - статусы заказов для обработки

#### amoCRM:
- `AMO_BASE_URL` - URL вашего аккаунта (https://your-subdomain.amocrm.ru)
- `AMO_CLIENT_ID` - ID интеграции
- `AMO_CLIENT_SECRET` - секретный ключ интеграции
- `AMO_ACCESS_TOKEN` - access token
- `AMO_REFRESH_TOKEN` - refresh token
- `AMO_PIPELINE_ID` - ID воронки для новых сделок
- `AMO_STATUS_ID` - ID статуса для новых сделок

### 4. Инициализируйте базу данных

#### Для SQLite:

```bash
sqlite3 integrator.db < migrations/sqlite/001_initial.sql
# или
npm run migrate:sqlite
```

#### Для PostgreSQL:

```bash
createdb integrator
psql integrator < migrations/postgres/001_initial.sql
# или
npm run migrate:postgres
```

### 5. Протестируйте в DRY_RUN режиме

```bash
# Установите в .env:
DRY_RUN=true

# Запустите скрипты
npm run dry-run:poll
npm run dry-run:reconcile
```

## 🚦 Запуск

### Локальный запуск

```bash
# Опрос и создание заказов
npm run poll

# Сверка
npm run reconcile
```

### Настройка Cron

Добавьте в crontab:

```bash
# Опрос каждую минуту
* * * * * cd /path/to/project && /usr/bin/node src/poll-and-create.js >> logs/kaspi-amo.log 2>&1

# Сверка каждые 10 минут
*/10 * * * * cd /path/to/project && /usr/bin/node src/reconcile.js >> logs/kaspi-amo.log 2>&1
```

### Настройка на PS.kz

1. Загрузите файлы на хостинг через FTP/SFTP
2. Установите зависимости через SSH: `npm ci`
3. Создайте задачи в панели управления cron:
   - Команда 1: `/usr/bin/node /home/USER/app/src/poll-and-create.js`
   - Расписание 1: `* * * * *`
   - Команда 2: `/usr/bin/node /home/USER/app/src/reconcile.js`
   - Расписание 2: `*/10 * * * *`

## 📊 Мониторинг

### Логи

Логи сохраняются в JSON формате для удобного анализа:

```bash
# Просмотр последних логов
tail -f logs/kaspi-amo.log | npx pino-pretty

# Фильтрация ошибок
grep '"level":50' logs/kaspi-amo.log | jq '.'
```

### База данных

Проверка статистики:

```sql
-- SQLite
sqlite3 integrator.db "SELECT * FROM meta;"
sqlite3 integrator.db "SELECT COUNT(*) FROM processed_orders;"
sqlite3 integrator.db "SELECT * FROM daily_stats ORDER BY date DESC LIMIT 7;"

-- PostgreSQL
psql integrator -c "SELECT * FROM meta;"
psql integrator -c "SELECT COUNT(*) FROM processed_orders;"
```

### Алерты

Настройте каналы уведомлений в `.env`:

#### Telegram:
1. Создайте бота через @BotFather
2. Получите токен бота
3. Добавьте бота в чат/канал
4. Получите chat_id
5. Установите в .env:
   - `ALERT_TELEGRAM_BOT_TOKEN`
   - `ALERT_TELEGRAM_CHAT_ID`

#### Email:
1. Настройте SMTP сервер (Gmail, Yandex, etc.)
2. Установите в .env:
   - `ALERT_EMAIL_TO`
   - `ALERT_EMAIL_FROM`
   - `ALERT_EMAIL_SMTP_HOST`
   - `ALERT_EMAIL_SMTP_PORT`
   - `ALERT_EMAIL_SMTP_USER`
   - `ALERT_EMAIL_SMTP_PASS`

## 🔧 Отладка

### Включение подробных логов

```bash
LOG_LEVEL=debug LOG_PRETTY=true npm run poll
```

### Проверка токенов amoCRM

```javascript
// test-amocrm.js
import amoCRMService from './src/services/amocrm.js';

amoCRMService.healthCheck()
  .then(result => console.log('amoCRM доступен:', result))
  .catch(error => console.error('Ошибка:', error));
```

### Проверка Kaspi API

```javascript
// test-kaspi.js
import kaspiService from './src/services/kaspi.js';

kaspiService.getOrders({ pageSize: 1 })
  .then(result => console.log('Kaspi заказы:', result))
  .catch(error => console.error('Ошибка:', error));
```

## 📁 Структура проекта

```
kaspi-amocrm-integrator/
├── src/
│   ├── config/          # Конфигурация
│   │   ├── env.js       # Переменные окружения
│   │   └── database.js  # Подключение к БД
│   ├── services/        # Сервисы API
│   │   ├── kaspi.js     # Kaspi API
│   │   ├── amocrm.js    # amoCRM API
│   │   └── phone.js     # Работа с телефонами
│   ├── db/             # База данных
│   │   ├── repository.js # Репозиторий
│   │   └── migrate.js   # Миграции
│   ├── utils/          # Утилиты
│   │   ├── logger.js    # Логирование
│   │   ├── alerts.js    # Алерты
│   │   └── retry.js     # Повторные попытки
│   ├── poll-and-create.js  # Основной скрипт опроса
│   └── reconcile.js         # Скрипт сверки
├── migrations/         # SQL миграции
│   ├── sqlite/        # Для SQLite
│   └── postgres/      # Для PostgreSQL
├── .env.example       # Шаблон настроек
├── package.json       # Зависимости
└── README.md         # Документация
```

## ⚙️ Конфигурация

### Основные параметры

| Параметр | Описание | Значение по умолчанию |
|----------|----------|----------------------|
| `KASPI_PAGE_SIZE` | Размер страницы при запросе заказов | 100 |
| `AMO_RPS` | Лимит запросов в секунду к amoCRM | 6 |
| `ALERT_FAIL_STREAK` | Количество ошибок подряд для алерта | 3 |
| `ALERT_BACKLOG_THRESHOLD` | Порог необработанных заказов | 25 |
| `ALERT_HEARTBEAT_MINUTES` | Таймаут heartbeat в минутах | 5 |

### Маппинг полей

| Kaspi | amoCRM |
|-------|--------|
| order.code | Название сделки (Kaspi #XXX) |
| totalPrice | Бюджет сделки |
| buyer.phone | Телефон контакта |
| buyer.firstName/lastName | Имя контакта |
| items | Товарные позиции + заметка |
| state | Тег сделки |

## 🔒 Безопасность

- Все токены хранятся в `.env` файле
- Телефоны маскируются в логах
- OAuth токены автоматически обновляются
- БД локи предотвращают параллельные запуски
- Все временные метки в UTC

## 🐛 Известные проблемы

1. **Rate limiting amoCRM**: При превышении лимита используется exponential backoff
2. **Большие заказы**: Заказы с 100+ позициями могут обрабатываться медленно
3. **Обновление позиций**: Полное обновление позиций в amoCRM требует удаления старых

## 📝 TODO

- [ ] Web интерфейс для мониторинга
- [ ] Метрики Prometheus
- [ ] Вебхуки для real-time обработки
- [ ] Двусторонняя синхронизация
- [ ] Docker контейнеризация

## 📄 Лицензия

MIT

## 👤 Контакты

По вопросам обращайтесь в техподдержку.