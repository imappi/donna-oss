// The post-parse follow-up for an owner-initiated receipt photo (Telegram).
//
// Why this exists: the upload ack ("Got it. Reading it now.") ends the chat
// interaction, and until 2026-07-21 NOTHING came after it — the owner could
// not tell from the chat whether the photo actually parsed (Kari: "otherwise
// you don't really know whether the doc got parsed or not"). This module sends
// the consequence line once the async parse lands.
//
// Discipline (same shape as evidenceReplyConfirm.js — a proactive outbound
// surface, the most dangerous kind):
//   - BORN DARK on the config control plane: clientFlagActs with
//     envFallback:()=>false. Off for every client until a canary row is staged.
//   - Defense-in-depth master gate: telegramEnvAllowsClient, the same gate the
//     inbound hooks honour.
//   - Only to an ACTIVE Telegram binding for the document's client.
//   - HONEST: the text renders the PERSISTED parse verdict (vendor, amount,
//     date, parse_status) — never a fresh model call, never a claim the row
//     does not support (render-the-persisted-verdict rail).
//   - Exactly-once: a delivery-ledger claim keyed on the document id guards
//     against Inngest leg retries double-sending.
//   - Best-effort / no-throw: a send failure must not fail the parse leg hard;
//     every skip returns a typed reason.
//   - VOICE: no em or en dashes, short sentences, plain words (the Donna voice
//     rule, clientPortalChat.js system prompt; held for static copy too).
import { clientFlagActs, readClientConfigSnapshot } from '../clientConfig.js';
import { ownerChannelAllowsClient, prefetchOwnerChannelGateContext } from './ownerChannelConfig.js';
import {
  claimOwnerMediaGroupSendInDb,
  claimOwnerMediaSummarySendInDb,
  getActiveTelegramBindingForClientInDb,
  getClientDisplayNameInDb,
  getClientOwnerLanguageInDb,
  getOwnerMediaDocForSummaryInDb,
  listOwnerMediaDocsNeedingTerminalSummaryInDb,
  listOwnerMediaGroupDocsInDb,
  listOwnerMediaSummaryClaimedDocIdsInDb,
  withFirmDbClient
} from '../firmDb.js';
import { sendTelegramText, telegramEnvAllowsClient } from './telegram.js';

export const OWNER_MEDIA_PARSE_SUMMARY_FLAG_KEY = 'OWNER_MEDIA_PARSE_SUMMARY';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The owner's language (preferredOwnerTemplateLanguage) picks the copy, the
// date format and the decimal mark. English is the historical copy, unchanged;
// Finnish owners read 12.2.2026 and 12,50 EUR. Same voice rule in both: no em
// or en dashes.
const formatDocumentDate = (value, language = 'en') => {
  // pg returns date columns as Date objects; strings arrive from tests and
  // JSON payloads. Both normalize to ISO before slicing.
  const iso = value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : String(value || '');
  const raw = iso.slice(0, 10);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return null;
  if (language === 'fi') return `${Number(match[3])}.${Number(match[2])}.${match[1]}`;
  return `${Number(match[3])} ${month} ${match[1]}`;
};

const decimal = (value, language = 'en') => {
  const fixed = Number(value).toFixed(2);
  return language === 'fi' ? fixed.replace('.', ',') : fixed;
};

const formatAmount = (total, currency, language = 'en') => {
  const amount = Number(total);
  if (!Number.isFinite(amount) || amount === 0) return null;
  const code = String(currency || '').trim().toUpperCase();
  return code ? `${decimal(amount, language)} ${code}` : decimal(amount, language);
};

