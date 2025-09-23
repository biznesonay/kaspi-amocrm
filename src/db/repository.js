import db, { toDbDate, fromDbDate, nowUtc } from '../config/database.js';
import config from '../config/env.js';
import logger from '../utils/logger.js';

class Repository {
  constructor() {
    this._errorLogTimestampColumn = null;
    this._dailyStatsColumns = null;
  }

  async _getErrorLogTimestampColumn() {
    if (!this._errorLogTimestampColumn) {
      const columns = await db('error_log').columnInfo();
      this._errorLogTimestampColumn = columns.created_at_utc ? 'created_at_utc' : 'occurred_at_utc';
    }

    return this._errorLogTimestampColumn;
  }

  async getErrorLogTimestampColumn() {
    return this._getErrorLogTimestampColumn();
  }

  async _getDailyStatsColumns() {
    if (!this._dailyStatsColumns) {
      this._dailyStatsColumns = await db('daily_stats').columnInfo();
    }

    return this._dailyStatsColumns;
  }

  async _hasDailyStatsColumn(column) {
    const columns = await this._getDailyStatsColumns();
    return Object.prototype.hasOwnProperty.call(columns, column);
  }

  _normalizeDateInput(date) {
    if (!date) {
      return new Date().toISOString().split('T')[0];
    }

    if (typeof date === 'string') {
      return date;
    }

    const parsedDate = date instanceof Date ? date : new Date(date);
    return parsedDate.toISOString().split('T')[0];
  }

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
      order.retry_count = Number(order.retry_count ?? 0);
      order.last_synced_at = fromDbDate(order.last_synced_at_utc);
      order.created_at = fromDbDate(order.created_at_utc);
      order.updated_at = fromDbDate(order.updated_at_utc);
      order.processed_successfully = Boolean(order.amocrm_lead_id) && !order.last_error;
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
      retry_count: orderData.retryCount ?? 0,
      last_error: orderData.lastError ?? null,
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
  
async logError(errorTypeOrObject, errorMessage, errorDetails = null, orderCode = null) {
    if (errorTypeOrObject && typeof errorTypeOrObject === 'object' && !Array.isArray(errorTypeOrObject)) {
      const error = errorTypeOrObject;
      const details = {};

      if (error.details) {
        if (typeof error.details === 'object' && !Array.isArray(error.details)) {
          Object.assign(details, error.details);
        } else {
          details.details = error.details;
        }
      }

      if (errorDetails) {
        if (typeof errorDetails === 'object' && !Array.isArray(errorDetails)) {
          Object.assign(details, errorDetails);
        } else {
          details.additionalDetails = errorDetails;
        }
      }

      if (error.stack) {
        details.stack = error.stack;
      }

      if (typeof error.retryAttempt !== 'undefined') {
        details.retryAttempt = error.retryAttempt;
      }

      const mergedDetails = Object.keys(details).length > 0 ? details : null;

      return this.logError(
        error.type || 'unknown',
        error.message || 'Unknown error',
        mergedDetails,
        error.orderCode ?? orderCode ?? null
      );
    }

    const fullMessage = errorMessage || 'Unknown error';
    const message = fullMessage.substring(0, 500);
    const detailsValue = errorDetails == null
      ? null
      : typeof errorDetails === 'string'
        ? errorDetails
        : JSON.stringify(errorDetails);
        
      await db('error_log').insert({
      error_type: errorTypeOrObject || 'unknown',
      error_message: message,
      error_details: detailsValue,
      order_code: orderCode ?? null,
      occurred_at_utc: nowUtc()
    });
    
    // Также обновляем последнюю ошибку в meta
    await this.setMeta('last_error_utc', new Date().toISOString());
    await this.setMeta('last_error_message', fullMessage.substring(0, 200));
  }
  
  async getRecentErrors(limit = 10) {
    const timestampColumn = await this._getErrorLogTimestampColumn();
    return db('error_log')
      .orderBy(timestampColumn, 'desc')
      .limit(limit);
  }
  
  async getOrderErrors(orderCode) {
    const timestampColumn = await this._getErrorLogTimestampColumn();
    return db('error_log')
      .where('order_code', orderCode)
      .orderBy(timestampColumn, 'desc');
  }

  async cleanOldErrors(daysToKeep = 30) {
    const timestampColumn = await this._getErrorLogTimestampColumn();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    const deleted = await db('error_log')
      .where(timestampColumn, '<', toDbDate(cutoffDate))
      .delete();

    logger.info({ deleted, daysToKeep }, 'Старые ошибки очищены в error_log');
    return deleted;
  }

  // === Статистика ===

