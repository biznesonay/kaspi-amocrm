import axios from 'axios';
import config from '../config/env.js';
import logger from '../utils/logger.js';
import repository from '../db/repository.js';
import { withRetry, isRetryableError, RateLimiter } from '../utils/retry.js';
import { normalizePhone } from './phone.js';

class AmoCRMService {
  constructor() {
    this.baseURL = config.AMO_BASE_URL;
    this.rateLimiter = new RateLimiter(config.AMO_RPS);
    
    // Создаем axios клиент
    this.client = axios.create({
      baseURL: `${this.baseURL}/api/${config.AMO_API_VERSION}`,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      }
    });
    
    // Перехватчик для добавления токена
    this.client.interceptors.request.use(
      async (request) => {
        // Получаем актуальный токен из БД
        const tokens = await this.getValidTokens();
        request.headers['Authorization'] = `Bearer ${tokens.amo_access_token}`;
        
        // Применяем rate limiting
        await this.rateLimiter.throttle();
        
        logger.debug({ 
          method: request.method, 
          url: request.url,
          hasData: !!request.data 
        }, 'amoCRM API запрос');
        
        return request;
      },
      (error) => {
        logger.error({ error: error.message }, 'Ошибка запроса amoCRM API');
        return Promise.reject(error);
      }
    );
    