const OWNER_MEDIA_SUMMARY_COPY = Object.freeze({
  en: Object.freeze({
    forClient: (clientName) => (clientName ? ` for ${clientName}` : ''),
    heldFor: (clientName) => (clientName ? ` for ${clientName}` : ''),
    fromDate: (date) => (date ? ` from ${date}` : ''),
    failed: (filename, fromDate, forClient) => `I could not read ${filename ? `the photo ${filename}${fromDate}` : 'that photo'}. It is saved${forClient} and marked as needing another look.`,
    duplicateOf: (existingName, existingFrom, forClient) => `I already have this one on file${forClient}. It matches ${existingName}${existingFrom}. Nothing else needed.`,
    duplicate: (filename, fromDate, forClient) => `I already have ${filename ? `${filename}${fromDate}` : 'this one'} on file${forClient}. Nothing else needed.`,
    read: (parts, forClient) => `Read it: ${parts}. It is filed${forClient}.`,
    readNoFields: (forClient) => `I read the photo but could not pull a vendor or amount from it. It is saved${forClient}.`,
    oneFile: 'One file',
    groupReadNoFields: (name) => `${name}: read, but I could not pull a vendor or amount.`,
    groupDuplicateOf: (name, existingName) => `${name}: already on file, it matches ${existingName}.`,
    groupDuplicate: (name) => `${name}: already on file.`,
    groupFailed: (name) => `${name}: I could not read it. It is saved and marked as needing another look.`,
    groupAllRead: (count, clientName) => `Read ${count} documents${clientName ? ` for ${clientName}` : ''}:`,
    groupSome: (count, clientName) => `Your ${count} files${clientName ? ` for ${clientName}` : ''}:`,
    total: (totalText) => `Total ${totalText}.`,
    allFiled: 'All filed.'
  }),
  fi: Object.freeze({
    forClient: (clientName) => (clientName ? ` yrityksen ${clientName} tietoihin` : ''),
    heldFor: (clientName) => (clientName ? ` yrityksen ${clientName} tiedoissa` : ''),
    fromDate: (date) => (date ? ` (${date})` : ''),
    failed: (filename, fromDate, forClient) => `En saanut selvää ${filename ? `kuvasta ${filename}${fromDate}` : 'siitä kuvasta'}. Se on tallennettu${forClient} ja merkitty tarkistettavaksi uudelleen.`,
    duplicateOf: (existingName, existingFrom, forClient) => `Tämä on minulla jo tallessa${forClient}. Se on sama kuin ${existingName}${existingFrom}. Muuta ei tarvita.`,
    duplicate: (filename, fromDate, forClient) => `${filename ? `${filename}${fromDate}` : 'Tämä'} on minulla jo tallessa${forClient}. Muuta ei tarvita.`,
    read: (parts, forClient) => `Luin sen: ${parts}. Se on arkistoitu${forClient}.`,
    readNoFields: (forClient) => `Luin kuvan, mutta en saanut siitä myyjää tai summaa. Se on tallennettu${forClient}.`,
    oneFile: 'Yksi tiedosto',
    groupReadNoFields: (name) => `${name}: luettu, mutta en saanut myyjää tai summaa.`,
    groupDuplicateOf: (name, existingName) => `${name}: jo tallessa, sama kuin ${existingName}.`,
    groupDuplicate: (name) => `${name}: jo tallessa.`,
    groupFailed: (name) => `${name}: en saanut siitä selvää. Se on tallennettu ja merkitty tarkistettavaksi uudelleen.`,
    groupAllRead: (count, clientName) => `Luin ${count} tositetta${clientName ? ` (${clientName})` : ''}:`,
    groupSome: (count, clientName) => `Lähettämäsi ${count} tiedostoa${clientName ? ` (${clientName})` : ''}:`,
    total: (totalText) => `Yhteensä ${totalText}.`,
    allFiled: 'Kaikki arkistoitu.'
  })
});

const summaryCopyFor = (language) => OWNER_MEDIA_SUMMARY_COPY[language] || OWNER_MEDIA_SUMMARY_COPY.en;

// registerDocumentInDb's duplicate envelope, tolerant of jsonb (object)
// and stringified (test/legacy) shapes.
const duplicateEnvelope = (document = {}) => {
  const raw = typeof document.parse_summary === 'string'
    ? (() => { try { return JSON.parse(document.parse_summary); } catch { return {}; } })()
    : (document.parse_summary && typeof document.parse_summary === 'object' ? document.parse_summary : {});
  return {
    existingName: String(raw.existing_filename || '').trim(),
    existingUploadedAt: raw.existing_uploaded_at || null
  };
};