   async getDailyStats(date) {
    const dateStr = this._normalizeDateInput(date);
    const columns = await this._getDailyStatsColumns();

    let stats = await db('daily_stats').where('date', dateStr).first();

    if (!stats) {
      const baseStats = { date: dateStr };
      const zeroColumns = [
        'orders_processed',
        'orders_failed',
        'contacts_created',
        'leads_created',
        'total_processing_time_ms',
        'avg_processing_time_ms',
        'total_amount',
        'api_errors_kaspi',
        'api_errors_amocrm',
        'rate_limit_hits',
        'reconcile_updates'
      ];

      for (const column of zeroColumns) {
        if (columns[column]) {
          baseStats[column] = 0;
        }
      }

      if (columns.created_at_utc) {
        baseStats.created_at_utc = nowUtc();
      }

      if (columns.updated_at_utc) {
        baseStats.updated_at_utc = nowUtc();
      }

      await db('daily_stats').insert(baseStats);
      stats = await db('daily_stats').where('date', dateStr).first();
    }

    if (!stats) {
      return null;
    }

    const numericFields = [
      'orders_processed',
      'orders_failed',
      'contacts_created',
      'leads_created',
      'total_processing_time_ms',
      'avg_processing_time_ms',
      'total_amount',
      'api_errors_kaspi',
      'api_errors_amocrm',
      'rate_limit_hits',
      'reconcile_updates'
    ];

    for (const field of numericFields) {
      if (stats[field] == null) {
        stats[field] = 0;
      } else {
        const numericValue = Number(stats[field]);
        stats[field] = Number.isNaN(numericValue) ? 0 : numericValue;
      }
    }

    return stats;
  }

  async incrementDailyStat(date, field, increment = 1) {
    const dateStr = this._normalizeDateInput(date);
    const columns = await this._getDailyStatsColumns();

    if (!columns[field]) {
      logger.warn({ field }, 'Попытка обновить несуществующую колонку daily_stats');
      return;
    }

    await this.getDailyStats(dateStr);

    await db('daily_stats')
      .where('date', dateStr)
      .increment(field, increment);

    if (columns.updated_at_utc) {
      await db('daily_stats')
        .where('date', dateStr)
        .update({ updated_at_utc: nowUtc() });
    }
  }
  
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
            `CASE
              WHEN COALESCE(daily_stats.orders_processed, 0) + ? > 0
                THEN (COALESCE(daily_stats.avg_processing_time_ms, 0) * COALESCE(daily_stats.orders_processed, 0) + ?) /
                     (COALESCE(daily_stats.orders_processed, 0) + ?)
              ELSE 0
            END`,
            [
              data.orders_processed,
              data.avg_processing_time_ms * data.orders_processed,
              data.orders_processed
            ]
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

  async updateOrderStats(stats) {
    const now = new Date();
    const processedIncrement = stats?.success === true ? 1 : 0;
    const failedIncrement = stats?.success === false ? 1 : 0;
    const amountIncrement = Number(stats?.amount || 0);
    const processingTime = Number(stats?.processingTime || 0);

    await this.updateDailyStats(now, {
      ordersProcessed: processedIncrement,
      ordersFailed: failedIncrement,
      totalAmount: amountIncrement,
      avgProcessingTimeMs: processingTime
    });

    const columns = await this._getDailyStatsColumns();
    const dateStr = now.toISOString().split('T')[0];

    if (columns.total_processing_time_ms && processingTime) {
      await db('daily_stats')
        .where('date', dateStr)
        .increment('total_processing_time_ms', processingTime);
    }

    const optionalCounters = [
      ['contactCreated', 'contacts_created'],
      ['leadCreated', 'leads_created'],
      ['kaspiError', 'api_errors_kaspi'],
      ['amocrmError', 'api_errors_amocrm'],
      ['rateLimitHit', 'rate_limit_hits'],
      ['reconcileUpdate', 'reconcile_updates']
    ];

    for (const [flag, column] of optionalCounters) {
      if (stats?.[flag] && columns[column]) {
        await this.incrementDailyStat(dateStr, column, 1);
      }
    }
  }

  async getStatsRange(startDate, endDate) {
    const start = this._normalizeDateInput(startDate);
    const end = this._normalizeDateInput(endDate);

    return db('daily_stats')
      .whereBetween('date', [start, end])
      .orderBy('date', 'desc');
  }

  async getSummaryStats() {
    const columns = await this._getDailyStatsColumns();
    const query = db('daily_stats');
    const sumMappings = {
      orders_processed: 'total_orders_processed',
      orders_failed: 'total_orders_failed',
      contacts_created: 'total_contacts_created',
      leads_created: 'total_leads_created',
      total_amount: 'total_amount',
      api_errors_kaspi: 'total_api_errors_kaspi',
      api_errors_amocrm: 'total_api_errors_amocrm',
      rate_limit_hits: 'total_rate_limit_hits',
      reconcile_updates: 'total_reconcile_updates'
    };

    for (const [column, alias] of Object.entries(sumMappings)) {
      if (columns[column]) {
        query.sum({ [alias]: column });
      }
    }

    if (columns.total_processing_time_ms) {
      query.sum({ total_processing_time_ms: 'total_processing_time_ms' });
    }

    if (columns.avg_processing_time_ms) {
      query.avg({ avg_processing_time_ms: 'avg_processing_time_ms' });
    }

    const result = (await query.first()) || {};
    const summary = {};

    for (const [column, alias] of Object.entries(sumMappings)) {
      const value = columns[column] ? Number(result[alias] ?? 0) : 0;
      summary[alias] = Number.isNaN(value) ? 0 : value;
    }

    if (columns.total_processing_time_ms) {
      const totalProcessing = Number(result.total_processing_time_ms ?? 0);
      summary.total_processing_time_ms = Number.isNaN(totalProcessing) ? 0 : totalProcessing;
    }

    const avgValue = columns.avg_processing_time_ms ? Number(result.avg_processing_time_ms ?? 0) : 0;
    summary.avg_processing_time_ms = Number.isNaN(avgValue) ? 0 : avgValue;

    return summary;
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
export { repository };