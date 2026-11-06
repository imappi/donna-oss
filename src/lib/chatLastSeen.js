// Per-(client, transaction) "last time the firm opened this chat"
// state for the bank-feed unread badge. localStorage-only — single
// user × single browser today; cross-device sync is explicitly out
// of scope for v1.
//
// Storage shape (one key per client):
//   key:  'donna.txChatLastSeen.<clientId>'
//   val:  JSON { [transactionId]: ISO-8601 string }
//
// The pure logic — given a server summary + a last-seen map, compute
// the unread Set<transactionId> — is in computeUnreadTransactionIds.
// localStorage-touching functions are thin wrappers; the pure helper
// is where tests pin the behaviour.

const LOCAL_STORAGE_PREFIX = 'donna.txChatLastSeen.';

const safeLocalStorage = () => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage || null;
  } catch {
    return null;
  }
};

const storageKey = (clientId) => `${LOCAL_STORAGE_PREFIX}${clientId}`;

// Read the entire last-seen map for a client.
export const readLastSeenMap = (clientId) => {
  if (!clientId) return {};
  const storage = safeLocalStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(storageKey(clientId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

// Write the last-seen timestamp for one (client, transaction) pair.
// `iso` should be an ISO-8601 string; null/undefined clears the entry.
export const writeLastSeen = (clientId, transactionId, iso) => {
  if (!clientId || !transactionId) return;
  const storage = safeLocalStorage();
  if (!storage) return;
  const current = readLastSeenMap(clientId);
  if (iso == null) {
    delete current[transactionId];
  } else {
    current[transactionId] = iso;
  }
  try {
    storage.setItem(storageKey(clientId), JSON.stringify(current));
  } catch {
    // Quota / disabled — fail silently. The badge degrades to
    // "always unread until you open" which is non-fatal.
  }
};

// Mark a single transaction as just-seen. Shorthand for the common
// case (artifact open).
export const markTransactionChatSeen = (clientId, transactionId, iso) => {
  writeLastSeen(clientId, transactionId, iso || new Date().toISOString());
};

// Pure: given the server summary and a last-seen map, return the
// Set<transactionId> that should be badged. A row is unread iff the
// server's latest_client_reply_at is strictly newer than the
// last-seen timestamp for that transaction. Absence of a last-seen
// entry means "never opened" — any server reply badges it.
//
// Defensive parsing: malformed timestamps are treated as "no
// information" and the row defaults to not-unread (we'd rather miss
// a badge than false-positive every row when localStorage gets
// corrupted).
export const computeUnreadTransactionIds = (summary, lastSeenMap) => {
  const unread = new Set();
  if (!Array.isArray(summary)) return unread;
  const seen = lastSeenMap && typeof lastSeenMap === 'object' ? lastSeenMap : {};
  for (const entry of summary) {
    if (!entry || !entry.transaction_id) continue;
    const latest = parseTs(entry.latest_client_reply_at);
    if (latest == null) continue;
    const seenAt = parseTs(seen[entry.transaction_id]);
    if (seenAt == null || latest > seenAt) {
      unread.add(entry.transaction_id);
    }
  }
  return unread;
};

const parseTs = (value) => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};