// Pure renderer over the persisted document row. Exported for tests; the
// copy here follows the Donna voice rule (no em or en dashes, ever).
//
// The failed and duplicate lines NAME the photo (filename + upload date)
// when the row carries them: the terminal-summary sweep can deliver several
// of these in one burst, and without an identifier N failures render
// byte-identical texts that read as a double-send (Kari hit exactly that on
// the sweep's first production tick, 2026-07-21). Degrade gracefully: no
// filename keeps the anonymous copy, no date drops the "from" clause.
export const buildOwnerMediaSummaryText = ({ document = {}, clientName = null, language = 'en' } = {}) => {
  const copy = summaryCopyFor(language);
  const forClient = copy.forClient(clientName);
  const status = String(document.parse_status || '').toLowerCase();
  const filename = String(document.filename || '').trim();
  const fromDate = copy.fromDate(formatDocumentDate(document.uploaded_at, language));
  if (status === 'failed') {
    return copy.failed(filename, fromDate, forClient);
  }
  if (status === 'duplicate_pending') {
    // The placeholder's parse_summary is registerDocumentInDb's duplicate
    // envelope and names the CANONICAL doc this upload byte-matched. Point
    // the owner at that doc when we have it: the upload's own filename is a
    // synthetic Telegram CDN name ("file_16.pdf"), which read as noise in
    // the 2026-07-21 report ("the first message was unclear").
    const existingName = duplicateEnvelope(document).existingName;
    if (existingName) {
      const existingFrom = copy.fromDate(formatDocumentDate(duplicateEnvelope(document).existingUploadedAt, language));
      return copy.duplicateOf(existingName, existingFrom, copy.heldFor(clientName));
    }
    return copy.duplicate(filename, fromDate, copy.heldFor(clientName));
  }
  if (status !== 'completed') return null;
  const vendor = String(document.vendor_name || '').trim();
  const amount = formatAmount(document.total_amount, document.currency, language);
  const date = formatDocumentDate(document.document_date, language);
  if (vendor && amount) {
    const parts = [vendor, amount];
    if (date) parts.push(date);
    return copy.read(parts.join(', '), forClient);
  }
  return copy.readNoFields(forClient);
};

// Combined renderer for a Telegram album (multi-file send): one message,
// one line per file, amount totals per currency (Kari 2026-07-21: "one
// acknowledgement and one summary, summary of all in terms of amounts").
// Same voice rules as the single renderer: no em or en dashes, short
// sentences, renders only the persisted verdicts.
export const buildOwnerMediaGroupSummaryText = ({ documents = [], clientName = null, language = 'en' } = {}) => {
  const docs = (documents || []).filter(Boolean);
  if (!docs.length) return null;
  const copy = summaryCopyFor(language);
  const lines = [];
  const totals = new Map();
  let readCount = 0;
  for (const doc of docs) {
    const status = String(doc.parse_status || '').toLowerCase();
    const name = String(doc.filename || '').trim() || copy.oneFile;
    if (status === 'completed') {
      readCount += 1;
      const vendor = String(doc.vendor_name || '').trim();
      const amount = formatAmount(doc.total_amount, doc.currency, language);
      const date = formatDocumentDate(doc.document_date, language);
      if (vendor && amount) {
        const code = String(doc.currency || '').trim().toUpperCase();
        const value = Number(doc.total_amount);
        if (code && Number.isFinite(value)) totals.set(code, (totals.get(code) || 0) + value);
        lines.push([vendor, amount, date].filter(Boolean).join(', '));
      } else {
        lines.push(copy.groupReadNoFields(name));
      }
    } else if (status === 'duplicate_pending') {
      const { existingName } = duplicateEnvelope(doc);
      lines.push(existingName
        ? copy.groupDuplicateOf(name, existingName)
        : copy.groupDuplicate(name));
    } else if (status === 'failed') {
      lines.push(copy.groupFailed(name));
    } else {
      return null; // a non-terminal member means the group is not ready
    }
  }
  const allRead = readCount === docs.length;
  const parts = [
    allRead
      ? copy.groupAllRead(docs.length, clientName)
      : copy.groupSome(docs.length, clientName),
    ...lines
  ];
  if (totals.size) {
    const totalText = [...totals.entries()].map(([code, sum]) => `${decimal(sum, language)} ${code}`).join(', ');
    parts.push(copy.total(totalText));
  }
  if (allRead) parts.push(copy.allFiled);
  return parts.join('\n');
};

