import db, { toDbDate, fromDbDate, nowUtc } from '../config/database.js';
import config from '../config/env.js';
import logger from '../utils/logger.js';

class Repository {
  // === Работа с локами ===
  
  async acquireLock(name, durationMinutes = 5) {
    const now = new Date();
    const lockedUntil = new Date(now.getTime() + durationMinutes * 60000);
    
    try {
      // Пытаемся атомарно захватить лок
      const result = await db('locks')
        .where('name', name)
        .where('locked_until_utc', '<', toDbDate(now))
        .update({
          locked_until_utc: toDbDate(lockedUntil),
          locked_by: `${process.pid}@${new Date().toISOString()}`,
          updated_at_utc: toDbDate(now)
        });
      
      if (result > 0) {
        logger.debug({ lockName: name, lockedUntil }, 'Лок захвачен');
        return true;
      }
      
      // Проверяем, может лок уже истек
      const lock = await db('locks').where('name', name).first();
      if (lock && fromDbDate(lock.locked_until_utc) < now) {
        // Лок истек, обновляем
        await db('locks')
          .where('name', name)
          .update({
            locked_until_utc: toDbDate(lockedUntil),
            locked_by: `${process.pid}@${new Date().toISOString()}`,
            updated_at_utc: toDbDate(now)
          });
        logger.debug({ lockName: name, lockedUntil }, 'Истекший лок перезахвачен');
        return true;
      }
      
      logger.debug({ 
        lockName: name, 
        lockedUntil: lock ? fromDbDate(lock.locked_until_utc) : null 
      }, 'Лок уже занят');
      return false;
      
    } catch (error) {
      logger.error({ error: error.message, lockName: name }, 'Ошибка при захвате лока');
      return false;
    }
  }
  
  async releaseLock(name) {
    try {
      await db('locks')
        .where('name', name)
        .update({
          locked_until_utc: toDbDate(new Date(Date.now() - 60000)), // в прошлом
          updated_at_utc: nowUtc()
        });
      logger.debug({ lockName: name }, 'Лок освобожден');
    } catch (error) {
      logger.error({ error: error.message, lockName: name }, 'Ошибка при освобождении лока');
    }
  }
  
  // === Работа с обработанными заказами ===
  
  async isOrderProcessed(orderCode) {
    const order = await db('processed_orders')
      .where('order_code', orderCode)
      .first();
    return !!order;
  }
  
  async getProcessedOrder(orderCode) {
    const order = await db('processed_orders')
      .where('order_code', orderCode)
      .first();
    
    if (order) {
      order.last_synced_at = fromDbDate(order.last_synced_at_utc);
      order.created_at = fromDbDate(order.created_at_utc);
      order.updated_at = fromDbDate(order.updated_at_utc);
    }
    
    return order;
  }
  
  async saveProcessedOrder(orderData) {
    const data = {
      order_code: orderData.orderCode,
      amocrm_lead_id: orderData.leadId,
      kaspi_state: orderData.kaspiState,
      checksum: orderData.checksum,
      processing_time_ms: orderData.processingTimeMs,
      retry_count: orderData.retryCount || 0,
      last_error: orderData.lastError || null,
      last_synced_at_utc: nowUtc(),
      updated_at_utc: nowUtc()
    };
    
    // Upsert: вставляем или обновляем
    if (config.DB_CLIENT === 'postgres') {
      await db('processed_orders')
        .insert(data)
        .onConflict('order_code')
        .merge();
    } else {
      // SQLite
      const exists = await this.isOrderProcessed(orderData.orderCode);
      if (exists) {
        await db('processed_orders')
          .where('order_code', orderData.orderCode)
          .update(data);
      } else {
        data.created_at_utc = nowUtc();
        await db('processed_orders').insert(data);
      }
    }
    
    logger.debug({ orderCode: orderData.orderCode, leadId: orderData.leadId }, 'Заказ сохранен в БД');
  }
  
  async getOrdersForReconciliation(fromDate) {
    return await db('processed_orders')
      .where('last_synced_at_utc', '>=', toDbDate(fromDate))
      .select('*');
  }
  
