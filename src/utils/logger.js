import pino from 'pino';
import config from '../config/env.js';

// Функция для маскирования чувствительных данных
function maskSensitiveData(obj) {
  if (!obj) return obj;
  
  const masked = { ...obj };
  
  // Маскируем телефоны
  if (masked.phone) {
    masked.phone = maskPhone(masked.phone);
  }
  if (masked.buyer?.phone) {
    masked.buyer = { ...masked.buyer, phone: maskPhone(masked.buyer.phone) };
  }
  
  // Маскируем токены
  if (masked.token) {
    masked.token = masked.token.substring(0, 6) + '***';
  }
  if (masked.access_token) {
    masked.access_token = masked.access_token.substring(0, 6) + '***';
  }
  if (masked.refresh_token) {
    masked.refresh_token = masked.refresh_token.substring(0, 6) + '***';
  }
  
  // Маскируем email
  if (masked.email) {
    const [local, domain] = masked.email.split('@');
    masked.email = local.substring(0, 2) + '***@' + domain;
  }
  
  return masked;
}

// Функция для маскирования телефона
export function maskPhone(phone) {
  if (!phone) return phone;
  const str = String(phone);
  if (str.length < 7) return '***';
  
  // Оставляем первые 2 и последние 2 цифры
  const start = str.substring(0, str.length > 10 ? 3 : 2);
  const end = str.substring(str.length - 2);
  return `${start}***${end}`;
}

// Настройки для pino
const pinoOptions = {
  level: config.LOG_LEVEL,
  formatters: {
    level: (label) => {
      return { level: label };
    },
    bindings: () => {
      return {
        pid: process.pid,
        hostname: 'kaspi-amo',
        app: 'integrator',
        env: config.DRY_RUN ? 'dry-run' : 'production'
      };
    },
    log: (obj) => {
      // Маскируем чувствительные данные во всех логах
      return maskSensitiveData(obj);
    }
  },
  timestamp: () => `,"time":"${new Date().toISOString()}"`,
  base: {
    timezone: config.TIMEZONE
  }
};

// Если LOG_PRETTY=true, используем pretty print для разработки
if (config.LOG_PRETTY) {
  pinoOptions.transport = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss.l',
      ignore: 'pid,hostname',
      singleLine: false
    }
  };
}

// Создаем logger
const logger = pino(pinoOptions);

// Добавляем удобные методы
logger.startOperation = (operation, details = {}) => {
  const operationId = Math.random().toString(36).substring(7);
  logger.info({ 
    operation, 
    operationId, 
    ...details, 
    status: 'started' 
  }, `🚀 Начинается операция: ${operation}`);
  return operationId;
};

logger.endOperation = (operation, operationId, details = {}) => {
  logger.info({ 
    operation, 
    operationId, 
    ...details, 
    status: 'completed' 
  }, `✅ Операция завершена: ${operation}`);
};

logger.operationError = (operation, error, details = {}) => {
  logger.error({ 
    operation, 
    error: error.message, 
    stack: error.stack,
    ...details, 
    status: 'failed' 
  }, `❌ Ошибка операции: ${operation}`);
};

// Экспортируем logger
export default logger;