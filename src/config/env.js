import dotenv from 'dotenv';
import { z } from 'zod';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Загружаем .env файл
dotenv.config({ path: join(__dirname, '../../.env') });

// Схема валидации переменных окружения
const envSchema = z.object({
  // Kaspi
  KASPI_API_TOKEN: z.string().min(1),
  KASPI_ALLOWED_STATES: z.string().min(1),
  KASPI_PAGE_SIZE: z.coerce.number().positive().default(100),
  
  // amoCRM
  AMO_BASE_URL: z.string().url(),
  AMO_CLIENT_ID: z.string().min(1),
  AMO_CLIENT_SECRET: z.string().min(1),
  AMO_REDIRECT_URI: z.string().url(),
  AMO_ACCESS_TOKEN: z.string().min(1),
  AMO_REFRESH_TOKEN: z.string().min(1),
  AMO_PIPELINE_ID: z.coerce.number().positive(),
  AMO_STATUS_ID: z.coerce.number().positive(),
  AMO_RPS: z.coerce.number().positive().max(7).default(6),
  
  // База данных
  DB_CLIENT: z.enum(['sqlite', 'postgres']).default('sqlite'),
  DB_URL: z.string().min(1),
  
  // Приложение
  TIMEZONE: z.string().default('Asia/Almaty'),
  DRY_RUN: z.string().transform(val => val === 'true').default('false'),
  
  // Версии и флаги
  KASPI_API_VERSION: z.string().default('v1'),
  AMO_API_VERSION: z.string().default('v4'),
  USE_FREE_POSITIONS: z.string().transform(val => val === 'true').default('true'),
  NOTE_TEMPLATE: z.string().default('Товары Kaspi: {{items}}. Итого: {{total}} тг.'),
  
  // Мониторинг
  ALERT_FAIL_STREAK: z.coerce.number().positive().default(3),
  ALERT_BACKLOG_THRESHOLD: z.coerce.number().positive().default(25),
  ALERT_HEARTBEAT_MINUTES: z.coerce.number().positive().default(5),
  
  // Telegram (опционально)
  ALERT_TELEGRAM_BOT_TOKEN: z.string().optional(),
  ALERT_TELEGRAM_CHAT_ID: z.string().optional(),
  
  // Email (опционально)
  ALERT_EMAIL_TO: z.string().email().optional(),
  ALERT_EMAIL_FROM: z.string().email().optional(),
  ALERT_EMAIL_SMTP_HOST: z.string().optional(),
  ALERT_EMAIL_SMTP_PORT: z.coerce.number().positive().optional(),
  ALERT_EMAIL_SMTP_USER: z.string().optional(),
  ALERT_EMAIL_SMTP_PASS: z.string().optional(),
  
  // Логирование
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: z.string().transform(val => val === 'true').default('false'),
});

// Парсим и валидируем переменные окружения
let config;
try {
  config = envSchema.parse(process.env);
} catch (error) {
  console.error('❌ Ошибка конфигурации:');
  if (error instanceof z.ZodError) {
    error.errors.forEach(err => {
      console.error(`  - ${err.path.join('.')}: ${err.message}`);
    });
  }
  console.error('\n📝 Убедитесь, что файл .env создан и заполнен правильно.');
  console.error('   Используйте .env.example как шаблон.');
  process.exit(1);
}

// Добавляем вычисляемые значения
config.KASPI_ALLOWED_STATES_ARRAY = config.KASPI_ALLOWED_STATES.split(',').map(s => s.trim());

// Проверяем, что есть хотя бы один канал для алертов
config.HAS_ALERT_CHANNEL = !!(
  (config.ALERT_TELEGRAM_BOT_TOKEN && config.ALERT_TELEGRAM_CHAT_ID) ||
  (config.ALERT_EMAIL_TO && config.ALERT_EMAIL_SMTP_HOST)
);

if (!config.HAS_ALERT_CHANNEL && !config.DRY_RUN) {
  console.warn('⚠️  Предупреждение: Не настроен ни один канал для алертов (Telegram или Email)');
  console.warn('   Критические ошибки будут только в логах.');
}

// Экспортируем конфигурацию
export default config; s