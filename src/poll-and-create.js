#!/usr/bin/env node

import config from './config/env.js';
import logger from './utils/logger.js';
import repository from './db/repository.js';
import alertService from './utils/alerts.js';
import kaspiService from './services/kaspi.js';
import amoCRMService from './services/amocrm.js';
import phoneService from './services/phone.js';
import { checkDatabaseConnection } from './config/database.js';

// Статистика текущего цикла
const stats = {
  ordersProcessed: 0,
  ordersFailed: 0,
  ordersSkipped: 0,
  totalAmount: 0,
  processingTimes: [],
  errors: [],
  startTime: Date.now()
};

/**
 * Обрабатывает один заказ из Kaspi
 */
async function processOrder(order) {
  const startTime = Date.now();
  const orderCode = order.code;
  let existingOrder = null;
  let previousRetryCount = 0;
  
  try {
    // Проверяем, не обработан ли уже заказ
    existingOrder = await repository.getProcessedOrder(orderCode);
      const isAlreadySuccessful = existingOrder?.processed_successfully ?? (Boolean(existingOrder?.amocrm_lead_id) && !existingOrder?.last_error);
    if (isAlreadySuccessful) {
      logger.debug({ orderCode, leadId: existingOrder.amocrm_lead_id }, 'Заказ уже успешно обработан, пропускаем');
      stats.ordersSkipped++;
      return;
    }

    if (existingOrder) {
      previousRetryCount = Number(existingOrder.retry_count || 0);
      if (existingOrder.last_error) {
        logger.info({
          orderCode,
          retryCount: previousRetryCount,
          lastError: existingOrder.last_error
        }, 'Повторная обработка заказа после ошибки');
      } else {
        logger.debug({ orderCode, retryCount: previousRetryCount }, 'Повторная обработка заказа');
      }
    }

    // Извлекаем данные покупателя
    const phone = phoneService.extractPhoneFromBuyer(order.buyer);
    if (!phone) {
      throw new Error('Не найден телефон покупателя');
    }
    
    const contactName = phoneService.generateContactName(order.buyer);
    
    // В DRY_RUN режиме только логируем
    if (config.DRY_RUN) {
      logger.info({
        orderCode,
        contactName,
        phone: phoneService.maskPhone(phone),
        totalPrice: order.totalPrice,
        itemsCount: order.items?.length || 0
      }, '[DRY_RUN] Будет создан заказ');
      
      stats.ordersProcessed++;
      stats.totalAmount += order.totalPrice;
      return;
    }
    
    // Ищем или создаем контакт
    let contact = await amoCRMService.findContactByPhone(phone);
    if (!contact) {
      logger.info({ phone: phoneService.maskPhone(phone), name: contactName }, 'Контакт не найден, создаем новый');
      contact = await amoCRMService.createContact({ name: contactName, phone });
    } else {
      logger.debug({ contactId: contact.id, phone: phoneService.maskPhone(phone) }, 'Найден существующий контакт');
    }
    
    // Подготавливаем данные для сделки
    const leadName = `Kaspi #${orderCode} — ${contactName}`;
    
    // Форматируем товары для заметки
    const itemsText = kaspiService.formatItemsForNote(order.items);
    const noteText = config.NOTE_TEMPLATE
      .replace('{{items}}', itemsText)
      .replace('{{total}}', order.totalPrice);
    
    // Подготавливаем кастомные поля (адрес доставки и т.д.)
    const customFields = {};
    const deliveryAddress = kaspiService.extractDeliveryAddress(order);
    if (deliveryAddress) {
      // TODO: Добавить field_code для адреса в конфигурацию
      // customFields.DELIVERY_ADDRESS = deliveryAddress;
    }
    
    // Создаем сделку с позициями и заметкой
    const lead = await amoCRMService.createLeadComplex({
      name: leadName,
      price: order.totalPrice,
      contactId: contact.id,
      items: order.items || [],
      noteText,
      customFields,
      tags: ['kaspi', order.state.toLowerCase()]
    });
    
    // Вычисляем контрольную сумму для последующей сверки
    const checksum = kaspiService.calculateChecksum(order);
    
    // Сохраняем в БД
    const processingTime = Date.now() - startTime;
    await repository.saveProcessedOrder({
      orderCode,
      leadId: lead.id,
      kaspiState: order.state,
      checksum,
      processingTimeMs: processingTime,
      retryCount: 0
    });
    
    logger.info({
      orderCode,
      leadId: lead.id,
      contactId: contact.id,
      processingTimeMs: processingTime
    }, '✅ Заказ успешно обработан');
    
    stats.ordersProcessed++;
    stats.totalAmount += order.totalPrice;
    stats.processingTimes.push(processingTime);
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    
    logger.error({
      orderCode,
      error: error.message,
      processingTimeMs: processingTime
    }, '❌ Ошибка при обработке заказа');
    
    // Сохраняем информацию об ошибке
    await repository.saveProcessedOrder({
      orderCode,
      leadId: null,
      kaspiState: order.state,
      checksum: kaspiService.calculateChecksum(order),
      processingTimeMs: processingTime,
      retryCount: previousRetryCount + 1,
      lastError: error.message
    });
    
    stats.ordersFailed++;
    stats.errors.push({ orderCode, error: error.message });
  }
}

