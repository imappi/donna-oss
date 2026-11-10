import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { OWNER_REPLY_WORD_END, OWNER_REPLY_WORD_START } from './ownerReplyText.js';

const env = (key, envObj = process.env) => String(envObj?.[key] || '').trim();

export const whatsappJson = (res, statusCode, payload) => {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
};

export const hashWhatsAppToken = (token, { secret = env('WHATSAPP_APP_SECRET') } = {}) =>
  createHmac('sha256', String(secret || '')).update(String(token || '')).digest('hex');

export const verifyMetaWebhookSignature = ({ rawBody = '', signature = '', secret = env('WHATSAPP_APP_SECRET') } = {}) => {
  if (!secret || !signature || !String(signature).startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(String(rawBody || '')).digest('hex')}`;
  const expectedBuffer = Buffer.from(expected);
  const submittedBuffer = Buffer.from(String(signature));
  return expectedBuffer.length === submittedBuffer.length && timingSafeEqual(expectedBuffer, submittedBuffer);
};

export const extractBindingToken = (text) => {
  const match = String(text || '').match(/(?:connect|token)\s+([A-Za-z0-9_-]{24,})/i);
  return match?.[1] || '';
};

// "Ref" is a whole word under the owner-reply letter rule (ownerReplyText.js):
// ä and ö are letters, which JavaScript's \b does not know.
const ASK_REF_PATTERN = new RegExp(`${OWNER_REPLY_WORD_START}ref\\s*[:#-]?\\s*([A-Za-z0-9][A-Za-z0-9_-]{1,24})${OWNER_REPLY_WORD_END}`, 'iu');
export const extractAskRef = (text) => {
  const match = String(text || '').match(ASK_REF_PATTERN);
  return match?.[1]?.replace(/[^a-zA-Z0-9]/g, '').toUpperCase() || '';
};

export const normalizePhoneE164 = (value) => String(value || '').trim().replace(/[\s().-]/g, '');

export const phoneHashSalt = (envObj = process.env) => env('WHATSAPP_PHONE_HASH_SALT', envObj) || env('WHATSAPP_APP_SECRET', envObj);

export const hashPhoneE164 = (phoneE164, { salt = phoneHashSalt() } = {}) =>
  createHash('sha256').update(`${String(salt || '')}:${normalizePhoneE164(phoneE164)}`).digest('hex');

export const whatsappBindingId = ({ firmId, clientId, collaboratorId, phoneHash }) =>
  `wab_${firmId}_${clientId}_${collaboratorId || 'owner'}_${String(phoneHash || '').slice(0, 16)}`.replace(/[^a-zA-Z0-9_:-]/g, '_');

export const whatsappEnvAllowsClient = (clientId, envObj = process.env) => {
  if (env('WHATSAPP_ENABLED', envObj).toLowerCase() !== 'true') return false;
  const allow = env('WHATSAPP_CLIENTS', envObj).split(',').map((v) => v.trim()).filter(Boolean);
  return allow.length > 0 && allow.includes(String(clientId || '').trim());
};

export const shortAskRef = (id) => String(id || '').replace(/[^a-zA-Z0-9]/g, '').slice(-8).toUpperCase() || 'ASK';
