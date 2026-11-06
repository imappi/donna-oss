const env = (key) => String(process.env[key] || '').trim();

export const WHATSAPP_GRAPH_VERSION = 'v20.0';
export const whatsappMessagesUrl = ({ phoneNumberId = env('WHATSAPP_PHONE_NUMBER_ID'), graphVersion = WHATSAPP_GRAPH_VERSION } = {}) =>
  `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(phoneNumberId)}/messages`;

export const isWhatsAppConfigured = ({ envObj = process.env } = {}) => Boolean(
  String(envObj.WHATSAPP_ACCESS_TOKEN || '').trim() && String(envObj.WHATSAPP_PHONE_NUMBER_ID || '').trim()
);

export const sendWhatsAppTemplate = async ({
  to,
  templateName,
  languageCode = 'en',
  bodyParameters = [],
  metadata = {},
  deps = {}
} = {}) => {
  const fetchImpl = deps.fetchImpl || fetch;
  const accessToken = deps.accessToken ?? env('WHATSAPP_ACCESS_TOKEN');
  const phoneNumberId = deps.phoneNumberId ?? env('WHATSAPP_PHONE_NUMBER_ID');
  if (!accessToken || !phoneNumberId) return { ok: false, skipped: true, reason: 'WHATSAPP_NOT_CONFIGURED' };
  if (!to || !templateName) return { ok: false, error: 'sendWhatsAppTemplate requires `to` and `templateName`.' };
  const components = bodyParameters.length ? [{
    type: 'body',
    parameters: bodyParameters.map((value) => ({ type: 'text', text: String(value ?? '') }))
  }] : [];
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: { name: templateName, language: { code: languageCode }, ...(components.length ? { components } : {}) },
    ...(Object.keys(metadata || {}).length ? { biz_opaque_callback_data: JSON.stringify(metadata).slice(0, 512) } : {})
  };
  try {
    const response = await fetchImpl(whatsappMessagesUrl({ phoneNumberId }), {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, status: response.status, error: body?.error?.message || `WhatsApp returned ${response.status}.`, body };
    return { ok: true, id: body?.messages?.[0]?.id || null, body };
  } catch (error) {
    return { ok: false, error: error?.message || 'WhatsApp request failed.' };
  }
};

export const sendWhatsAppText = async ({ to, text, deps = {} } = {}) => {
  const fetchImpl = deps.fetchImpl || fetch;
  const accessToken = deps.accessToken ?? env('WHATSAPP_ACCESS_TOKEN');
  const phoneNumberId = deps.phoneNumberId ?? env('WHATSAPP_PHONE_NUMBER_ID');
  if (!accessToken || !phoneNumberId) return { ok: false, skipped: true, reason: 'WHATSAPP_NOT_CONFIGURED' };
  if (!to || !text) return { ok: false, error: 'sendWhatsAppText requires `to` and `text`.' };
  try {
    const response = await fetchImpl(whatsappMessagesUrl({ phoneNumberId }), {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: text } })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, status: response.status, error: body?.error?.message || `WhatsApp returned ${response.status}.`, body };
    return { ok: true, id: body?.messages?.[0]?.id || null, body };
  } catch (error) {
    return { ok: false, error: error?.message || 'WhatsApp request failed.' };
  }
};
