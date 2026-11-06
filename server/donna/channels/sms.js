import { resolveAssistantName } from '../assistantIdentity.js';

const env = (key, envObj = process.env) => String(envObj?.[key] || '').trim();

export const twilioMessagesUrl = ({ accountSid = env('TWILIO_ACCOUNT_SID') } = {}) =>
  `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;

export const isSmsConfigured = ({ envObj = process.env } = {}) => Boolean(env('TWILIO_ACCOUNT_SID', envObj) && env('TWILIO_AUTH_TOKEN', envObj) && env('TWILIO_SMS_NUMBER', envObj));

export const smsEnvAllowsClient = (clientId, envObj = process.env) => {
  if (env('SMS_ENABLED', envObj).toLowerCase() !== 'true') return false;
  const allow = env('SMS_CLIENTS', envObj).split(',').map((value) => value.trim()).filter(Boolean);
  return allow.length > 0 && allow.includes(String(clientId || '').trim());
};

// D-PA-3 (design-donna-personal-agent.md §5): SMS bodies are rendered
// code-side (unlike WhatsApp's Meta-registered templates), so the
// assistant's per-client display name interpolates directly. Callers
// without a client profile in hand omit assistantName → 'Donna'.
export const renderSmsTemplate = ({ templateName, bodyParameters = [], assistantName = null } = {}) => {
  const name = resolveAssistantName({ assistant_name: assistantName });
  if (templateName === 'donna_evidence_ask_v1') {
    const [period = 'this period', question = 'one thing', askRef = 'ASK'] = bodyParameters;
    return `${name} needs one thing for ${period}: ${question} — reply with a photo, answer in words, or reply 'not sure'. Ref: ${askRef}`;
  }
  if (templateName === 'donna_close_queue_v1') {
    const [period = 'this period', openItems = '0', missingReceipts = '0'] = bodyParameters;
    return `${name} is almost ready to close ${period}. Open: ${openItems} questions, ${missingReceipts} missing receipts. Reply 'show' to go through them one by one.`;
  }
  if (templateName === 'donna_decision_check_v1') {
    const [transactionShort = 'this transaction', category = 'the selected category', askRef = 'ASK'] = bodyParameters;
    return `${name} treated ${transactionShort} as ${category} based on your past rules. Reply 'correct' or 'wrong'. Ref: ${askRef}`;
  }
  return String(bodyParameters[0] || '');
};

export const sendSmsText = async ({ to, text, deps = {} } = {}) => {
  const fetchImpl = deps.fetchImpl || fetch;
  const accountSid = deps.accountSid ?? env('TWILIO_ACCOUNT_SID');
  const authToken = deps.authToken ?? env('TWILIO_AUTH_TOKEN');
  const from = deps.from ?? env('TWILIO_SMS_NUMBER');
  if (!accountSid || !authToken || !from) return { ok: false, skipped: true, reason: 'SMS_NOT_CONFIGURED' };
  if (!to || !text) return { ok: false, error: 'sendSmsText requires `to` and `text`.' };
  const params = new URLSearchParams();
  params.set('To', to);
  params.set('From', from);
  params.set('Body', text);
  if (deps.statusCallback) params.set('StatusCallback', deps.statusCallback);
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  try {
    const response = await fetchImpl(twilioMessagesUrl({ accountSid }), { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, status: response.status, error: body?.message || `Twilio returned ${response.status}.`, body };
    return { ok: true, id: body.sid || body.message_sid || null, body };
  } catch (error) {
    return { ok: false, error: error?.message || 'Twilio request failed.' };
  }
};

export const sendSmsTemplate = ({ to, templateName, bodyParameters = [], metadata = {}, assistantName = null, deps = {} } = {}) =>
  sendSmsText({ to, text: renderSmsTemplate({ templateName, bodyParameters, metadata, assistantName }), deps });