  // === Работа с токенами ===
  
  async getTokens() {
    const tokens = await db('tokens').where('id', 1).first();
    if (tokens) {
      tokens.expires_at = fromDbDate(tokens.expires_at_utc);
      tokens.updated_at = fromDbDate(tokens.updated_at_utc);
    }
    return tokens;
  }
  
  async updateTokens(accessToken, refreshToken, expiresIn = 86400) {
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    
    await db('tokens')
      .where('id', 1)
      .update({
        amo_access_token: accessToken,
        amo_refresh_token: refreshToken,
        expires_at_utc: toDbDate(expiresAt),
        updated_at_utc: nowUtc()
      });
    
    logger.info({ expiresAt }, 'Токены amoCRM обновлены в БД');
  }
  
  // === Работа с метаданными ===
  
  async getMeta(key) {
    const meta = await db('meta').where('key', key).first();
    return meta ? meta.value : null;
  }
  
  async setMeta(key, value) {
    const data = {
      key,
      value: String(value),
      updated_at_utc: nowUtc()
    };
    
    if (config.DB_CLIENT === 'postgres') {
      await db('meta')
        .insert(data)
        .onConflict('key')
        .merge();
    } else {
      const exists = await this.getMeta(key);
      if (exists !== null) {
        await db('meta').where('key', key).update(data);
      } else {
        await db('meta').insert(data);
      }
    }
  }
  
  async updateHeartbeat() {
    await this.setMeta('heartbeat_utc', new Date().toISOString());
  }
  
  async incrementFailures() {
    const current = parseInt(await this.getMeta('consecutive_failures') || '0');
    await this.setMeta('consecutive_failures', current + 1);
    return current + 1;
  }
  
  async resetFailures() {
    await this.setMeta('consecutive_failures', '0');
  }
  
  async getReconcileWatermark() {
    const value = await this.getMeta('reconcile_watermark_utc');
    return value ? new Date(value) : new Date(Date.now() - 24 * 60 * 60 * 1000);
  }
  
  async updateReconcileWatermark(date) {
    await this.setMeta('reconcile_watermark_utc', date.toISOString());
  }
  
  // === Работа с ошибками ===
  
  async logError(errorType, errorMessage, errorDetails = null, orderCode = null) {
    await db('error_log').insert({
      error_type: errorType,
      error_message: errorMessage.substring(0, 500),
      error_details: errorDetails ? JSON.stringify(errorDetails) : null,
      order_code: orderCode,
      occurred_at_utc: nowUtc()
    });
    
    // Также обновляем последнюю ошибку в meta
    await this.setMeta('last_error_utc', new Date().toISOString());
    await this.setMeta('last_error_message', errorMessage.substring(0, 200));
  }
  
  async getRecentErrors(limit = 10) {
    return await db('error_log')
      .orderBy('occurred_at_utc', 'desc')
      .limit(limit);
  }
  
  // === Статистика ===
  
  async updateDailyStats(date, stats) {
    const dateStr = date.toISOString().split('T')[0];
    
    const data = {
      date: dateStr,
      orders_processed: stats.ordersProcessed || 0,
      orders_failed: stats.ordersFailed || 0,
      total_amount: stats.totalAmount || 0,
      avg_processing_time_ms: stats.avgProcessingTimeMs || 0,
      updated_at_utc: nowUtc()
    };
    
    if (config.DB_CLIENT === 'postgres') {
      await db('daily_stats')
        .insert(data)
        .onConflict('date')
        .merge({
          orders_processed: db.raw('daily_stats.orders_processed + ?', [data.orders_processed]),
          orders_failed: db.raw('daily_stats.orders_failed + ?', [data.orders_failed]),
          total_amount: db.raw('daily_stats.total_amount + ?', [data.total_amount]),
          avg_processing_time_ms: db.raw(
            '(daily_stats.avg_processing_time_ms * daily_stats.orders_processed + ?) / (daily_stats.orders_processed + ?)',
            [data.avg_processing_time_ms * data.orders_processed, data.orders_processed]
          ),
          updated_at_utc: nowUtc()
        });
    } else {
      // SQLite
      const existing = await db('daily_stats').where('date', dateStr).first();
      if (existing) {
        const newProcessed = existing.orders_processed + data.orders_processed;
        const newFailed = existing.orders_failed + data.orders_failed;
        const newAmount = existing.total_amount + data.total_amount;
        const newAvgTime = newProcessed > 0
          ? Math.round((existing.avg_processing_time_ms * existing.orders_processed + 
              data.avg_processing_time_ms * data.orders_processed) / newProcessed)
          : 0;
        
        await db('daily_stats')
          .where('date', dateStr)
          .update({
            orders_processed: newProcessed,
            orders_failed: newFailed,
            total_amount: newAmount,
            avg_processing_time_ms: newAvgTime,
            updated_at_utc: nowUtc()
          });
      } else {
        await db('daily_stats').insert(data);
      }
    }
  }
  
