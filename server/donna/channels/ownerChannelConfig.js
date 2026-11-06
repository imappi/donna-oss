import { clientFlagActs } from '../clientConfig.js';

export const OWNER_CHANNEL_FLAG_KEYS = Object.freeze({
  whatsapp: 'OWNER_CHANNEL_WHATSAPP',
  telegram: 'OWNER_CHANNEL_TELEGRAM',
  sms: 'OWNER_CHANNEL_SMS'
});

const nullSnapshot = async () => null;
const freezeSnapshot = (snapshot) => Object.freeze(Object.fromEntries(
  Object.entries(snapshot).map(([key, row]) => [key, row && typeof row === 'object' ? Object.freeze({ ...row }) : row])
));

export const prefetchOwnerChannelGateContext = async ({ bindings = [], firmId, loadSnapshot = nullSnapshot } = {}) => {
  const clientIds = [...new Set(bindings.map((binding) => String(binding?.client_id || '').trim()).filter(Boolean))];
  const entries = await Promise.all(clientIds.map(async (clientId) => {
    let snapshot = null;
    try {
      snapshot = await loadSnapshot({ firmId, clientId });
    } catch {
      snapshot = null;
    }
    return [clientId, snapshot && typeof snapshot === 'object' ? freezeSnapshot(snapshot) : null];
  }));
  return Object.freeze({ snapshotsByClient: Object.freeze(Object.fromEntries(entries)) });
};

export const ownerChannelAllowsClient = ({ channel, clientId, gateContext, envFallback, env = process.env } = {}) => {
  const normalizedClientId = String(clientId || '').trim();
  if (!normalizedClientId || !Object.prototype.hasOwnProperty.call(gateContext?.snapshotsByClient || {}, normalizedClientId)) return false;
  return clientFlagActs({
    flagKey: OWNER_CHANNEL_FLAG_KEYS[channel],
    snapshot: gateContext.snapshotsByClient[normalizedClientId],
    envFallback: () => envFallback(normalizedClientId, env),
    env
  });
};
