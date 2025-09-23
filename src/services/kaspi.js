import axios from 'axios';
import crypto from 'crypto';
import { z } from 'zod';
import config from '../config/env.js';
import logger from '../utils/logger.js';
import { withRetry, isRetryableError } from '../utils/retry.js';

// Схема валидации ответа Kaspi
const KaspiOrderSchema = z.object({
  id: z.string(),
  code: z.string(),
  totalPrice: z.number(),
  state: z.string(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  
  buyer: z.object({
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    middleName: z.string().optional(),
    phone: z.string().optional(),
    mobilePhone: z.string().optional(),
    email: z.string().optional(),
  }).optional(),
  
  items: z.array(z.object({
    sku: z.string(),
    name: z.string(),
    quantity: z.number(),
    price: z.number(),
    amount: z.number().optional(),
  })).optional().default([]),
  
  delivery: z.object({
    address: z.string().optional(),
    city: z.string().optional(),
    region: z.string().optional(),
  }).optional(),
  
  pickup: z.object({
    address: z.string().optional(),
    pointName: z.string().optional(),
  }).optional(),
  
  payment: z.object({
    type: z.string().optional(),
    status: z.string().optional(),
  }).optional(),
});

const KaspiOrdersResponseSchema = z.object({
  data: z.array(KaspiOrderSchema),
  meta: z.object({
    page: z.number().optional(),
    pageSize: z.number().optional(),
    totalCount: z.number().optional(),
    totalPages: z.number().optional(),
  }).optional(),
});

class KaspiService {
  constructor() {
    const rawBaseUrl = config.KASPI_BASE_URL.replace(/\/+$/, '');
    const rawVersion = (config.KASPI_API_VERSION || '').toString().trim();
    const normalizedVersion = rawVersion.replace(/^\/+|\/+$/g, '');

    if (normalizedVersion && rawBaseUrl.endsWith(`/${normalizedVersion}`)) {
      this.baseURL = rawBaseUrl;
    } else if (normalizedVersion) {
      this.baseURL = `${rawBaseUrl}/${normalizedVersion}`;
    } else {
      this.baseURL = rawBaseUrl;
    }

    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: 30000,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Auth-Token': config.KASPI_API_TOKEN,
      }
    });
    
    // Перехватчики для логирования
    this.client.interceptors.request.use(
      (request) => {
        logger.debug({ 
          method: request.method, 
          url: request.url,
          params: request.params 
        }, 'Kaspi API запрос');
        return request;
      },
      (error) => {
        logger.error({ error: error.message }, 'Ошибка запроса Kaspi API');
        return Promise.reject(error);
      }
    );
    
    this.client.interceptors.response.use(
      (response) => {
        logger.debug({ 
          status: response.status,
          dataLength: response.data?.data?.length 
        }, 'Kaspi API ответ');
        return response;
      },
      (error) => {
        if (error.response) {
          logger.error({ 
            status: error.response.status,
            data: error.response.data,
            headers: error.response.headers
          }, 'Ошибка ответа Kaspi API');
        } else {
          logger.error({ error: error.message }, 'Сетевая ошибка Kaspi API');
        }
        return Promise.reject(error);
      }
    );
  }
  
  /**
   * Получает список заказов с пагинацией
   */
  async getOrders(params = {}) {
    const defaultParams = {
      page: 1,
      pageSize: config.KASPI_PAGE_SIZE,
      state: config.KASPI_ALLOWED_STATES_ARRAY,
      sort: 'createdAt:desc'
    };
    
    const queryParams = { ...defaultParams, ...params };
    
    // Если state - массив, преобразуем в строку
    if (Array.isArray(queryParams.state)) {
      queryParams.state = queryParams.state.join(',');
    }
    
    return await withRetry(
      async () => {
        const response = await this.client.get('/orders', { params: queryParams });
        
        // Валидируем ответ
        const validated = KaspiOrdersResponseSchema.parse(response.data);
        
        logger.info({ 
          ordersCount: validated.data.length,
          totalCount: validated.meta?.totalCount,
          states: queryParams.state
        }, 'Получены заказы из Kaspi');
        
        return validated;
      },
      {
        maxAttempts: 3,
        shouldRetry: (error) => isRetryableError(error),
        context: 'Kaspi.getOrders'
      }
    );
  }
  
  /**
   * Получает все заказы (с учетом пагинации)
   */
  async getAllOrders(params = {}) {
    const allOrders = [];
    let page = 1;
    let hasMore = true;
    
    while (hasMore) {
      const response = await this.getOrders({ ...params, page });
      allOrders.push(...response.data);
      
      // Проверяем, есть ли еще страницы
      if (response.meta) {
        const { totalPages = 1 } = response.meta;
        hasMore = page < totalPages;
        page++;
      } else {
        // Если нет мета-информации, считаем что это последняя страница
        hasMore = response.data.length === config.KASPI_PAGE_SIZE;
        page++;
      }
      
      // Защита от бесконечного цикла
      if (page > 100) {
        logger.warn('Достигнут лимит страниц (100) при получении заказов');
        break;
      }
    }
    
    logger.info({ totalOrders: allOrders.length }, 'Получены все заказы из Kaspi');
    return allOrders;
  }
  
  /**
   * Получает заказы, обновленные после указанной даты
   */
  async getOrdersUpdatedAfter(date, params = {}) {
    const isoDate = date instanceof Date ? date.toISOString() : date;
    
    return await this.getOrders({
      ...params,
      updatedAfter: isoDate,
      sort: 'updatedAt:asc'
    });
  }
  
  /**
   * Получает один заказ по коду
   */
  async getOrderByCode(orderCode) {
    return await withRetry(
      async () => {
        const response = await this.client.get(`/orders/${orderCode}`);
        const validated = KaspiOrderSchema.parse(response.data);
        
        logger.debug({ orderCode }, 'Получен заказ из Kaspi');
        return validated;
      },
      {
        maxAttempts: 2,
        shouldRetry: (error) => isRetryableError(error),
        context: `Kaspi.getOrderByCode(${orderCode})`
      }
    );
  }
  
  /**
   * Вычисляет контрольную сумму заказа для проверки изменений
   */
  calculateChecksum(order) {
    const data = {
      totalPrice: order.totalPrice,
      state: order.state,
      items: order.items?.map(item => ({
        sku: item.sku,
        quantity: item.quantity,
        price: item.price
      })) || []
    };
    
    const json = JSON.stringify(data, Object.keys(data).sort());
    return crypto.createHash('md5').update(json).digest('hex');
  }
  
  /**
   * Форматирует товары для заметки
   */
  formatItemsForNote(items) {
    if (!items || items.length === 0) {
      return 'Товары не указаны';
    }
    
    const itemStrings = items.map(item => {
      const name = item.name || item.sku;
      const qty = item.quantity || 1;
      const price = item.price || 0;
      return `${name} x ${qty} — ${price} тг`;
    });
    
    return itemStrings.join('; ');
  }
  
  /**
   * Извлекает адрес доставки из заказа
   */
  extractDeliveryAddress(order) {
    const parts = [];
    
    if (order.delivery) {
      if (order.delivery.region) parts.push(order.delivery.region);
      if (order.delivery.city) parts.push(order.delivery.city);
      if (order.delivery.address) parts.push(order.delivery.address);
    } else if (order.pickup) {
      if (order.pickup.pointName) parts.push(order.pickup.pointName);
      if (order.pickup.address) parts.push(order.pickup.address);
    }
    
    return parts.length > 0 ? parts.join(', ') : null;
  }
  
  /**
   * Проверяет доступность API
   */
  async healthCheck() {
    try {
      await this.client.get('/health', { timeout: 5000 });
      return true;
    } catch (error) {
      logger.error({ error: error.message }, 'Kaspi API недоступен');
      return false;
    }
  }
}

// Создаем синглтон
const kaspiService = new KaspiService();
export default kaspiService;