import knex from 'knex';
import config from './env.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Конфигурация для разных типов БД
const dbConfigs = {
  sqlite: {
    client: 'sqlite3',
    connection: {
      filename: config.DB_URL.replace('file:', '') || join(__dirname, '../../integrator.db')
    },
    useNullAsDefault: true,
    pool: {
      min: 1,
      max: 1,
      afterCreate: (conn, cb) => {
        // Включаем foreign keys для SQLite
        conn.run('PRAGMA foreign_keys = ON', cb);
      }
    }
  },
  
  postgres: {
    client: 'pg',
    connection: config.DB_URL,
    pool: {
      min: 2,
      max: 10
    },
    searchPath: ['public']
  }
};

// Выбираем конфигурацию в зависимости от DB_CLIENT
const knexConfig = dbConfigs[config.DB_CLIENT];

if (!knexConfig) {
  console.error(`❌ Неподдерживаемый тип БД: ${config.DB_CLIENT}`);
  console.error('   Используйте "sqlite" или "postgres"');
  process.exit(1);
}

// Создаем инстанс Knex
const db = knex(knexConfig);

// Проверяем подключение к БД
export async function checkDatabaseConnection() {
  try {
    if (config.DB_CLIENT === 'sqlite') {
      await db.raw('SELECT 1');
    } else {
      await db.raw('SELECT NOW()');
    }
    return true;
  } catch (error) {
    console.error('❌ Не удалось подключиться к базе данных:', error.message);
    return false;
  }
}

// Хелпер для работы с датами (SQLite использует текст, PostgreSQL - timestamp)
export function toDbDate(date) {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  
  if (config.DB_CLIENT === 'sqlite') {
    // SQLite: ISO8601 строка
    return d.toISOString();
  } else {
    // PostgreSQL: Date объект
    return d;
  }
}

export function fromDbDate(value) {
  if (!value) return null;
  
  if (config.DB_CLIENT === 'sqlite') {
    // SQLite возвращает строку
    return new Date(value);
  } else {
    // PostgreSQL возвращает Date
    return value instanceof Date ? value : new Date(value);
  }
}

// Хелпер для текущего времени UTC
export function nowUtc() {
  return toDbDate(new Date());
}

// Экспортируем Knex инстанс
export default db;