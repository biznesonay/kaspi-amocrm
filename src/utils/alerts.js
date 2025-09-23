import axios from 'axios';
import nodemailer from 'nodemailer';
import config from '../config/env.js';
import logger from './logger.js';
import repository from '../db/repository.js';

class AlertService {
  constructor() {
    this.lastAlertTime = {};
    this.alertCooldown = 300000; // 5 минут между одинаковыми алертами
    
    // Настраиваем email транспорт если есть конфиг
    if (config.ALERT_EMAIL_SMTP_HOST) {
      this.emailTransporter = nodemailer.createTransport({
        host: config.ALERT_EMAIL_SMTP_HOST,
        port: config.ALERT_EMAIL_SMTP_PORT || 587,
        secure: config.ALERT_EMAIL_SMTP_PORT === 465,
        auth: {
          user: config.ALERT_EMAIL_SMTP_USER,
          pass: config.ALERT_EMAIL_SMTP_PASS
        }
      });
    }
  }
  
  /**
   * Проверяет, нужно ли отправить алерт (с учетом cooldown)
   */
  shouldSendAlert(alertKey) {
    const now = Date.now();
    const lastTime = this.lastAlertTime[alertKey] || 0;
    
    if (now - lastTime < this.alertCooldown) {
      return false;
    }
    
    this.lastAlertTime[alertKey] = now;
    return true;
  }
  
  /**
   * Отправляет критический алерт
   */
  async sendCriticalAlert(title, message, details = {}) {
    if (!this.shouldSendAlert(`critical:${title}`)) {
      logger.debug({ title }, 'Алерт пропущен из-за cooldown');
      return;
    }
    
    logger.error({ title, message, details }, '🚨 КРИТИЧЕСКИЙ АЛЕРТ');
    
    // Сохраняем в БД
    await repository.logError('CRITICAL_ALERT', `${title}: ${message}`, details);
    
    // Отправляем через доступные каналы
    const promises = [];
    
    if (config.ALERT_TELEGRAM_BOT_TOKEN && config.ALERT_TELEGRAM_CHAT_ID) {
      promises.push(this.sendTelegramAlert('🚨 КРИТИЧНО', title, message, details));
    }
    
    if (this.emailTransporter && config.ALERT_EMAIL_TO) {
      promises.push(this.sendEmailAlert('CRITICAL', title, message, details));
    }
    
    await Promise.allSettled(promises);
  }
  
  /**
   * Отправляет предупреждение
   */
  async sendWarningAlert(title, message, details = {}) {
    if (!this.shouldSendAlert(`warning:${title}`)) {
      logger.debug({ title }, 'Алерт пропущен из-за cooldown');
      return;
    }
    
    logger.warn({ title, message, details }, '⚠️ ПРЕДУПРЕЖДЕНИЕ');
    
    // Сохраняем в БД
    await repository.logError('WARNING_ALERT', `${title}: ${message}`, details);
    
    // Отправляем через доступные каналы
    const promises = [];
    
    if (config.ALERT_TELEGRAM_BOT_TOKEN && config.ALERT_TELEGRAM_CHAT_ID) {
      promises.push(this.sendTelegramAlert('⚠️ Предупреждение', title, message, details));
    }
    
    if (this.emailTransporter && config.ALERT_EMAIL_TO) {
      promises.push(this.sendEmailAlert('WARNING', title, message, details));
    }
    
    await Promise.allSettled(promises);
  }
  
  /**
   * Отправляет информационный алерт
   */
  async sendInfoAlert(title, message, details = {}) {
    logger.info({ title, message, details }, 'ℹ️ ИНФОРМАЦИЯ');
    
    // Только логируем, не отправляем
    await repository.logError('INFO_ALERT', `${title}: ${message}`, details);
  }
  
