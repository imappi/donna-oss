// Deterministic outbound email artifact and delivery-contract receipts.
//
// Pack templates remain the one copy source. This boundary turns their
// bidi-safe logical plain text into an escaped HTML companion, inventories
// attachments by exact bytes, and fingerprints the complete provider
// envelope. It performs no translation and no intelligence: malformed UAX #9
// controls, missing language metadata, unsafe attachment shapes, and an
// incoherent locale/direction contract refuse before delivery.

import { createHash } from 'node:crypto';

import {
  FSI, LRI, PDI, RLI, assertWellFormedBidiIsolation, stripBidiControls
} from './bidiText.js';
import { resolveCorrespondenceLanguage, textDirectionForLocale } from './packs.js';

// Version 1 is the existing approved-consequence contract. AR-4E adds a
// parallel version-2 delivery contract; send-time enforcement deliberately
// ignores null/v1 rows so approvals already standing at deployment remain
// valid under their original semantics.
export const OUTBOUND_DELIVERY_CONTRACT_VERSION = 2;
export const OUTBOUND_CONTENT_FINGERPRINT_VERSION = 1;

const ISOLATE_DIRECTION = Object.freeze({
  [LRI]: 'ltr',
  [RLI]: 'rtl',
  [FSI]: 'auto'
});

const clean = (value) => String(value ?? '').trim();

const canonicalJson = (value) => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('delivery envelope contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  throw new TypeError('delivery envelope must contain JSON values');
};

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const canonicalHeaders = (headers = {}) => Object.fromEntries(
  Object.entries(headers || {})
    .map(([key, value]) => [clean(key), String(value ?? '')])
    .filter(([key]) => Boolean(key))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
);

// One language-selection law for approval and send. Owner-directed notices
// deliberately ignore supplier language attributes and use the action's
// persisted owner/pack language (or the pack default when absent);
// counterparty sends prefer the current party request, then the action's
// persisted request, and accept only an explicit party fallback.
export const resolveOutboundActionLanguage = ({
  pack, actionLanguage = null, preferredLanguage = null,
  fallbackLanguage = null, ownerDirected = false
} = {}) => {
  const requestedLanguage = ownerDirected
    ? (actionLanguage || null)
    : (preferredLanguage || actionLanguage || null);
  const requestedSource = !requestedLanguage
    ? 'pack_default'
    : ownerDirected
      ? 'action_language'
    : preferredLanguage
      ? 'party_preference'
      : 'action_language';
  return resolveCorrespondenceLanguage(pack, {
    requestedLanguage,
    requestedSource,
    fallbackLanguage: ownerDirected ? null : fallbackLanguage
  });
};

// Convert only validated isolate pairs. Template prose stays escaped logical
// text; dynamic islands become bdi spans with the same direction semantics.
// CSS preserves the exact newline/whitespace shape of the text fallback.
export const bidiPlainTextToHtml = (value) => {
  const text = assertWellFormedBidiIsolation(value);
  let html = '';
  for (let index = 0; index < text.length;) {
    const direction = ISOLATE_DIRECTION[text[index]];
    if (!direction) {
      html += escapeHtml(text[index]);
      index += 1;
      continue;
    }
    const end = text.indexOf(PDI, index + 1);
    const logical = text.slice(index + 1, end);
    html += `<bdi dir="${direction}">${escapeHtml(logical)}</bdi>`;
    index = end + 1;
  }
  return html;
};

export const buildAttachmentManifest = (attachments = []) => (
  (attachments || []).map((attachment, index) => {
    if (!attachment || typeof attachment !== 'object') {
      throw new TypeError(`attachment ${index + 1} must be an object`);
    }
    const filename = clean(attachment.filename);
    const contentType = clean(attachment.contentType);
    if (!filename || !contentType || !Buffer.isBuffer(attachment.content)) {
      throw new TypeError(`attachment ${index + 1} requires filename, contentType and Buffer content`);
    }
    const hasArtifactKind = Object.hasOwn(attachment, 'artifactKind');
    const hasArtifactTemplate = Object.hasOwn(attachment, 'artifactTemplate');
    if (hasArtifactKind !== hasArtifactTemplate
        || (hasArtifactKind && (attachment.artifactKind !== 'credit_note_pdf'
          || attachment.artifactTemplate !== 'credit_note_pdf'))) {
      const error = new TypeError(`attachment ${index + 1} has an invalid artifact identity pair`);
      error.code = 'OUTBOUND_CREDIT_NOTE_PDF_CONTRACT_INVALID';
      throw error;
    }
    return {
      filename,
      content_type: contentType,
      byte_length: attachment.content.length,
      sha256: sha256(attachment.content),
      ...(hasArtifactKind ? {
        artifact_kind: attachment.artifactKind,
        artifact_template: attachment.artifactTemplate
      } : {})
    };
  })
);