    // Перехватчик для обработки ответов и ошибок
    this.client.interceptors.response.use(
      (response) => {
        logger.debug({ 
          status: response.status,
          hasData: !!response.data 
        }, 'amoCRM API ответ');
        return response;
      },
      async (error) => {
        if (error.response?.status === 401) {
          logger.warn('Токен amoCRM истек, обновляем...');
          
          // Пытаемся обновить токен
          const refreshed = await this.refreshAccessToken();
          if (refreshed) {
            // Повторяем оригинальный запрос с новым токеном
            const originalRequest = error.config;
            const tokens = await repository.getTokens();
            originalRequest.headers['Authorization'] = `Bearer ${tokens.amo_access_token}`;
            return this.client(originalRequest);
          }
        }
        
        if (error.response) {
          logger.error({ 
            status: error.response.status,
            data: error.response.data 
          }, 'Ошибка ответа amoCRM API');
        }
        
        return Promise.reject(error);
      }
    );
  }
  
  /**
   * Получает валидные токены, обновляя их при необходимости
   */
  async getValidTokens() {
    let tokens = await repository.getTokens();
    
    // Если токенов нет в БД, используем из конфига
    if (!tokens || tokens.amo_access_token === 'from_env') {
      await repository.updateTokens(
        config.AMO_ACCESS_TOKEN,
        config.AMO_REFRESH_TOKEN
      );
      tokens = await repository.getTokens();
    }
    
    // Проверяем, не истек ли токен
    if (tokens.expires_at && new Date(tokens.expires_at) < new Date()) {
      logger.info('Токен amoCRM истек, обновляем...');
      await this.refreshAccessToken();
      tokens = await repository.getTokens();
    }
    
    return tokens;
  }
  
  /**
   * Обновляет access token используя refresh token
   */
  async refreshAccessToken() {
    try {
      const tokens = await repository.getTokens();
      
      const response = await axios.post(`${this.baseURL}/oauth2/access_token`, {
        client_id: config.AMO_CLIENT_ID,
        client_secret: config.AMO_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: tokens.amo_refresh_token,
        redirect_uri: config.AMO_REDIRECT_URI
      });
      
      await repository.updateTokens(
        response.data.access_token,
        response.data.refresh_token,
        response.data.expires_in
      );
      
      logger.info('Токены amoCRM успешно обновлены');
      return true;
    } catch (error) {
      logger.error({ error: error.message }, 'Не удалось обновить токены amoCRM');
      return false;
    }
  }
  
  /**
   * Ищет контакт по телефону
   */
  async findContactByPhone(phone) {
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) {
      logger.warn({ phone }, 'Невалидный телефон для поиска контакта');
      return null;
    }
    
    return await withRetry(
      async () => {
        const response = await this.client.get('/contacts', {
          params: {
            query: normalizedPhone
          }
        });
        
        if (!response.data?._embedded?.contacts?.length) {
          return null;
        }
        
        // Ищем контакт с точным совпадением телефона
        for (const contact of response.data._embedded.contacts) {
          if (!contact.custom_fields_values) continue;
          
          const phoneFields = contact.custom_fields_values.filter(
            field => field.field_code === 'PHONE'
          );
          
          for (const field of phoneFields) {
            for (const value of field.values) {
              const contactPhone = normalizePhone(value.value);
              if (contactPhone === normalizedPhone) {
                logger.debug({ contactId: contact.id, phone: normalizedPhone }, 'Найден контакт по телефону');
                return contact;
              }
            }
          }
        }
        
        return null;
      },
      {
        maxAttempts: 2,
        shouldRetry: isRetryableError,
        context: 'amoCRM.findContactByPhone'
      }
    );
  }
  
  /**
   * Создает новый контакт
   */
  async createContact(data) {
    const { name, phone } = data;
    const normalizedPhone = normalizePhone(phone);
    
    if (!normalizedPhone) {
      throw new Error(`Невалидный телефон для создания контакта: ${phone}`);
    }
    
    const payload = [{
      name: name || 'Покупатель Kaspi',
      custom_fields_values: [
        {
          field_code: 'PHONE',
          values: [{ value: normalizedPhone }]
        }
      ]
    }];
    
    return await withRetry(
      async () => {
        const response = await this.client.post('/contacts', payload);
        
        const contact = response.data._embedded.contacts[0];
        logger.info({ contactId: contact.id, name, phone: normalizedPhone }, 'Создан новый контакт');
        
        return contact;
      },
      {
        maxAttempts: 3,
        shouldRetry: isRetryableError,
        context: 'amoCRM.createContact'
      }
    );
  }
  
  /**
   * Создает сделку с контактом, позициями и заметкой
   */
  async createLeadComplex(data) {
    const {
      name,
      price,
      contactId,
      items = [],
      noteText,
      customFields = {},
      tags = ['kaspi']
    } = data;
    
    // Формируем позиции товаров
    const catalogElements = items.map(item => ({
      name: item.name || item.sku,
      quantity: item.quantity || 1,
      price: item.price || 0
    }));
    
    // Основная структура сделки
    const leadData = {
      name,
      price: Math.round(price), // amoCRM требует целое число
      status_id: config.AMO_STATUS_ID,
      pipeline_id: config.AMO_PIPELINE_ID,
      _embedded: {
        contacts: [{ id: contactId }],
        tags: tags.map(tag => ({ name: tag }))
      }
    };
    
    // Добавляем кастомные поля если есть
    if (Object.keys(customFields).length > 0) {
      leadData.custom_fields_values = Object.entries(customFields).map(([code, value]) => ({
        field_code: code,
        values: [{ value }]
      }));
    }
    
    // Используем complex endpoint для создания всего сразу
    const payload = [{
      ...leadData,
      _embedded: {
        ...leadData._embedded,
        catalog_elements: config.USE_FREE_POSITIONS ? catalogElements : undefined
      }
    }];
    
    return await withRetry(
      async () => {
        // Создаем сделку
        const response = await this.client.post('/leads/complex', payload);
        const lead = response.data._embedded.leads[0];
        
        logger.info({ 
          leadId: lead.id, 
          name, 
          price,
          itemsCount: items.length 
        }, 'Создана сделка с позициями');
        
        // Добавляем заметку
        if (noteText) {
          await this.addNoteToLead(lead.id, noteText);
        }
        
        return lead;
      },
      {
        maxAttempts: 3,
        shouldRetry: isRetryableError,
        context: 'amoCRM.createLeadComplex'
      }
    );
  }
  
  /**
   * Добавляет заметку к сделке
   */
  async addNoteToLead(leadId, text) {
    const payload = [{
      note_type: 'common',
      params: {
        text
      },
      entity_id: leadId
    }];
    
    return await withRetry(
      async () => {
        const response = await this.client.post('/leads/notes', payload);
        logger.debug({ leadId, textLength: text.length }, 'Добавлена заметка к сделке');
        return response.data._embedded.notes[0];
      },
      {
        maxAttempts: 2,
        shouldRetry: isRetryableError,
        context: 'amoCRM.addNoteToLead'
      }
    );
  }
  
  /**
   * Обновляет сделку
   */
  async updateLead(leadId, data) {
    const payload = {
      id: leadId,
      ...data
    };
    
    return await withRetry(
      async () => {
        const response = await this.client.patch(`/leads/${leadId}`, payload);
        logger.info({ leadId, fields: Object.keys(data) }, 'Обновлена сделка');
        return response.data;
      },
      {
        maxAttempts: 2,
        shouldRetry: isRetryableError,
        context: 'amoCRM.updateLead'
      }
    );
  }
  
  /**
   * Получает сделку по ID
   */
  async getLeadById(leadId) {
    return await withRetry(
      async () => {
        const response = await this.client.get(`/leads/${leadId}`, {
          params: { with: 'catalog_elements' }
        });
        return response.data;
      },
      {
        maxAttempts: 2,
        shouldRetry: isRetryableError,
        context: 'amoCRM.getLeadById'
      }
    );
  }
  
  /**
   * Обновляет позиции товаров в сделке
   */
  async updateLeadProducts(leadId, items) {
    const catalogElements = items.map(item => ({
      name: item.name || item.sku,
      quantity: item.quantity || 1,
      price: item.price || 0
    }));
    
    // Сначала удаляем старые позиции
    try {
      const lead = await this.getLeadById(leadId);
      if (lead._embedded?.catalog_elements?.length) {
        // TODO: Реализовать удаление старых позиций если нужно
        logger.warn('Удаление старых позиций не реализовано');
      }
    } catch (error) {
      logger.error({ error: error.message }, 'Ошибка при получении текущих позиций');
    }
    
    // Добавляем новые позиции
    const payload = catalogElements;
    
    return await withRetry(
      async () => {
        const response = await this.client.post(`/leads/${leadId}/link`, {
          catalog_elements: payload
        });
        
        logger.info({ leadId, itemsCount: items.length }, 'Обновлены позиции товаров');
        return response.data;
      },
      {
        maxAttempts: 2,
        shouldRetry: isRetryableError,
        context: 'amoCRM.updateLeadProducts'
      }
    );
  }
  
  /**
   * Проверяет доступность API
   */
  async healthCheck() {
    try {
      await this.getValidTokens();
      const response = await this.client.get('/account', { 
        timeout: 5000,
        params: { with: 'pipelines' }
      });
      
      logger.info({ 
        accountId: response.data.id,
        accountName: response.data.name 
      }, 'amoCRM API доступен');
      
      return true;
    } catch (error) {
      logger.error({ error: error.message }, 'amoCRM API недоступен');
      return false;
    }
  }
}

// Создаем синглтон
const amoCRMService = new AmoCRMService();
export default amoCRMService;