const GROUP_TERMINAL_STATUSES = new Set(['completed', 'failed', 'duplicate_pending']);

// The album path: called from the per-document send below once gates have
// passed. Every member's parse leg (and the terminal-summary sweep) lands
// here; whoever finds the WHOLE album terminal first takes the group claim
// and sends the one combined message. Members already spoken for on their
// own (an earlier inline duplicate reply) are excluded from the text; after
// the group message sends, per-document claims are minted for the covered
// members so sibling leg retries and the sweep stay silent. Returns null
// when the album has only one registered member so far — the caller then
// falls through to the single-document path (a lone member either has an
// unregistered sibling coming, which will re-enter here, or is genuinely
// alone and deserves its own summary).
const sendOwnerMediaGroupSummary = async ({ firmId, clientId, mediaGroupId, binding, clientName, language = 'en', deps = {} }) => {
  const listGroupDocs = deps.listGroupDocs || listOwnerMediaGroupDocsInDb;
  const members = await listGroupDocs({ firmId, clientId, mediaGroupId });
  if (!Array.isArray(members) || members.length < 2) return null;
  if (members.some((doc) => !GROUP_TERMINAL_STATUSES.has(String(doc?.parse_status || '').toLowerCase()))) {
    return { sent: false, skipped: 'group_pending' };
  }
  const listClaimed = deps.listClaimedDocIds || listOwnerMediaSummaryClaimedDocIdsInDb;
  let spokenIds = new Set();
  try {
    spokenIds = new Set(await listClaimed({ documentIds: members.map((doc) => doc.id) }));
  } catch {
    spokenIds = new Set(); // worst case a dup line repeats inside the summary
  }
  const speakFor = members.filter((doc) => !spokenIds.has(doc.id));
  if (!speakFor.length) return { sent: false, skipped: 'group_all_spoken' };
  const text = buildOwnerMediaGroupSummaryText({ documents: speakFor, clientName, language });
  if (!text) return { sent: false, skipped: 'group_pending' };
  const claimGroup = deps.claimGroupSend || claimOwnerMediaGroupSendInDb;
  const claimed = await claimGroup({ firmId, clientId, mediaGroupId, kind: 'summary', phoneHash: binding.phone_hash || null });
  if (!claimed?.claimed) return { sent: false, skipped: 'already_sent' };
  const send = deps.sendText || sendTelegramText;
  try {
    await send({ to: binding.phone_e164, text });
  } catch (err) {
    // Same contract as the single send: the claim stays burned, one
    // combined summary is lost visibly, never a double-message.
    console.error('[ownerMediaSummary] group send failed', {
      media_group_id: mediaGroupId,
      error_name: err?.name || null
    });
    return { sent: false, skipped: 'send_failed' };
  }
  const claimDoc = deps.claimSummarySend || claimOwnerMediaSummarySendInDb;
  for (const doc of speakFor) {
    try {
      await claimDoc({ firmId, clientId, documentId: doc.id, phoneHash: binding.phone_hash || null });
    } catch {
      // best-effort bookkeeping; a missed per-doc claim only costs the
      // sweep a quiet already_sent pass later
    }
  }
  return { sent: true, text, media_group_id: mediaGroupId, covered: speakFor.map((doc) => doc.id) };
};