/**
 * Главная функция опроса
 */
async function pollAndCreate() {
  const runId = logger.startOperation('poll-and-create');
  
  try {
    // Проверяем подключение к БД
    const dbConnected = await checkDatabaseConnection();
    if (!dbConnected) {
      throw new Error('Нет подключения к базе данных');
    }
    
    // Пытаемся захватить лок
    const lockAcquired = await repository.acquireLock('poll', 5);
    if (!lockAcquired) {
      logger.info('Другой процесс уже выполняет опрос, пропускаем');
      return;
    }
    
    logger.info({ 
      dryRun: config.DRY_RUN,
      allowedStates: config.KASPI_ALLOWED_STATES_ARRAY
    }, '🚀 Начинаем опрос Kaspi');
    
    // Получаем заказы из Kaspi
    const ordersResponse = await kaspiService.getOrders({
      state: config.KASPI_ALLOWED_STATES_ARRAY,
      sort: 'createdAt:desc'
    });
    
    const orders = ordersResponse.data || [];
    logger.info({ ordersCount: orders.length }, 'Получены заказы из Kaspi');
    
    if (orders.length === 0) {
      logger.info('Нет новых заказов для обработки');
      await repository.releaseLock('poll');
      await repository.updateHeartbeat();
      return;
    }
    
    // Обрабатываем заказы последовательно (чтобы соблюдать rate limit)
    for (const order of orders) {
      await processOrder(order);
    }
    
    // Обновляем статистику в БД
    const avgProcessingTime = stats.processingTimes.length > 0
      ? Math.round(stats.processingTimes.reduce((a, b) => a + b, 0) / stats.processingTimes.length)
      : 0;
    
    await repository.updateDailyStats(new Date(), {
      ordersProcessed: stats.ordersProcessed,
      ordersFailed: stats.ordersFailed,
      totalAmount: stats.totalAmount,
      avgProcessingTimeMs: avgProcessingTime
    });
    
    // Обновляем метаданные
    const totalProcessed = parseInt(await repository.getMeta('total_orders_processed') || '0');
    const totalFailed = parseInt(await repository.getMeta('total_orders_failed') || '0');
    
    await repository.setMeta('total_orders_processed', totalProcessed + stats.ordersProcessed);
    await repository.setMeta('total_orders_failed', totalFailed + stats.ordersFailed);
    
    // Проверяем пороги для алертов
    const backlog = orders.length - stats.ordersProcessed - stats.ordersSkipped;
    if (backlog >= config.ALERT_BACKLOG_THRESHOLD) {
      await alertService.sendWarningAlert(
        'Большой backlog заказов',
        `${backlog} заказов не обработано в текущем цикле`,
        { backlog, threshold: config.ALERT_BACKLOG_THRESHOLD }
      );
    }
    
    // Успешное завершение - сбрасываем счетчик ошибок
    await repository.resetFailures();
    await repository.updateHeartbeat();
    
    // Освобождаем лок
    await repository.releaseLock('poll');
    
    const duration = Date.now() - stats.startTime;
    logger.endOperation('poll-and-create', runId, {
      duration,
      processed: stats.ordersProcessed,
      failed: stats.ordersFailed,
      skipped: stats.ordersSkipped,
      totalAmount: stats.totalAmount,
      avgProcessingTime
    });
    
    // Итоговая статистика
    logger.info({
      processed: stats.ordersProcessed,
      failed: stats.ordersFailed,
      skipped: stats.ordersSkipped,
      totalAmount: stats.totalAmount,
      durationSec: Math.round(duration / 1000)
    }, '✅ Опрос завершен успешно');
    
  } catch (error) {
    logger.operationError('poll-and-create', error, { runId });
    
    // Увеличиваем счетчик ошибок
    const failures = await repository.incrementFailures();
    
    // Сохраняем информацию об ошибке
    await repository.logError('POLL_ERROR', error.message, {
      runId,
      stats
    });
    
    // Проверяем пороги для критических алертов
    if (failures >= config.ALERT_FAIL_STREAK) {
      await alertService.sendCriticalAlert(
        'Критическая ошибка опроса',
        error.message,
        { failures, runId }
      );
    }
    
    // Освобождаем лок в любом случае
    await repository.releaseLock('poll');
    
    throw error;
  }
}

// Обработка сигналов завершения
process.on('SIGTERM', async () => {
  logger.info('Получен SIGTERM, завершаем работу...');
  await repository.releaseLock('poll');
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Получен SIGINT, завершаем работу...');
  await repository.releaseLock('poll');
  process.exit(0);
});

// Запускаем
if (import.meta.url === `file://${process.argv[1]}`) {
  pollAndCreate()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      logger.fatal({ error: error.message, stack: error.stack }, 'Фатальная ошибка');
      process.exit(1);
    });
}