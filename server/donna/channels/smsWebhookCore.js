import { createHmac, timingSafeEqual } from 'node:crypto';

const env = (key, envObj = process.env) => String(envObj?.[key] || '').trim();

export const smsJson = (res, statusCode, payload) => {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
};

export const parseTwilioForm = (rawBody = '') => Object.fromEntries(new URLSearchParams(String(rawBody || '')));

export const verifyTwilioWebhookSignature = ({ url = '', params = {}, signature = '', authToken = env('TWILIO_AUTH_TOKEN') } = {}) => {
  if (!url || !authToken || !signature) return false;
  const data = `${url}${Object.keys(params || {}).sort().map((key) => `${key}${params[key] ?? ''}`).join('')}`;
  const expected = createHmac('sha1', authToken).update(data).digest('base64');
  const expectedBuffer = Buffer.from(expected);
  const submittedBuffer = Buffer.from(String(signature));
  return expectedBuffer.length === submittedBuffer.length && timingSafeEqual(expectedBuffer, submittedBuffer);
};

export const twilioRequestUrl = (req, requestUrl, envObj = process.env) => {
  const explicit = env('TWILIO_WEBHOOK_PUBLIC_BASE_URL', envObj) || env('DONNA_PUBLIC_BASE_URL', envObj) || env('VERCEL_URL', envObj);
  if (explicit) return `${explicit.startsWith('http') ? explicit : `https://${explicit}`}${requestUrl.pathname}${requestUrl.search}`;
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim() || 'https';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  return `${proto}://${host}${requestUrl.pathname}${requestUrl.search}`;
};