const sendOwnerMediaParseSummaryInner = async ({
  firmId,
  documentId,
  env = process.env,
  deps = {}
} = {}) => {
  const getDoc = deps.getOwnerMediaDoc || getOwnerMediaDocForSummaryInDb;
  const document = await getDoc({ firmId, documentId });
  if (!document) return { sent: false, skipped: 'no_document' };

  // Only the owner-initiated Telegram lane speaks here. Portal uploads, firm
  // uploads, and evidence-ask replies have their own surfaces.
  //
  // Shape note (the 2026-07-21 first-firing bug): the persisted
  // documents.payload column is registerDocumentInDb's snapshot of the WHOLE
  // registration document ({...document, parse_run_id}), so the registrar's
  // markers (defaultRegisterOwnerInitiatedDocument's payload object) live
  // NESTED at payload.payload.*. The first version read one level too
  // shallow and every real Telegram photo skipped as not_owner_initiated.
  // Read flat first, then the nested persisted shape.
  const outer = document.payload && typeof document.payload === 'object' ? document.payload : {};
  const inner = outer.payload && typeof outer.payload === 'object' ? outer.payload : {};
  const ownerInitiated = outer.owner_initiated === true || inner.owner_initiated === true;
  if (!ownerInitiated) return { sent: false, skipped: 'not_owner_initiated' };
  const channel = String(outer.channel || outer.source || inner.channel || inner.source || '').toLowerCase();
  if (channel !== 'telegram') return { sent: false, skipped: 'not_telegram' };
  const clientId = document.client_id;
  if (!clientId) return { sent: false, skipped: 'no_client' };

  const loadSnapshot = deps.loadClientConfigSnapshot || (({ firmId: scopedFirmId, clientId: scopedClientId }) => withFirmDbClient((client) => readClientConfigSnapshot(client, { firmId: scopedFirmId, clientId: scopedClientId })));
  const gateContext = await prefetchOwnerChannelGateContext({ bindings: [{ client_id: clientId }], firmId, loadSnapshot });
  if (!ownerChannelAllowsClient({ channel: 'telegram', clientId, gateContext, envFallback: telegramEnvAllowsClient, env })) return { sent: false, skipped: 'env_gate_off' };

  const flagActs = deps.flagActs || (async () => {
    const snapshot = gateContext.snapshotsByClient[clientId];
    return clientFlagActs({ flagKey: OWNER_MEDIA_PARSE_SUMMARY_FLAG_KEY, snapshot, envFallback: () => false, env });
  });
  if (!(await flagActs({ firmId, clientId }))) return { sent: false, skipped: 'flag_off' };

  const getBinding = deps.getActiveTelegramBindingForClient || getActiveTelegramBindingForClientInDb;
  const binding = await getBinding({ firmId, clientId });
  if (!binding || !binding.phone_e164) return { sent: false, skipped: 'no_active_binding' };

  const getClientDisplayName = deps.getClientDisplayName || getClientDisplayNameInDb;
  let clientName = null;
  try {
    clientName = await getClientDisplayName({ firmId, clientId });
  } catch {
    clientName = null; // the summary still sends, just unnamed
  }
  // The owner's language for the summary copy; English when unreadable.
  const getOwnerLanguage = deps.getOwnerLanguage || getClientOwnerLanguageInDb;
  const language = await Promise.resolve()
    .then(() => getOwnerLanguage({ firmId, clientId }))
    .catch(() => 'en');

  // Album member: coalesce into ONE combined summary for the whole
  // multi-file send. A null return means the album has only this one
  // registered member so far; fall through to the single-document path.
  // NO-THROW: a group failure degrades to the per-file summary below —
  // it must never kill the leg and lose the summary entirely. This is
  // exactly how the 2026-07-22 miss played out: a ReferenceError (the
  // group gather was referenced without being imported) threw here, the
  // leg soft-degraded, and both album members went silent with no claim
  // and nothing for the sweep to re-drive (it only re-drives failed/dup
  // docs). The import is fixed; this catch keeps the failure mode
  // impossible by construction.
  const mediaGroupId = String(outer.media_group_id || inner.media_group_id || '').trim();
  if (mediaGroupId) {
    try {
      const groupOutcome = await sendOwnerMediaGroupSummary({ firmId, clientId, mediaGroupId, binding, clientName, language, deps });
      if (groupOutcome) return groupOutcome;
    } catch (err) {
      console.error('[ownerMediaSummary] group path failed; degrading to the per-file summary', {
        document_id: documentId || null,
        media_group_id: mediaGroupId,
        error_name: err?.name || null,
        error_message: err?.message || ''
      });
    }
  }

  const text = buildOwnerMediaSummaryText({ document, clientName, language });
  if (!text) return { sent: false, skipped: `no_text_for_status_${document.parse_status || 'unknown'}` };

  // Claim BEFORE sending: an Inngest leg retry that reaches here again finds
  // the claim taken and stays silent instead of double-messaging the owner.
  const claim = deps.claimSummarySend || claimOwnerMediaSummarySendInDb;
  const claimed = await claim({ firmId, clientId, documentId, phoneHash: binding.phone_hash || null });
  if (!claimed?.claimed) return { sent: false, skipped: 'already_sent' };

  const send = deps.sendText || sendTelegramText;
  try {
    await send({ to: binding.phone_e164, text });
  } catch (err) {
    // The module's contract is no-throw (a send failure must not fail the
    // parse leg). The claim stays burned, so a leg retry will not re-send:
    // a transient Telegram failure costs this one summary, typed and logged
    // here, never a double-message and never a failed parse run.
    console.error('[ownerMediaSummary] send failed', {
      document_id: documentId || null,
      error_name: err?.name || null
    });
    return { sent: false, skipped: 'send_failed' };
  }
  return { sent: true, text };
};

