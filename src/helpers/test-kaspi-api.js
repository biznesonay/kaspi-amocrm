/**
 * Helper скрипт для проверки Kaspi API
 * Запуск: node src/helpers/test-kaspi-api.js
 */

import axios from 'axios';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

console.log('🔍 Проверка Kaspi API\n');
console.log('=========================================\n');

// Возможные варианты Kaspi API endpoints
const POSSIBLE_ENDPOINTS = [
  'https://kaspi.kz/shop/api/v2',
  'https://kaspi.kz/merchantcabinet/api/v1',
  'https://api.kaspi.kz/v1',
  'https://kaspi.kz/shop/api',
  'https://merchantcabinet.kaspi.kz/api/v1'
];

async function testKaspiEndpoint(baseUrl) {
  console.log(`\n📡 Тестирую: ${baseUrl}`);
  console.log('-'.repeat(50));
  
  // Возможные варианты путей для заказов
  const orderPaths = [
    '/orders',
    '/order/list',
    '/merchants/orders',
    '/api/orders',
    '/v1/orders'
  ];

  for (const path of orderPaths) {
    try {
      const fullUrl = `${baseUrl}${path}`;
      console.log(`  Пробую: ${fullUrl}`);
      
      const response = await axios({
        method: 'GET',
        url: fullUrl,
        headers: {
          'Authorization': `Bearer ${config.kaspi.apiToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-API-KEY': config.kaspi.apiToken, // Альтернативный заголовок
        },
        params: {
          'page[number]': 0,
          'page[size]': 1,
          'filter[state]': 'NEW',
          'filter[status]': 'NEW', // Альтернативное название
        },
        timeout: 10000,
        validateStatus: () => true // Принимаем любой статус
      });

      console.log(`    Статус: ${response.status}`);
      
      if (response.status === 200) {
        console.log(`    ✅ УСПЕХ! Это рабочий endpoint!`);
        console.log(`    Структура ответа:`);
        
        // Показываем структуру ответа
        const data = response.data;
        console.log(`      - Тип: ${typeof data}`);
        
        if (data && typeof data === 'object') {
          const keys = Object.keys(data);
          console.log(`      - Ключи верхнего уровня: ${keys.join(', ')}`);
          
          // Если есть данные о заказах
          if (data.data && Array.isArray(data.data)) {
            console.log(`      - Найдено заказов: ${data.data.length}`);
            if (data.data.length > 0) {
              console.log(`      - Пример структуры заказа:`);
              const order = data.data[0];
              showObjectStructure(order, '        ');
            }
          } else if (data.orders && Array.isArray(data.orders)) {
            console.log(`      - Найдено заказов: ${data.orders.length}`);
            if (data.orders.length > 0) {
              console.log(`      - Пример структуры заказа:`);
              const order = data.orders[0];
              showObjectStructure(order, '        ');
            }
          } else if (data.items && Array.isArray(data.items)) {
            console.log(`      - Найдено заказов: ${data.items.length}`);
            if (data.items.length > 0) {
              console.log(`      - Пример структуры заказа:`);
              const order = data.items[0];
              showObjectStructure(order, '        ');
            }
          }
          
          // Информация о пагинации
          if (data.meta || data.pagination || data.links) {
            console.log(`      - Есть информация о пагинации`);
          }
        }
        
        return { success: true, endpoint: fullUrl, data: response.data };
        
      } else if (response.status === 401) {
        console.log(`    ❌ Ошибка авторизации (401)`);
        console.log(`       Возможные причины:`);
        console.log(`       - Неверный токен`);
        console.log(`       - Неправильный заголовок авторизации`);
        console.log(`       - Токен истек`);
        
      } else if (response.status === 403) {
        console.log(`    ❌ Доступ запрещен (403)`);
        console.log(`       Недостаточно прав для этого endpoint`);
        
      } else if (response.status === 404) {
        console.log(`    ❌ Не найден (404)`);
        
      } else if (response.status >= 500) {
        console.log(`    ❌ Ошибка сервера (${response.status})`);
        
      } else {
        console.log(`    ⚠️ Неожиданный статус: ${response.status}`);
        if (response.data) {
          console.log(`       Ответ: ${JSON.stringify(response.data).substring(0, 200)}`);
        }
      }
      
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        console.log(`    ❌ Соединение отклонено`);
      } else if (error.code === 'ETIMEDOUT') {
        console.log(`    ❌ Таймаут соединения`);
      } else if (error.code === 'ENOTFOUND') {
        console.log(`    ❌ Хост не найден`);
      } else {
        console.log(`    ❌ Ошибка: ${error.message}`);
      }
    }
  }
}

function showObjectStructure(obj, indent = '') {
  const keys = Object.keys(obj);
  for (const key of keys.slice(0, 10)) { // Показываем первые 10 ключей
    const value = obj[key];
    const type = Array.isArray(value) ? 'array' : typeof value;
    
    if (value === null) {
      console.log(`${indent}- ${key}: null`);
    } else if (type === 'object') {
      console.log(`${indent}- ${key}: {объект}`);
      if (key === 'buyer' || key === 'customer') {
        // Показываем структуру покупателя
        showObjectStructure(value, indent + '  ');
      }
    } else if (type === 'array') {
      console.log(`${indent}- ${key}: [массив, длина: ${value.length}]`);
      if (value.length > 0 && key === 'items') {
        console.log(`${indent}  Пример элемента:`);
        showObjectStructure(value[0], indent + '    ');
      }
    } else {
      const displayValue = type === 'string' ? `"${value.substring(0, 50)}..."` : value;
      console.log(`${indent}- ${key}: ${displayValue} (${type})`);
    }
  }
  
  if (keys.length > 10) {
    console.log(`${indent}... и еще ${keys.length - 10} полей`);
  }
}

async function testCurrentConfig() {
  console.log('\n📌 Проверка текущей конфигурации из .env:');
  console.log('=========================================');
  
  // Получаем base URL из конфигурации
  const currentBaseUrl = process.env.KASPI_BASE_URL || 'https://kaspi.kz/shop/api/v2';
  console.log(`Base URL: ${currentBaseUrl}`);
  console.log(`API Token: ${config.kaspi.apiToken ? '***' + config.kaspi.apiToken.slice(-4) : 'НЕ ЗАДАН'}`);
  
  if (!config.kaspi.apiToken) {
    console.log('\n❌ KASPI_API_TOKEN не задан в .env!');
    console.log('Установите токен и попробуйте снова.');
    return null;
  }
  
  const result = await testKaspiEndpoint(currentBaseUrl);
  return result;
}

async function findWorkingEndpoint() {
  console.log('\n🔎 Поиск рабочего endpoint:');
  console.log('=========================================');
  
  for (const endpoint of POSSIBLE_ENDPOINTS) {
    const result = await testKaspiEndpoint(endpoint);
    if (result && result.success) {
      return result;
    }
  }
  
  return null;
}

async function main() {
  try {
    // Сначала проверяем текущую конфигурацию
    const currentResult = await testCurrentConfig();
    
    if (currentResult && currentResult.success) {
      console.log('\n✅ Текущая конфигурация работает!');
      console.log(`Используйте: KASPI_BASE_URL=${currentResult.endpoint.split('/orders')[0]}`);
    } else {
      console.log('\n⚠️ Текущая конфигурация не работает.');
      console.log('Ищу рабочий endpoint...');
      
      // Пробуем найти рабочий endpoint
      const workingResult = await findWorkingEndpoint();
      
      if (workingResult && workingResult.success) {
        console.log('\n✅ Найден рабочий endpoint!');
        console.log('=========================================');
        console.log('Добавьте в .env:');
        console.log(`KASPI_BASE_URL=${workingResult.endpoint.split('/orders')[0]}`);
        console.log('=========================================');
        
        // Сохраняем пример ответа
        const fs = await import('fs/promises');
        const examplePath = './kaspi-response-example.json';
        await fs.writeFile(
          examplePath, 
          JSON.stringify(workingResult.data, null, 2)
        );
        console.log(`\nПример ответа сохранен в: ${examplePath}`);
        
      } else {
        console.log('\n❌ Не удалось найти рабочий endpoint.');
        console.log('\nВозможные причины:');
        console.log('1. Неверный API токен');
        console.log('2. Токен не активирован');
        console.log('3. У токена недостаточно прав');
        console.log('4. API endpoint изменился');
        console.log('\nРекомендации:');
        console.log('1. Проверьте токен в личном кабинете Kaspi');
        console.log('2. Убедитесь, что токен имеет права на чтение заказов');
        console.log('3. Обратитесь в поддержку Kaspi для получения документации API');
      }
    }
    
    // Дополнительная информация
    console.log('\n📚 Дополнительная информация:');
    console.log('=========================================');
    console.log('Если у вас есть документация Kaspi API:');
    console.log('1. Найдите правильный Base URL');
    console.log('2. Проверьте формат заголовка авторизации');
    console.log('   (Bearer token, X-API-KEY, или другой)');
    console.log('3. Уточните названия параметров фильтрации');
    console.log('   (state/status, filter[]/без префикса)');
    console.log('4. Проверьте формат пагинации');
    console.log('   (page[number]/page/offset)');
    
  } catch (error) {
    console.error('\n❌ Критическая ошибка:', error.message);
    logger.error({ error: error.message }, 'Kaspi API test failed');
    process.exit(1);
  }
}

// Запуск
main().then(() => {
  console.log('\n✅ Тест завершен');
  process.exit(0);
});