  async getStats() {
    const total = await this.getMeta('total_orders_processed') || '0';
    const failed = await this.getMeta('total_orders_failed') || '0';
    const lastError = await this.getMeta('last_error_message') || '';
    const lastErrorTime = await this.getMeta('last_error_utc') || '';
    const heartbeat = await this.getMeta('heartbeat_utc') || '';
    
    return {
      totalProcessed: parseInt(total),
      totalFailed: parseInt(failed),
      lastError,
      lastErrorTime: lastErrorTime ? new Date(lastErrorTime) : null,
      lastHeartbeat: heartbeat ? new Date(heartbeat) : null
    };
  }
}

// Создаем синглтон
const repository = new Repository();
export default repository;

// ========== ERROR LOG METHODS ==========

/**
 * Логирование ошибки в БД
 * @param {Object} error - Объект ошибки
 * @returns {Promise<void>}
 */
async logError(error) {
  const errorData = {
    order_code: error.orderCode || null,
    error_type: error.type || 'unknown',
    error_message: error.message || 'Unknown error',
    error_details: error.details ? JSON.stringify(error.details) : null,
    stack_trace: error.stack || null,
    retry_attempt: error.retryAttempt || 0
  };

  if (this.dbClient === 'postgres') {
    errorData.created_at_utc = new Date().toISOString();
    await this.db('error_log').insert(errorData);
  } else {
    // SQLite - created_at_utc устанавливается автоматически через DEFAULT
    await this.db('error_log').insert(errorData);
  }

  this.logger.debug({ errorData }, 'Error logged to database');
}

/**
 * Получение последних ошибок
 * @param {number} limit - Количество записей
 * @returns {Promise<Array>}
 */
async getRecentErrors(limit = 10) {
  return await this.db('error_log')
    .orderBy('created_at_utc', 'desc')
    .limit(limit);
}

/**
 * Получение ошибок по заказу
 * @param {string} orderCode - Код заказа
 * @returns {Promise<Array>}
 */
async getOrderErrors(orderCode) {
  return await this.db('error_log')
    .where('order_code', orderCode)
    .orderBy('created_at_utc', 'desc');
}

/**
 * Очистка старых ошибок
 * @param {number} daysToKeep - Сколько дней хранить
 * @returns {Promise<number>} Количество удаленных записей
 */
async cleanOldErrors(daysToKeep = 30) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
  
  const deleted = await this.db('error_log')
    .where('created_at_utc', '<', cutoffDate.toISOString())
    .delete();
    
  this.logger.info({ deleted, daysToKeep }, 'Old errors cleaned');
  return deleted;
}

// ========== DAILY STATS METHODS ==========

/**
 * Получение или создание статистики за день
 * @param {string} date - Дата в формате YYYY-MM-DD
 * @returns {Promise<Object>}
 */
async getDailyStats(date) {
  const stats = await this.db('daily_stats')
    .where('date', date)
    .first();
    
  if (!stats) {
    // Создаем пустую запись для сегодня
    const newStats = {
      date,
      orders_processed: 0,
      orders_failed: 0,
      contacts_created: 0,
      leads_created: 0,
      total_processing_time_ms: 0,
      avg_processing_time_ms: 0,
      total_amount: 0,
      api_errors_kaspi: 0,
      api_errors_amocrm: 0,
      rate_limit_hits: 0,
      reconcile_updates: 0
    };
    
    if (this.dbClient === 'postgres') {
      newStats.created_at_utc = new Date().toISOString();
      newStats.updated_at_utc = new Date().toISOString();
    }
    
    await this.db('daily_stats').insert(newStats);
    return newStats;
  }
  
  return stats;
}

