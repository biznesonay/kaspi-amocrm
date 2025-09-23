/**
 * Helper скрипт для получения ID воронок, статусов и кастомных полей из amoCRM
 * Запуск: node src/helpers/get-amocrm-ids.js
 */

import { config } from '../config/env.js';
import { amoCRM } from '../services/amocrm.js';
import { logger } from '../utils/logger.js';

console.log('🔍 Получение ID полей из amoCRM\n');
console.log('База:', config.amocrm.baseUrl);
console.log('=========================================\n');

async function getAmoCRMInfo() {
  try {
    // Инициализируем токены
    await amoCRM.init();
    console.log('✅ Авторизация успешна\n');

    // 1. Получаем информацию об аккаунте
    console.log('📊 ИНФОРМАЦИЯ ОБ АККАУНТЕ:');
    console.log('-----------------------------------');
    const accountInfo = await amoCRM.makeRequest('/api/v4/account', 'GET');
    console.log('ID аккаунта:', accountInfo.id);
    console.log('Название:', accountInfo.name);
    console.log('Субдомен:', accountInfo.subdomain);
    console.log('Валюта:', accountInfo.currency);
    console.log('');

    // 2. Получаем воронки и статусы
    console.log('🔄 ВОРОНКИ И СТАТУСЫ:');
    console.log('-----------------------------------');
    const pipelines = await amoCRM.makeRequest('/api/v4/leads/pipelines', 'GET');
    
    if (pipelines._embedded && pipelines._embedded.pipelines) {
      for (const pipeline of pipelines._embedded.pipelines) {
        console.log(`\n📌 Воронка: "${pipeline.name}"`);
        console.log(`   ID: ${pipeline.id}`);
        console.log(`   Сортировка: ${pipeline.sort}`);
        console.log(`   Архивная: ${pipeline.is_archive ? 'Да' : 'Нет'}`);
        
        if (pipeline._embedded && pipeline._embedded.statuses) {
          console.log('   Статусы:');
          for (const status of pipeline._embedded.statuses) {
            const isWon = status.type === 1;
            const isLost = status.type === 0;
            const typeLabel = isWon ? ' (Успешно)' : isLost ? ' (Закрыто и не реализовано)' : '';
            console.log(`     - "${status.name}" (ID: ${status.id})${typeLabel}`);
          }
        }
      }
    }
    console.log('');

    // 3. Получаем кастомные поля для контактов
    console.log('👤 КАСТОМНЫЕ ПОЛЯ КОНТАКТОВ:');
    console.log('-----------------------------------');
    const contactFields = await amoCRM.makeRequest('/api/v4/contacts/custom_fields', 'GET');
    
    if (contactFields._embedded && contactFields._embedded.custom_fields) {
      for (const field of contactFields._embedded.custom_fields) {
        console.log(`Field: "${field.name}"`);
        console.log(`  ID: ${field.id}`);
        console.log(`  Code: ${field.code || 'не задан'}`);
        console.log(`  Type: ${field.type}`);
        console.log(`  Required: ${field.is_required ? 'Да' : 'Нет'}`);
        
        // Если есть енумы (варианты значений)
        if (field.enums && field.enums.length > 0) {
          console.log(`  Варианты значений:`);
          for (const enumValue of field.enums.slice(0, 5)) { // Показываем первые 5
            console.log(`    - ${enumValue.value} (ID: ${enumValue.id})`);
          }
          if (field.enums.length > 5) {
            console.log(`    ... и еще ${field.enums.length - 5} вариантов`);
          }
        }
        console.log('');
      }
    }

    // 4. Получаем кастомные поля для сделок
    console.log('💼 КАСТОМНЫЕ ПОЛЯ СДЕЛОК:');
    console.log('-----------------------------------');
    const leadFields = await amoCRM.makeRequest('/api/v4/leads/custom_fields', 'GET');
    
    if (leadFields._embedded && leadFields._embedded.custom_fields) {
      for (const field of leadFields._embedded.custom_fields) {
        console.log(`Field: "${field.name}"`);
        console.log(`  ID: ${field.id}`);
        console.log(`  Code: ${field.code || 'не задан'}`);
        console.log(`  Type: ${field.type}`);
        console.log(`  Required: ${field.is_required ? 'Да' : 'Нет'}`);
        
        if (field.enums && field.enums.length > 0) {
          console.log(`  Варианты значений:`);
          for (const enumValue of field.enums.slice(0, 5)) {
            console.log(`    - ${enumValue.value} (ID: ${enumValue.id})`);
          }
          if (field.enums.length > 5) {
            console.log(`    ... и еще ${field.enums.length - 5} вариантов`);
          }
        }
        console.log('');
      }
    }

    // 5. Получаем кастомные поля для компаний
    console.log('🏢 КАСТОМНЫЕ ПОЛЯ КОМПАНИЙ:');
    console.log('-----------------------------------');
    const companyFields = await amoCRM.makeRequest('/api/v4/companies/custom_fields', 'GET');
    
    if (companyFields._embedded && companyFields._embedded.custom_fields) {
      for (const field of companyFields._embedded.custom_fields) {
        console.log(`Field: "${field.name}"`);
        console.log(`  ID: ${field.id}`);
        console.log(`  Code: ${field.code || 'не задан'}`);
        console.log(`  Type: ${field.type}`);
        console.log(`');
      }
    }

    // 6. Получаем каталоги (для товаров)
    console.log('📦 КАТАЛОГИ ТОВАРОВ:');
    console.log('-----------------------------------');
    try {
      const catalogs = await amoCRM.makeRequest('/api/v4/catalogs', 'GET');
      
      if (catalogs._embedded && catalogs._embedded.catalogs) {
        for (const catalog of catalogs._embedded.catalogs) {
          console.log(`Каталог: "${catalog.name}"`);
          console.log(`  ID: ${catalog.id}`);
          console.log(`  Type: ${catalog.type}`);
          console.log(`  Can add elements: ${catalog.can_add_elements ? 'Да' : 'Нет'}`);
          console.log(`  Can link multiple: ${catalog.can_link_multiple ? 'Да' : 'Нет'}`);
          console.log('');
        }
      }
    } catch (error) {
      console.log('Каталоги не найдены или недоступны');
    }

    // 7. Рекомендации по настройке
    console.log('\n=========================================');
    console.log('📝 РЕКОМЕНДАЦИИ ДЛЯ НАСТРОЙКИ .env:');
    console.log('=========================================\n');
    
    console.log('1. Выберите воронку из списка выше и укажите её ID:');
    console.log('   AMO_PIPELINE_ID=XXXXXX\n');
    
    console.log('2. Выберите начальный статус из этой воронки:');
    console.log('   AMO_STATUS_ID=XXXXXX\n');
    
    console.log('3. Если нужно сохранять адрес доставки, создайте текстовое поле');
    console.log('   в сделках и запишите его ID или CODE:');
    console.log('   AMO_DELIVERY_ADDRESS_FIELD_ID=XXXXXX\n');
    
    console.log('4. Для BIN/IIN создайте поле в компаниях и укажите:');
    console.log('   AMO_COMPANY_BIN_FIELD_ID=XXXXXX\n');
    
    console.log('5. Если есть каталог товаров, укажите его ID:');
    console.log('   AMO_CATALOG_ID=XXXXXX\n');

  } catch (error) {
    console.error('\n❌ Ошибка при получении данных:', error.message);
    
    if (error.response) {
      console.error('Статус:', error.response.status);
      console.error('Ответ:', error.response.data);
    }
    
    console.log('\nВозможные причины:');
    console.log('1. Неверные токены в .env');
    console.log('2. Токены истекли - нужно обновить');
    console.log('3. Неверный AMO_BASE_URL');
    console.log('4. Недостаточно прав у интеграции');
    
    process.exit(1);
  }
}

// Запуск
getAmoCRMInfo().then(() => {
  console.log('\n✅ Готово!');
  process.exit(0);
}).catch(error => {
  logger.error({ error: error.message }, 'Failed to get amoCRM info');
  process.exit(1);
});