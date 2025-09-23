import logger from './logger.js';

/**
 * Выполняет функцию с повторными попытками при ошибках
 */
export async function withRetry(fn, options = {}) {
  const {
    maxAttempts = 3,
    initialDelay = 1000,
    maxDelay = 30000,
    exponentialBase = 2,
    shouldRetry = () => true,
    onRetry = () => {},
    context = ''
  } = options;
  
  let lastError;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // Проверяем, нужно ли повторять
      if (!shouldRetry(error, attempt)) {
        throw error;
      }
      
      if (attempt === maxAttempts) {
        logger.error({ 
          error: error.message, 
          attempts: attempt,
          context 
        }, `Все ${maxAttempts} попыток исчерпаны`);
        throw error;
      }
      
      // Рассчитываем задержку (экспоненциальная с jitter)
      const baseDelay = Math.min(initialDelay * Math.pow(exponentialBase, attempt - 1), maxDelay);
      const jitter = Math.random() * 0.3 * baseDelay; // до 30% jitter
      const delay = Math.round(baseDelay + jitter);
      
      logger.warn({ 
        error: error.message, 
        attempt, 
        maxAttempts, 
        nextDelay: delay,
        context 
      }, `Попытка ${attempt}/${maxAttempts} не удалась, повтор через ${delay}мс`);
      
      // Колбэк при повторе
      onRetry(error, attempt, delay);
      
      // Ждем перед следующей попыткой
      await sleep(delay);
    }
  }
  
  throw lastError;
}

/**
 * Проверяет, является ли ошибка временной (можно повторить)
 */
export function isRetryableError(error) {
  // Сетевые ошибки
  if (error.code === 'ECONNRESET' || 
      error.code === 'ETIMEDOUT' || 
      error.code === 'ECONNREFUSED' ||
      error.code === 'ENOTFOUND') {
    return true;
  }
  
  // HTTP статусы
  if (error.response) {
    const status = error.response.status;
    
    // 429 Too Many Requests - всегда повторяем
    if (status === 429) return true;
    
    // 5xx ошибки сервера - повторяем
    if (status >= 500 && status < 600) return true;
    
    // 408 Request Timeout
    if (status === 408) return true;
    
    // 503 Service Unavailable
    if (status === 503) return true;
  }
  
  // Ошибки таймаута axios
  if (error.message && error.message.includes('timeout')) {
    return true;
  }
  
  return false;
}

/**
 * Извлекает время до следующей попытки из заголовков Retry-After
 */
export function getRetryAfterMs(error) {
  if (!error.response || !error.response.headers) {
    return null;
  }
  
  const retryAfter = error.response.headers['retry-after'];
  if (!retryAfter) {
    return null;
  }
  
  // Retry-After может быть в секундах или в формате даты
  const seconds = parseInt(retryAfter);
  if (!isNaN(seconds)) {
    return seconds * 1000;
  }
  
  // Попытка парсить как дату
  const retryDate = new Date(retryAfter);
  if (!isNaN(retryDate.getTime())) {
    return Math.max(0, retryDate.getTime() - Date.now());
  }
  
  return null;
}

/**
 * Функция задержки
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Rate limiter для ограничения частоты запросов
 */
export class RateLimiter {
  constructor(maxRequestsPerSecond) {
    this.maxRequestsPerSecond = maxRequestsPerSecond;
    this.minInterval = 1000 / maxRequestsPerSecond;
    this.lastRequestTime = 0;
    this.queue = [];
    this.processing = false;
  }
  
  async throttle() {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.processQueue();
    });
  }
  
  async processQueue() {
    if (this.processing || this.queue.length === 0) {
      return;
    }
    
    this.processing = true;
    
    while (this.queue.length > 0) {
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequestTime;
      
      if (timeSinceLastRequest < this.minInterval) {
        const waitTime = this.minInterval - timeSinceLastRequest;
        await sleep(waitTime);
      }
      
      this.lastRequestTime = Date.now();
      const resolve = this.queue.shift();
      resolve();
      
      // Небольшая задержка между обработкой элементов очереди
      if (this.queue.length > 0) {
        await sleep(10);
      }
    }
    
    this.processing = false;
  }
  
  getQueueSize() {
    return this.queue.length;
  }
  
  reset() {
    this.lastRequestTime = 0;
    this.queue = [];
    this.processing = false;
  }
}

export default {
  withRetry,
  isRetryableError,
  getRetryAfterMs,
  sleep,
  RateLimiter
};