export const sendOwnerMediaParseSummary = async (args = {}) => {
  const outcome = await sendOwnerMediaParseSummaryInner(args);
  // One line per parsed doc: the typed skip reasons existed from birth but
  // surfaced only as Inngest step output, invisible in the Vercel logs where
  // the 2026-07-21 "no summary arrived" hunt actually happened. Ids and
  // enums only, never document text.
  console.info('[ownerMediaSummary] outcome', {
    document_id: args?.documentId || null,
    sent: outcome?.sent === true,
    skipped: outcome?.skipped || null
  });
  return outcome;
};

// F-2 (docs/donna-telegram-receipt-silence-diagnostic.md §7): the fail-path
// notification. The worker's post-parse legs only fire on COMPLETED parses
// (parseDocumentStepSplit pins that plan), and the cron STUCK flip happens
// outside the worker entirely — so a hard-failed owner photo was chat-silent:
// the "could not read that photo" copy above existed with nothing invoking it.
// This sweep rides the parse cron's stuck tick and drives each terminal doc
// through the SAME send pipeline (its env gate, plane flag, binding check, and
// exactly-once claim all apply unchanged). Deterministic, no model calls.
// No-throw: a sweep failure returns a typed summary, never fails the cron.
// First-deploy note: docs that failed within the lookback window before this
// sweep existed get their notice once, late; older history is permanently
// excluded by the gather's lookback bound.
export const runOwnerMediaTerminalSummarySweep = async ({
  firmId,
  env = process.env,
  deps = {},
  lookbackHours = 48,
  limit = 20
} = {}) => {
  const list = deps.listDocsNeedingSummary || listOwnerMediaDocsNeedingTerminalSummaryInDb;
  let rows = [];
  try {
    rows = await list({ firmId, lookbackHours, limit });
  } catch (err) {
    console.error('[ownerMediaSummary] sweep gather failed', { error_name: err?.name || null, error_message: err?.message || '' });
    return { swept: 0, sent: 0, skipped: {}, gather_failed: true };
  }
  const send = deps.sendSummary || sendOwnerMediaParseSummary;
  let sent = 0;
  const skipped = {};
  for (const row of rows || []) {
    try {
      const outcome = await send({ firmId, documentId: row.id, env, deps: deps.summaryDeps || {} });
      if (outcome?.sent) {
        sent += 1;
      } else {
        const reason = outcome?.skipped || 'unknown';
        skipped[reason] = (skipped[reason] || 0) + 1;
      }
    } catch (err) {
      // Contract says the send never throws; this is the belt for a broken dep.
      console.error('[ownerMediaSummary] sweep send threw', { document_id: row?.id || null, error_name: err?.name || null });
      skipped.threw = (skipped.threw || 0) + 1;
    }
  }
  return { swept: (rows || []).length, sent, skipped };
};
