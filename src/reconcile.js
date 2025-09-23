#!/usr/bin/env node

import config from './config/env.js';
import logger from './utils/logger.js';
import repository from './db/repository.js';
import alertService from './utils/alerts.js';
import kaspiService from './services/kaspi.js';
import amoCRMService from './services/amocrm.js';
import phoneService from './services/phone.js';
import { checkDatabaseConnection } from './config/database.js';

// Статистика сверки
const stats = {
  ordersChecked: 0,
  ordersCreated: 0,
  ordersUpdated: 0,
  ordersFailed: 0,
  startTime: Date.now()
};

function resetStats() {
  stats.ordersChecked = 0;
  stats.ordersCreated = 0;
  stats.ordersUpdated = 0;
  stats.ordersFailed = 0;
  stats.startTime = Date.now();
}

export async function fetchUpdatedKaspiOrders(fromDate, params = {}) {
  const kaspiOrders = [];
  let page = 1;
  let hasMore = true;
  let totalCountLogged = false;

  while (hasMore) {
    const ordersResponse = await kaspiService.getOrdersUpdatedAfter(fromDate, {
      ...params,
      page
    });

    const pageOrders = ordersResponse.data || [];

    if (!totalCountLogged) {
      const totalCount = ordersResponse.meta?.totalCount ?? pageOrders.length;
      logger.info({ ordersCount: totalCount }, 'Получены обновленные заказы из Kaspi');
      totalCountLogged = true;
    }

    if (pageOrders.length === 0) {
      break;
    }

    kaspiOrders.push(...pageOrders);

    if (ordersResponse.meta) {
      const { totalPages = 1 } = ordersResponse.meta;
      hasMore = page < totalPages;
    } else {
      hasMore = pageOrders.length === config.KASPI_PAGE_SIZE;
    }

    page++;

    if (page > 100) {
      logger.warn('Достигнут лимит страниц (100) при получении обновленных заказов из Kaspi');
      break;
    }
  }

  return kaspiOrders;
}

/**
 * Сверяет и обновляет один заказ
 */