export const fingerprintOutboundDeliveryContract = ({
  recipient = null,
  packId,
  packVersion,
  templateName,
  requestedLanguage = null,
  actualLanguage,
  languageSource,
  fallbackBasis = null,
  correspondenceLocale,
  direction,
  statutoryTitle = null,
  statutoryTitleLimb = null
} = {}) => {
  const requested = clean(requestedLanguage).toLowerCase() || null;
  const contract = {
    version: OUTBOUND_DELIVERY_CONTRACT_VERSION,
    recipient: clean(recipient).toLowerCase() || null,
    pack_id: clean(packId),
    pack_version: Number(packVersion),
    template_name: clean(templateName),
    requested_language: requested,
    actual_language: clean(actualLanguage).toLowerCase(),
    language_source: clean(languageSource),
    fallback_basis: clean(fallbackBasis) || null,
    correspondence_locale: clean(correspondenceLocale),
    direction: clean(direction),
    statutory_title: clean(statutoryTitle) || null,
    statutory_title_limb: clean(statutoryTitleLimb) || null
  };
  if (!contract.pack_id || !Number.isSafeInteger(contract.pack_version)
      || !contract.template_name
      || (contract.requested_language && !/^[a-z]{2}$/.test(contract.requested_language))
      || !/^[a-z]{2}$/.test(contract.actual_language)
      || !contract.language_source || !contract.correspondence_locale
      || !['ltr', 'rtl'].includes(contract.direction)) {
    throw new TypeError('delivery contract is incomplete');
  }
  return `sha256:${sha256(canonicalJson(contract))}`;
};

export const buildOutboundEmailArtifact = ({
  recipient,
  from = null,
  replyTo = null,
  headers = {},
  subject,
  text,
  language,
  languageResolution,
  pack,
  templateName,
  statutoryTitle = null,
  statutoryTitleLimb = null,
  attachments = []
} = {}) => {
  if (!languageResolution?.ok) throw new TypeError('a resolved correspondence language is required');
  if (language !== languageResolution.actualLanguage) {
    throw new TypeError('email language must equal the resolved actual language');
  }
  const locale = clean(languageResolution.locale);
  const direction = clean(languageResolution.direction);
  const localeDirection = textDirectionForLocale(locale);
  if (!['ltr', 'rtl'].includes(direction) || localeDirection !== direction) {
    throw new TypeError('email locale and direction are incoherent');
  }
  if (!/^[a-z]{2}$/.test(language)) throw new TypeError('email language must be a two-letter code');
  const renderedSubject = assertWellFormedBidiIsolation(subject);
  const renderedText = assertWellFormedBidiIsolation(text);
  const htmlBody = bidiPlainTextToHtml(renderedText);
  const html = '<!doctype html>'
    + `<html lang="${escapeHtml(language)}" dir="${direction}">`
    + `<body><div style="white-space: pre-wrap">${htmlBody}</div></body></html>`;
  const attachmentManifest = buildAttachmentManifest(attachments);
  const deliveryContractFingerprint = fingerprintOutboundDeliveryContract({
    recipient,
    packId: pack?.pack?.id,
    packVersion: pack?.pack?.version,
    templateName,
    requestedLanguage: languageResolution.requestedLanguage,
    actualLanguage: languageResolution.actualLanguage,
    languageSource: languageResolution.languageSource,
    fallbackBasis: languageResolution.fallbackBasis,
    correspondenceLocale: locale,
    direction,
    statutoryTitle,
    statutoryTitleLimb
  });
  const envelope = {
    version: OUTBOUND_CONTENT_FINGERPRINT_VERSION,
    channel: 'email',
    to: clean(recipient),
    from: clean(from) || null,
    reply_to: clean(replyTo) || null,
    headers: canonicalHeaders(headers),
    requested_language: languageResolution.requestedLanguage,
    actual_language: languageResolution.actualLanguage,
    language_source: languageResolution.languageSource,
    fallback_basis: languageResolution.fallbackBasis,
    correspondence_locale: locale,
    direction,
    template_catalog_id: pack.pack.id,
    template_catalog_version: pack.pack.version,
    template_name: templateName,
    subject: renderedSubject,
    text: renderedText,
    html,
    attachments: attachmentManifest
  };
  return Object.freeze({
    subject: renderedSubject,
    text: renderedText,
    html,
    attachmentManifest: Object.freeze(attachmentManifest),
    contentFingerprint: `sha256:${sha256(canonicalJson(envelope))}`,
    deliveryContractFingerprint,
    logicalText: stripBidiControls(renderedText),
    envelope: Object.freeze(envelope)
  });
};