/**
 * Инкремент счетчика в daily_stats
 * @param {string} date - Дата YYYY-MM-DD
 * @param {string} field - Название поля
 * @param {number} increment - На сколько увеличить
 * @returns {Promise<void>}
 */
async incrementDailyStat(date, field, increment = 1) {
  // Убеждаемся, что запись существует
  await this.getDailyStats(date);
  
  // Инкрементим поле
  await this.db('daily_stats')
    .where('date', date)
    .increment(field, increment);
    
  // Обновляем updated_at_utc для PostgreSQL
  if (this.dbClient === 'postgres') {
    await this.db('daily_stats')
      .where('date', date)
      .update({ updated_at_utc: new Date().toISOString() });
  }
}

/**
 * Обновление статистики после обработки заказа
 * @param {Object} stats - Объект со статистикой
 */
async updateOrderStats(stats) {
  const date = new Date().toISOString().split('T')[0];
  
  // Получаем текущую статистику
  const currentStats = await this.getDailyStats(date);
  
  // Вычисляем новые значения
  const totalProcessed = currentStats.orders_processed + (stats.success ? 1 : 0);
  const totalFailed = currentStats.orders_failed + (stats.success ? 0 : 1);
  const totalTime = currentStats.total_processing_time_ms + (stats.processingTime || 0);
  
  const updates = {
    orders_processed: totalProcessed,
    orders_failed: totalFailed,
    total_processing_time_ms: totalTime,
    avg_processing_time_ms: totalProcessed > 0 ? Math.round(totalTime / totalProcessed) : 0
  };
  
  // Добавляем другие счетчики если есть
  if (stats.contactCreated) updates.contacts_created = currentStats.contacts_created + 1;
  if (stats.leadCreated) updates.leads_created = currentStats.leads_created + 1;
  if (stats.amount) updates.total_amount = currentStats.total_amount + stats.amount;
  if (stats.kaspiError) updates.api_errors_kaspi = currentStats.api_errors_kaspi + 1;
  if (stats.amocrmError) updates.api_errors_amocrm = currentStats.api_errors_amocrm + 1;
  if (stats.rateLimitHit) updates.rate_limit_hits = currentStats.rate_limit_hits + 1;
  if (stats.reconcileUpdate) updates.reconcile_updates = currentStats.reconcile_updates + 1;
  
  // Обновляем БД
  if (this.dbClient === 'postgres') {
    updates.updated_at_utc = new Date().toISOString();
  }
  
  await this.db('daily_stats')
    .where('date', date)
    .update(updates);
    
  this.logger.debug({ date, updates }, 'Daily stats updated');
}

/**
 * Получение статистики за период
 * @param {string} startDate - Начальная дата YYYY-MM-DD
 * @param {string} endDate - Конечная дата YYYY-MM-DD
 * @returns {Promise<Array>}
 */
async getStatsRange(startDate, endDate) {
  return await this.db('daily_stats')
    .whereBetween('date', [startDate, endDate])
    .orderBy('date', 'desc');
}

/**
 * Получение суммарной статистики
 * @returns {Promise<Object>}
 */
async getSummaryStats() {
  const result = await this.db('daily_stats')
    .sum('orders_processed as total_orders_processed')
    .sum('orders_failed as total_orders_failed')
    .sum('contacts_created as total_contacts_created')
    .sum('leads_created as total_leads_created')
    .sum('total_amount as total_amount')
    .sum('api_errors_kaspi as total_api_errors_kaspi')
    .sum('api_errors_amocrm as total_api_errors_amocrm')
    .sum('rate_limit_hits as total_rate_limit_hits')
    .avg('avg_processing_time_ms as avg_processing_time_ms')
    .first();
    
  return result;
}