export async function reconcileOrder(kaspiOrder, processedOrder) {
  const orderCode = kaspiOrder.code;
  
  try {
    // Вычисляем новую контрольную сумму
    const newChecksum = kaspiService.calculateChecksum(kaspiOrder);
    
    // Если заказ не был создан в amoCRM (была ошибка), создаем его
    if (!processedOrder || !processedOrder.amocrm_lead_id) {
      logger.info({ orderCode }, 'Заказ не был создан в amoCRM, создаем');
      
      // Извлекаем данные покупателя
      const phone = phoneService.extractPhoneFromBuyer(kaspiOrder.buyer);
      if (!phone) {
        throw new Error('Не найден телефон покупателя');
      }
      
      const contactName = phoneService.generateContactName(kaspiOrder.buyer);
      
      // В DRY_RUN режиме только логируем
      if (config.DRY_RUN) {
        logger.info({
          orderCode,
          contactName,
          phone: phoneService.maskPhone(phone),
          totalPrice: kaspiOrder.totalPrice
        }, '[DRY_RUN] Будет создан пропущенный заказ');
        
        stats.ordersCreated++;
        return;
      }
      
      // Ищем или создаем контакт
      let contact = await amoCRMService.findContactByPhone(phone);
      if (!contact) {
        contact = await amoCRMService.createContact({ name: contactName, phone });
      }
      
      // Создаем сделку
      const leadName = `Kaspi #${orderCode} — ${contactName}`;
      const itemsText = kaspiService.formatItemsForNote(kaspiOrder.items);
      const noteText = config.NOTE_TEMPLATE
        .replace('{{items}}', itemsText)
        .replace('{{total}}', kaspiOrder.totalPrice);
      
      const lead = await amoCRMService.createLeadComplex({
        name: leadName,
        price: kaspiOrder.totalPrice,
        contactId: contact.id,
        items: kaspiOrder.items || [],
        noteText,
        tags: ['kaspi', kaspiOrder.state.toLowerCase(), 'reconciled']
      });
      
      // Сохраняем в БД
      await repository.saveProcessedOrder({
        orderCode,
        leadId: lead.id,
        kaspiState: kaspiOrder.state,
        checksum: newChecksum,
        processingTimeMs: 0,
        retryCount: processedOrder?.retry_count || 0
      });

      await repository.updateOrderStats({
        success: true,
        amount: Number(kaspiOrder.totalPrice) || 0,
        reconcileUpdate: true,
        leadCreated: true
      });

      logger.info({ orderCode, leadId: lead.id }, '✅ Пропущенный заказ создан при сверке');
      stats.ordersCreated++;
      return;
    }
    
    // Проверяем, изменились ли данные заказа
    if (processedOrder.checksum === newChecksum) {
      logger.debug({ orderCode }, 'Заказ не изменился, пропускаем');
      return;
    }
    
    logger.info({ 
      orderCode, 
      oldChecksum: processedOrder.checksum,
      newChecksum 
    }, 'Обнаружены изменения в заказе');
    
    // В DRY_RUN режиме только логируем
    if (config.DRY_RUN) {
      logger.info({
        orderCode,
        leadId: processedOrder.amocrm_lead_id,
        oldPrice: processedOrder.total_price,
        newPrice: kaspiOrder.totalPrice
      }, '[DRY_RUN] Будет обновлен заказ');
      
      stats.ordersUpdated++;
      return;
    }
    
    // Обновляем сделку в amoCRM
    const leadId = processedOrder.amocrm_lead_id;
    
    // Обновляем сумму сделки если изменилась
    await amoCRMService.updateLead(leadId, {
      price: Math.round(kaspiOrder.totalPrice)
    });
    
    // Обновляем позиции если изменились
    if (kaspiOrder.items && kaspiOrder.items.length > 0) {
      await amoCRMService.updateLeadProducts(leadId, kaspiOrder.items);

      // Добавляем заметку об изменении
      const itemsText = kaspiService.formatItemsForNote(kaspiOrder.items);
      const updateNote = `📝 Обновлено при сверке ${new Date().toLocaleString('ru-RU', { timeZone: config.TIMEZONE })}\n` +
                        `Новый состав: ${itemsText}\n` +
                        `Новая сумма: ${kaspiOrder.totalPrice} тг`;
      
      await amoCRMService.addNoteToLead(leadId, updateNote);
    }
    
    // Обновляем запись в БД
    await repository.saveProcessedOrder({
      orderCode,
      leadId,
      kaspiState: kaspiOrder.state,
      checksum: newChecksum,
      processingTimeMs: 0,
      retryCount: 0
    });

    await repository.updateOrderStats({
      success: true,
      amount: Number(kaspiOrder.totalPrice) || 0,
      reconcileUpdate: true
    });

    logger.info({ orderCode, leadId }, '✅ Заказ обновлен при сверке');
    stats.ordersUpdated++;

  } catch (error) {
    logger.error({
      orderCode,
      error: error.message
    }, '❌ Ошибка при сверке заказа');

    stats.ordersFailed++;

    if (!config.DRY_RUN) {
      await repository.updateOrderStats({
        success: false,
        amount: 0,
        reconcileUpdate: false
      });
    }

    // Логируем ошибку в БД
    await repository.logError('RECONCILE_ERROR', error.message, {
      orderCode,
      processedOrder
    });
  }
}

/**
 * Главная функция сверки
 */
