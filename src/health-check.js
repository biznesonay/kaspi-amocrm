/**
 * Health Check HTTP endpoint
 * Простой сервер для мониторинга состояния интеграции
 * Запуск: node src/health-check.js
 * Endpoint: GET /health (с Basic Auth)
 */

import http from 'http';
import { URL } from 'url';
import { config } from './config/env.js';
import { db } from './config/database.js';
import { repository } from './db/repository.js';
import { logger } from './utils/logger.js';

const PORT = process.env.HEALTH_CHECK_PORT || 3000;
const BASIC_USER = process.env.ADMIN_BASIC_USER || 'admin';
const BASIC_PASS = process.env.ADMIN_BASIC_PASS || 'change_me';

/**
 * Проверка Basic Auth
 */
function checkAuth(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return false;
  }

  const credentials = Buffer.from(authHeader.slice(6), 'base64').toString();
  const [user, pass] = credentials.split(':');
  
  return user === BASIC_USER && pass === BASIC_PASS;
}

/**
 * Получение статуса системы
 */
async function getHealthStatus() {
  const status = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    timezone: config.app.timezone,
    checks: {
      database: false,
      heartbeat: false,
      lastPoll: null,
      lastReconcile: null,
      consecutiveFailures: 0,
      todayStats: null
    },
    warnings: [],
    errors: []
  };

  try {
    // Проверка подключения к БД
    const testQuery = await repository.getMeta('heartbeat_utc');
    status.checks.database = true;

    // Проверка heartbeat
    const heartbeatUtc = await repository.getMeta('heartbeat_utc');
    if (heartbeatUtc) {
      const heartbeatAge = Date.now() - new Date(heartbeatUtc).getTime();
      const ageMinutes = Math.floor(heartbeatAge / 60000);
      
      status.checks.lastPoll = {
        timestamp: heartbeatUtc,
        ageMinutes
      };

      if (ageMinutes > config.alerts.heartbeatMinutes) {
        status.status = 'warning';
        status.warnings.push(`Last poll was ${ageMinutes} minutes ago (threshold: ${config.alerts.heartbeatMinutes})`);
      } else {
        status.checks.heartbeat = true;
      }
    }

    // Проверка последней сверки
    const reconcileWatermark = await repository.getMeta('reconcile_watermark_utc');
    if (reconcileWatermark) {
      const reconcileAge = Date.now() - new Date(reconcileWatermark).getTime();
      const ageMinutes = Math.floor(reconcileAge / 60000);
      
      status.checks.lastReconcile = {
        timestamp: reconcileWatermark,
        ageMinutes
      };

      if (ageMinutes > 20) { // Сверка должна быть каждые 10 минут, даем запас
        status.warnings.push(`Last reconcile watermark is ${ageMinutes} minutes old`);
      }
    }

    // Проверка consecutive failures
    const failures = await repository.getMeta('consecutive_failures');
    status.checks.consecutiveFailures = parseInt(failures || '0');
    
    if (status.checks.consecutiveFailures >= config.alerts.failStreak) {
      status.status = 'error';
      status.errors.push(`Too many consecutive failures: ${status.checks.consecutiveFailures}`);
    }

    // Получение статистики за сегодня
    const today = new Date().toISOString().split('T')[0];
    const todayStats = await repository.getDailyStats(today);
    
    if (todayStats) {
      status.checks.todayStats = {
        orders_processed: todayStats.orders_processed,
        orders_failed: todayStats.orders_failed,
        leads_created: todayStats.leads_created,
        api_errors: todayStats.api_errors_kaspi + todayStats.api_errors_amocrm,
        rate_limit_hits: todayStats.rate_limit_hits
      };

      // Предупреждения по статистике
      if (todayStats.orders_failed > todayStats.orders_processed * 0.1) {
        status.warnings.push(`High failure rate: ${todayStats.orders_failed}/${todayStats.orders_processed}`);
      }
      
      if (todayStats.rate_limit_hits > 10) {
        status.warnings.push(`High rate limit hits: ${todayStats.rate_limit_hits}`);
      }
    }

    // Проверка последних ошибок
    const recentErrors = await repository.getRecentErrors(5);
    if (recentErrors && recentErrors.length > 0) {
      status.checks.recentErrors = recentErrors.map(err => ({
        type: err.error_type,
        message: err.error_message,
        order_code: err.order_code ? '***' + err.order_code.slice(-4) : null,
        timestamp: err.created_at_utc
      }));
    }

    // Итоговый статус
    if (status.errors.length > 0) {
      status.status = 'error';
    } else if (status.warnings.length > 0) {
      status.status = 'warning';
    }

  } catch (error) {
    logger.error({ error: error.message }, 'Health check failed');
    status.status = 'error';
    status.errors.push(`Database check failed: ${error.message}`);
    status.checks.database = false;
  }

  return status;
}

/**
 * HTTP сервер
 */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  
  // CORS для мониторинга
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  
  // Обработка preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Только GET запросы
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  // Проверка пути
  if (url.pathname !== '/health') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // Проверка авторизации
  if (!checkAuth(req)) {
    res.writeHead(401, { 
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Basic realm="Health Check"'
    });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  try {
    const status = await getHealthStatus();
    
    // HTTP код в зависимости от статуса
    let httpCode = 200;
    if (status.status === 'error') httpCode = 503;
    else if (status.status === 'warning') httpCode = 200; // Warnings не блокируют
    
    res.writeHead(httpCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status, null, 2));
    
    logger.info({ 
      status: status.status, 
      warnings: status.warnings.length,
      errors: status.errors.length 
    }, 'Health check performed');
    
  } catch (error) {
    logger.error({ error: error.message }, 'Health check error');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'error', 
      error: 'Internal server error',
      timestamp: new Date().toISOString()
    }));
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, closing health check server');
  server.close(() => {
    db.destroy(() => {
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, closing health check server');
  server.close(() => {
    db.destroy(() => {
      process.exit(0);
    });
  });
});

// Запуск сервера
server.listen(PORT, () => {
  logger.info({ port: PORT }, 'Health check server started');
  console.log(`Health check available at http://localhost:${PORT}/health`);
  console.log(`Use Basic Auth: ${BASIC_USER}:${BASIC_PASS}`);
});