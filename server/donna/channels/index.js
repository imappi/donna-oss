import { sendEmail } from '../email/resendClient.js';
import { sendWhatsAppTemplate } from './whatsapp.js';
import { sendSmsTemplate } from './sms.js';
import { sendTelegramTemplate } from './telegram.js';

export const OWNER_CHANNELS = Object.freeze({ WHATSAPP: 'whatsapp', SMS: 'sms', TELEGRAM: 'telegram', EMAIL: 'email' });

export const deliverOwnerMessage = async ({ channel, recipient, template, email, deps = {} } = {}) => {
  if (channel === OWNER_CHANNELS.WHATSAPP) {
    return sendWhatsAppTemplate({
      to: recipient?.phone_e164 || recipient?.phone || recipient,
      templateName: template?.name,
      languageCode: template?.languageCode || 'en',
      bodyParameters: template?.bodyParameters || [],
      metadata: template?.metadata || {},
      deps: deps.whatsapp || deps
    });
  }
  if (channel === OWNER_CHANNELS.SMS) {
    return sendSmsTemplate({
      to: recipient?.phone_e164 || recipient?.phone || recipient,
      templateName: template?.name,
      bodyParameters: template?.bodyParameters || [],
      metadata: template?.metadata || {},
      // D-PA-3: per-client assistant display name; SMS renders code-side.
      // (WhatsApp templates are Meta-registered — name changes there ride
      // template re-registration, not this path.)
      assistantName: template?.assistantName || null,
      deps: deps.sms || deps
    });
  }
  if (channel === OWNER_CHANNELS.TELEGRAM) {
    return sendTelegramTemplate({
      // recipient.phone_e164 carries the Telegram chat_id (the binding slot it
      // is stored in); Telegram renders code-side, so the assistant display
      // name interpolates here just like SMS. No Meta template involved.
      to: recipient?.phone_e164 || recipient?.chat_id || recipient?.phone || recipient,
      templateName: template?.name,
      bodyParameters: template?.bodyParameters || [],
      assistantName: template?.assistantName || null,
      deps: deps.telegram || deps
    });
  }
  if (channel === OWNER_CHANNELS.EMAIL) {
    return sendEmail({ ...(email || {}), to: recipient?.email || recipient, deps: deps.email || deps });
  }
  return { ok: false, error: `Unsupported owner message channel: ${channel || 'unknown'}.` };
};