async function reconcile() {
  const runId = logger.startOperation('reconcile');
  
  try {
    // Проверяем подключение к БД
    const dbConnected = await checkDatabaseConnection();
    if (!dbConnected) {
      throw new Error('Нет подключения к базе данных');
    }
    
    // Пытаемся захватить лок
    const lockAcquired = await repository.acquireLock('reconcile', 15);
    if (!lockAcquired) {
      logger.info('Другой процесс уже выполняет сверку, пропускаем');
      return;
    }

    resetStats();

    // Получаем водяной знак последней сверки
    const watermark = await repository.getReconcileWatermark();

    // Добавляем 2-часовой буфер для надежности
    const fromDate = new Date(watermark.getTime() - 2 * 60 * 60 * 1000);
    
    logger.info({ 
      watermark,
      fromDate,
      dryRun: config.DRY_RUN
    }, '🔄 Начинаем инкрементальную сверку');
    
    // Получаем обновленные заказы из Kaspi
    const kaspiOrders = await fetchUpdatedKaspiOrders(fromDate, {
      state: config.KASPI_ALLOWED_STATES_ARRAY
    });

    if (kaspiOrders.length === 0) {
      logger.info('Нет заказов для сверки');
      await repository.updateReconcileWatermark(new Date());
      await repository.releaseLock('reconcile');
      return;
    }
    
    // Получаем обработанные заказы из БД для сравнения
    const processedOrdersMap = {};
    for (const kaspiOrder of kaspiOrders) {
      const processed = await repository.getProcessedOrder(kaspiOrder.code);
      if (processed) {
        processedOrdersMap[kaspiOrder.code] = processed;
      }
      stats.ordersChecked++;
    }
    
    // Сверяем каждый заказ
    for (const kaspiOrder of kaspiOrders) {
      const processedOrder = processedOrdersMap[kaspiOrder.code];
      await reconcileOrder(kaspiOrder, processedOrder);
    }
    
    // Обновляем водяной знак
    const maxUpdatedAt = kaspiOrders.reduce((max, order) => {
      const updatedAt = new Date(order.updatedAt || order.createdAt);
      return updatedAt > max ? updatedAt : max;
    }, watermark);

    await repository.updateReconcileWatermark(maxUpdatedAt);

    if (!config.DRY_RUN) {
      const totalProcessed = parseInt(await repository.getMeta('total_orders_processed') || '0');
      const totalFailed = parseInt(await repository.getMeta('total_orders_failed') || '0');

      await repository.setMeta('total_orders_processed',
        totalProcessed + stats.ordersCreated + stats.ordersUpdated);
      await repository.setMeta('total_orders_failed', totalFailed + stats.ordersFailed);
    }

    // Освобождаем лок
    await repository.releaseLock('reconcile');
    
    const duration = Date.now() - stats.startTime;
    logger.endOperation('reconcile', runId, {
      duration,
      checked: stats.ordersChecked,
      created: stats.ordersCreated,
      updated: stats.ordersUpdated,
      failed: stats.ordersFailed
    });
    
    // Итоговая статистика
    logger.info({
      checked: stats.ordersChecked,
      created: stats.ordersCreated,
      updated: stats.ordersUpdated,
      failed: stats.ordersFailed,
      durationSec: Math.round(duration / 1000),
      newWatermark: maxUpdatedAt
    }, '✅ Сверка завершена успешно');
    
    // Если были созданы или обновлены заказы, отправляем информационный алерт
    if (stats.ordersCreated > 0 || stats.ordersUpdated > 0) {
      await alertService.sendInfoAlert(
        'Результаты сверки',
        `Создано: ${stats.ordersCreated}, Обновлено: ${stats.ordersUpdated}`,
        stats
      );
    }
    
  } catch (error) {
    logger.operationError('reconcile', error, { runId });
    
    // Сохраняем информацию об ошибке
    await repository.logError('RECONCILE_CRITICAL', error.message, {
      runId,
      stats
    });
    
    // Отправляем критический алерт
    await alertService.sendCriticalAlert(
      'Критическая ошибка сверки',
      error.message,
      { runId, stats }
    );
    
    // Освобождаем лок в любом случае
    await repository.releaseLock('reconcile');
    
    throw error;
  }
}

// Обработка сигналов завершения
process.on('SIGTERM', async () => {
  logger.info('Получен SIGTERM, завершаем работу...');
  await repository.releaseLock('reconcile');
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Получен SIGINT, завершаем работу...');
  await repository.releaseLock('reconcile');
  process.exit(0);
});

// Запускаем
if (import.meta.url === `file://${process.argv[1]}`) {
  reconcile()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      logger.fatal({ error: error.message, stack: error.stack }, 'Фатальная ошибка');
      process.exit(1);
    });
}