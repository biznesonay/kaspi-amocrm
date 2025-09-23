/**
 * Helper для получения первых OAuth токенов amoCRM
 * Запуск: node src/helpers/setup-amocrm-oauth.js
 */

import axios from 'axios';
import readline from 'readline';
import { config } from '../config/env.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

console.log('🔐 Настройка OAuth для amoCRM\n');
console.log('=========================================\n');

async function setupOAuth() {
  try {
    // Проверяем наличие базовых настроек
    if (!config.amocrm.baseUrl) {
      console.log('❌ AMO_BASE_URL не задан в .env');
      console.log('Пример: https://your-subdomain.amocrm.ru');
      process.exit(1);
    }
    
    if (!config.amocrm.clientId || !config.amocrm.clientSecret) {
      console.log('❌ AMO_CLIENT_ID или AMO_CLIENT_SECRET не заданы в .env');
      console.log('\nДля получения:');
      console.log('1. Войдите в amoCRM');
      console.log('2. Перейдите в Настройки → Интеграции');
      console.log('3. Создайте новую интеграцию');
      console.log('4. Скопируйте ID и Secret');
      process.exit(1);
    }
    
    console.log('Текущие настройки:');
    console.log('Base URL:', config.amocrm.baseUrl);
    console.log('Client ID:', config.amocrm.clientId);
    console.log('Redirect URI:', config.amocrm.redirectUri || 'не задан');
    console.log('');
    
    // Выбор метода получения токенов
    console.log('Выберите способ получения токенов:\n');
    console.log('1. У меня есть код авторизации (authorization code)');
    console.log('2. У меня есть refresh token от предыдущей интеграции');
    console.log('3. Показать инструкцию для получения кода авторизации');
    console.log('');
    
    const choice = await question('Ваш выбор (1-3): ');
    console.log('');
    
    if (choice === '1') {
      // Обмен кода авторизации на токены
      const code = await question('Введите код авторизации: ');
      
      console.log('\n📡 Обмен кода на токены...');
      
      const response = await axios.post(
        `${config.amocrm.baseUrl}/oauth2/access_token`,
        {
          client_id: config.amocrm.clientId,
          client_secret: config.amocrm.clientSecret,
          grant_type: 'authorization_code',
          code: code.trim(),
          redirect_uri: config.amocrm.redirectUri
        },
        {
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log('\n✅ Токены успешно получены!\n');
      console.log('Добавьте в .env:');
      console.log('=========================================');
      console.log(`AMO_ACCESS_TOKEN=${response.data.access_token}`);
      console.log(`AMO_REFRESH_TOKEN=${response.data.refresh_token}`);
      console.log('=========================================\n');
      
      console.log('Дополнительная информация:');
      console.log('Token type:', response.data.token_type);
      console.log('Expires in:', response.data.expires_in, 'секунд');
      
    } else if (choice === '2') {
      // Обновление токенов через refresh token
      const refreshToken = await question('Введите refresh token: ');
      
      console.log('\n📡 Обновление токенов...');
      
      const response = await axios.post(
        `${config.amocrm.baseUrl}/oauth2/access_token`,
        {
          client_id: config.amocrm.clientId,
          client_secret: config.amocrm.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken.trim(),
          redirect_uri: config.amocrm.redirectUri
        },
        {
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log('\n✅ Токены успешно обновлены!\n');
      console.log('Добавьте в .env:');
      console.log('=========================================');
      console.log(`AMO_ACCESS_TOKEN=${response.data.access_token}`);
      console.log(`AMO_REFRESH_TOKEN=${response.data.refresh_token}`);
      console.log('=========================================\n');
      
    } else if (choice === '3') {
      // Показываем инструкцию
      console.log('📚 Инструкция для получения кода авторизации:\n');
      console.log('1. Создайте интеграцию в amoCRM:');
      console.log('   - Войдите в amoCRM');
      console.log('   - Настройки → Интеграции → Создать интеграцию');
      console.log('   - Тип: Внешняя интеграция');
      console.log('   - Укажите Redirect URI (например: https://yourdomain.com/callback)');
      console.log('   - Сохраните Client ID и Secret в .env\n');
      
      console.log('2. Получите код авторизации:');
      console.log('   Откройте в браузере следующую ссылку:\n');
      
      const authUrl = `${config.amocrm.baseUrl}/oauth?` + 
        `client_id=${config.amocrm.clientId}&` +
        `state=test&` +
        `mode=post_message`;
      
      console.log(`   ${authUrl}\n`);
      
      console.log('3. После авторизации:');
      console.log('   - Вы будете перенаправлены на Redirect URI');
      console.log('   - В URL будет параметр ?code=...');
      console.log('   - Скопируйте значение code');
      console.log('   - Запустите этот скрипт снова и выберите пункт 1\n');
      
      console.log('⚠️ ВАЖНО:');
      console.log('   - Код действителен только 20 минут');
      console.log('   - Код можно использовать только один раз');
      console.log('   - Redirect URI в ссылке должен точно совпадать с указанным при создании интеграции');
      
    } else {
      console.log('Неверный выбор');
    }
    
  } catch (error) {
    console.error('\n❌ Ошибка:', error.message);
    
    if (error.response) {
      console.error('Статус:', error.response.status);
      console.error('Ответ:', JSON.stringify(error.response.data, null, 2));
      
      if (error.response.status === 400) {
        console.log('\nВозможные причины:');
        console.log('- Неверный или истекший код авторизации');
        console.log('- Неверный refresh token');
        console.log('- Несовпадение redirect_uri');
        console.log('- Код уже был использован');
      } else if (error.response.status === 401) {
        console.log('\nНеверные Client ID или Secret');
      }
    }
  } finally {
    rl.close();
  }
}

// Запуск
setupOAuth().then(() => {
  process.exit(0);
}).catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});