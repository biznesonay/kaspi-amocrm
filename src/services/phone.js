import { parsePhoneNumber, isValidPhoneNumber } from 'libphonenumber-js';
import logger, { maskPhone as maskPhoneFromLogger } from '../utils/logger.js';

const maskPhone = maskPhoneFromLogger;

export { maskPhone };

/**
 * Нормализует телефонный номер в формат E.164
 * Примеры:
 * +7 (777) 123-45-67 -> +77771234567
 * 8 777 123 45 67 -> +77771234567
 * 77771234567 -> +77771234567
 */
export function normalizePhone(phone) {
  if (!phone) {
    return null;
  }
  
  // Убираем все, кроме цифр и +
  let cleaned = String(phone).replace(/[^\d+]/g, '');
  
  // Обработка казахстанских номеров
  if (cleaned.startsWith('8') && cleaned.length === 11) {
    // Заменяем 8 на +7 для Казахстана/России
    cleaned = '+7' + cleaned.substring(1);
  } else if (cleaned.startsWith('7') && cleaned.length === 11) {
    // Добавляем + если его нет
    cleaned = '+' + cleaned;
  } else if (!cleaned.startsWith('+')) {
    // Пытаемся добавить код страны Казахстана по умолчанию
    if (cleaned.length === 10) {
      cleaned = '+7' + cleaned;
    }
  }
  
  try {
    // Пытаемся распарсить через libphonenumber
    if (isValidPhoneNumber(cleaned, 'KZ')) {
      const phoneNumber = parsePhoneNumber(cleaned, 'KZ');
      return phoneNumber.format('E.164');
    } else if (isValidPhoneNumber(cleaned)) {
      const phoneNumber = parsePhoneNumber(cleaned);
      return phoneNumber.format('E.164');
    }
  } catch (error) {
    logger.debug({ phone: cleaned, error: error.message }, 'Не удалось нормализовать телефон через libphonenumber');
  }
  
  // Если не удалось распарсить, но похоже на валидный номер
  if (cleaned.startsWith('+') && cleaned.length >= 11 && cleaned.length <= 15) {
    return cleaned;
  }
  
  logger.warn({ originalPhone: phone, cleaned }, 'Не удалось нормализовать телефон');
  return null;
}

/**
 * Форматирует телефон для отображения в amoCRM
 * +77771234567 -> +7 (777) 123-45-67
 */
export function formatPhoneForDisplay(phone) {
  if (!phone) return '';
  
  try {
    const phoneNumber = parsePhoneNumber(phone);
    if (phoneNumber) {
      return phoneNumber.formatInternational();
    }
  } catch (error) {
    // Если не удалось отформатировать, возвращаем как есть
  }
  
  return phone;
}

/**
 * Проверяет, является ли телефон валидным
 */
export function isValidPhone(phone) {
  if (!phone) return false;
  
  const normalized = normalizePhone(phone);
  if (!normalized) return false;
  
  try {
    return isValidPhoneNumber(normalized);
  } catch {
    // Минимальная проверка если libphonenumber не справился
    return normalized.startsWith('+') && 
           normalized.length >= 11 && 
           normalized.length <= 15 &&
           /^\+\d+$/.test(normalized);
  }
}

/**
 * Извлекает телефон из объекта покупателя Kaspi
 */
export function extractPhoneFromBuyer(buyer) {
  if (!buyer) return null;
  
  // Kaspi может отдавать телефон в разных полях
  const possiblePhones = [
    buyer.phone,
    buyer.mobilePhone,
    buyer.cellPhone,
    buyer.phoneNumber,
    buyer.contactPhone
  ];
  
  for (const phone of possiblePhones) {
    if (phone) {
      const normalized = normalizePhone(phone);
      if (normalized) {
        return normalized;
      }
    }
  }
  
  return null;
}

/**
 * Генерирует имя контакта из данных покупателя
 */
export function generateContactName(buyer) {
  if (!buyer) return 'Покупатель Kaspi';
  
  const parts = [];
  
  if (buyer.lastName) parts.push(buyer.lastName);
  if (buyer.firstName) parts.push(buyer.firstName);
  if (buyer.middleName) parts.push(buyer.middleName);
  
  if (parts.length > 0) {
    return parts.join(' ').trim();
  }
  
  // Если имени нет, используем email или телефон
  if (buyer.email) {
    return buyer.email.split('@')[0];
  }
  
  const phone = extractPhoneFromBuyer(buyer);
  if (phone) {
    // Маскируем телефон для имени
    const masked = phone.replace(/(\+\d{1,3})(\d{3})(\d+)(\d{2})/, '$1 $2***$4');
    return `Клиент ${masked}`;
  }
  
  return 'Покупатель Kaspi';
}

export default {
  normalizePhone,
  formatPhoneForDisplay,
  isValidPhone,
  extractPhoneFromBuyer,
  generateContactName,
  maskPhone
};