  /**
   * Отправляет алерт в Telegram
   */
  async sendTelegramAlert(level, title, message, details) {
    try {
      const text = this.formatTelegramMessage(level, title, message, details);
      
      await axios.post(
        `https://api.telegram.org/bot${config.ALERT_TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          chat_id: config.ALERT_TELEGRAM_CHAT_ID,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        },
        { timeout: 5000 }
      );
      
      logger.debug('Telegram алерт отправлен');
    } catch (error) {
      logger.error({ error: error.message }, 'Ошибка отправки Telegram алерта');
    }
  }
  
  /**
   * Отправляет алерт по email
   */
  async sendEmailAlert(level, title, message, details) {
    try {
      const html = this.formatEmailMessage(level, title, message, details);
      
      await this.emailTransporter.sendMail({
        from: config.ALERT_EMAIL_FROM || 'noreply@kaspi-amo.kz',
        to: config.ALERT_EMAIL_TO,
        subject: `[${level}] Kaspi-amoCRM: ${title}`,
        html
      });
      
      logger.debug('Email алерт отправлен');
    } catch (error) {
      logger.error({ error: error.message }, 'Ошибка отправки Email алерта');
    }
  }
  
  /**
   * Форматирует сообщение для Telegram
   */
  formatTelegramMessage(level, title, message, details) {
    const escapedLevel = this.escapeHtml(level);
    const escapedTitle = this.escapeHtml(title);
    const escapedMessage = this.escapeHtml(message);

    let text = `<b>${escapedLevel}</b>\n\n`;
    text += `<b>${escapedTitle}</b>\n`;
    text += `${escapedMessage}\n`;

    if (details && Object.keys(details).length > 0) {
      text += '\n<b>Детали:</b>\n';
      for (const [key, value] of Object.entries(details)) {
        // Маскируем чувствительные данные
        const escapedKey = this.escapeHtml(key);
        const maskedValue = this.escapeHtml(this.maskSensitiveData(key, value));
        text += `• ${escapedKey}: <code>${maskedValue}</code>\n`;
      }
    }
    
    text += `\n⏰ ${new Date().toLocaleString('ru-RU', { timeZone: config.TIMEZONE })}`;
    
    return text;
  }
  
  /**
   * Форматирует сообщение для Email
   */
  formatEmailMessage(level, title, message, details) {
    const escapedLevel = this.escapeHtml(level);
    const escapedTitle = this.escapeHtml(title);
    const escapedMessage = this.escapeHtml(message);

    let html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px;">
        <div style="background-color: ${level === 'CRITICAL' ? '#dc3545' : '#ffc107'};
                    color: white; padding: 10px; border-radius: 5px 5px 0 0;">
          <h2 style="margin: 0;">${escapedLevel}: ${escapedTitle}</h2>
        </div>
        <div style="border: 1px solid #ddd; padding: 20px; border-radius: 0 0 5px 5px;">
          <p style="font-size: 16px;">${escapedMessage}</p>
    `;

    if (details && Object.keys(details).length > 0) {
      html += '<h3>Детали:</h3><ul>';
      for (const [key, value] of Object.entries(details)) {
        const escapedKey = this.escapeHtml(key);
        const maskedValue = this.escapeHtml(this.maskSensitiveData(key, value));
        html += `<li><strong>${escapedKey}:</strong> ${maskedValue}</li>`;
      }
      html += '</ul>';
    }
    
    html += `
          <hr style="margin: 20px 0;">
          <p style="color: #666; font-size: 12px;">
            Время: ${new Date().toLocaleString('ru-RU', { timeZone: config.TIMEZONE })}<br>
            Сервер: Kaspi-amoCRM Integrator
          </p>
        </div>
      </div>
    `;
    
    return html;
  }
  
  /**
   * Маскирует чувствительные данные
   */
  maskSensitiveData(key, value) {
    if (typeof value !== 'string') {
      return String(value);
    }

    const lowerKey = key.toLowerCase();
    
    if (lowerKey.includes('token') || lowerKey.includes('secret')) {
      return value.substring(0, 6) + '***';
    }
    
    if (lowerKey.includes('phone')) {
      return value.replace(/(\d{3})\d{3,}(\d{2})/, '$1***$2');
    }
    
    if (lowerKey.includes('email')) {
      const [local, domain] = value.split('@');
      if (domain) {
        return local.substring(0, 2) + '***@' + domain;
      }
    }

    return value;
  }

  /**
   * Экранирует HTML-спецсимволы
   */
  escapeHtml(value) {
    if (value === null || value === undefined) {
      return '';
    }

    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  
  /**
   * Проверяет пороги и отправляет алерты
   */
  async checkThresholds() {
    try {
      // Проверяем heartbeat
      const heartbeat = await repository.getMeta('heartbeat_utc');
      if (heartbeat) {
        const lastHeartbeat = new Date(heartbeat);
        const minutesSinceHeartbeat = (Date.now() - lastHeartbeat.getTime()) / 60000;
        
        if (minutesSinceHeartbeat > config.ALERT_HEARTBEAT_MINUTES) {
          await this.sendCriticalAlert(
            'Heartbeat истек',
            `Последняя активность была ${Math.round(minutesSinceHeartbeat)} минут назад`,
            { lastHeartbeat: heartbeat, threshold: config.ALERT_HEARTBEAT_MINUTES }
          );
        }
      }
      
      // Проверяем количество ошибок подряд
      const failures = parseInt(await repository.getMeta('consecutive_failures') || '0');
      if (failures >= config.ALERT_FAIL_STREAK) {
        await this.sendCriticalAlert(
          'Множественные ошибки',
          `${failures} ошибок подряд при обработке заказов`,
          { consecutiveFailures: failures, threshold: config.ALERT_FAIL_STREAK }
        );
      }
      
    } catch (error) {
      logger.error({ error: error.message }, 'Ошибка при проверке порогов алертов');
    }
  }
}

// Создаем синглтон
const alertService = new AlertService();
export default alertService;