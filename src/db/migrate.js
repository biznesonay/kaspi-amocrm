import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import db from '../config/database.js';
import config from '../config/env.js';
import logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function runMigrations() {
  const dbType = config.DB_CLIENT;
  logger.info({ dbType, dbUrl: config.DB_URL }, `Запуск миграций для ${dbType}`);
  
  try {
    // Путь к папке с миграциями
    const migrationsPath = join(__dirname, '../../migrations', dbType);
    
    // Читаем SQL файл
    const sqlPath = join(migrationsPath, '001_initial.sql');
    const sql = readFileSync(sqlPath, 'utf-8');
    
    // Разбиваем на отдельные команды для SQLite
    // (SQLite не поддерживает множественные statements в одном вызове через Knex)
    if (dbType === 'sqlite') {
      const sanitizedSql = sql
        .split('\n')
        .map(line => {
          const trimmedLine = line.trimStart();
          return trimmedLine.startsWith('--') ? '' : line;
        })
        .join('\n');

      const statements = sanitizedSql
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0);
      
      for (const statement of statements) {
        try {
          await db.raw(statement);
          logger.debug({ statement: statement.substring(0, 50) + '...' }, 'Выполнен SQL statement');
        } catch (error) {
          // Игнорируем ошибки "already exists" для идемпотентности
          if (!error.message.includes('already exists')) {
            throw error;
          }
        }
      }
    } else {
      // PostgreSQL поддерживает множественные statements
      await db.raw(sql);
    }
    
    // Вставляем токены из env если они есть и еще не сохранены
    if (config.AMO_ACCESS_TOKEN && config.AMO_REFRESH_TOKEN) {
      const tokens = await db('tokens').where('id', 1).first();
      
      if (tokens && tokens.amo_access_token === 'from_env') {
        await db('tokens')
          .where('id', 1)
          .update({
            amo_access_token: config.AMO_ACCESS_TOKEN,
            amo_refresh_token: config.AMO_REFRESH_TOKEN,
            updated_at_utc: new Date()
          });
        logger.info('Токены amoCRM сохранены в БД');
      }
    }
    
    logger.info('✅ Миграции успешно применены');
    
    // Показываем статистику БД
    const ordersCount = await db('processed_orders').count('* as count');
    const metaData = await db('meta').select('key', 'value');
    
    logger.info({ 
      ordersCount: ordersCount[0].count,
      meta: Object.fromEntries(metaData.map(m => [m.key, m.value]))
    }, 'Состояние БД');
    
  } catch (error) {
    logger.error({ error: error.message }, '❌ Ошибка при выполнении миграций');
    throw error;
  }
}

// Запускаем если вызван напрямую
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then(() => {
      logger.info('Миграции завершены');
      process.exit(0);
    })
    .catch((error) => {
      logger.error({ error: error.message }, 'Фатальная ошибка миграций');
      process.exit(1);
    });
}

export default runMigrations;