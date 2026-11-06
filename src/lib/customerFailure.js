// Customer-facing projection of the existing failure taxonomy (FI-05,
// 2026-10-15). The codes are the ones the server already persists: the parse
// envelope (`server/donna/inngest/parseErrors.js`) and the provider-failure
// read model (`server/donna/providerFailureReadModel.js`). This module adds no code
// of its own; it only decides which of three things a firm or client user is
// told:
//
//   saved          — the work is in hand (rendered by the existing labels);
//   taking_longer  — a TECHNICAL failure (provider, storage, database,
//                    configuration, credentials, worker). The file is kept,
//                    nothing is asked of the user, and the diagnostic detail
//                    stays on the operator surface (/firms/operator) and in
//                    the persisted receipt the reference id points at;
//   action_needed  — a fact about the FILE itself that only the user can
//                    change (corrupt, password-protected, too large, no
//                    readable content). Never used for a technical failure:
//                    a provider outage must not become a request for a
//                    document Donna already holds.
//
// Raw messages, provider names, HTTP statuses and internal codes never reach
// the customer through here; the catalog copy is the only text.

// Parse codes that describe the uploaded file, not Donna's machinery. The
// English text is the catalog message, kept here only as the fallback for
// callers rendering without an intl formatter (the tray's plain-label path).
const DOCUMENT_FACTS = Object.freeze({
  INVALID_PDF: ['upload.failure.fact.invalidPdf', 'This file looks damaged or is not a PDF. Upload a readable copy.'],
  UNSUPPORTED_FORMAT: ['upload.failure.fact.unsupportedFormat', 'This file cannot be opened, for example because it is password-protected. Upload an unprotected copy.'],
  FILE_TOO_LARGE: ['upload.failure.fact.fileTooLarge', 'This file is too large to read. Upload a smaller copy or split it.'],
  REQUEST_BODY_TOO_LARGE: ['upload.failure.fact.fileTooLarge', 'This file is too large to read. Upload a smaller copy or split it.'],
  EXTRACTION_NO_TRANSACTIONS: ['upload.failure.fact.noContent', 'No transactions were found in this file. Check that it is the right document.'],
  DOCUMENT_EXTRACTION_UNREADABLE: ['upload.failure.fact.unreadable', 'Too little of this document could be read. Upload a clearer copy.']
});

export const documentFactMessageId = (code) => DOCUMENT_FACTS[code]?.[0] || null;
export const documentFactFallback = (code) => DOCUMENT_FACTS[code]?.[1] || null;

export const customerFailureState = (code) => (documentFactMessageId(code) ? 'action_needed' : 'taking_longer');

// A short, stable handle a user can quote to support. It is derived from the
// persisted row id (document, job or receipt), so operations can find the
// same record; it carries no code, provider or message.
export const customerReference = (id) => {
  const compact = String(id || '').replace(/^[a-z_]+:/i, '').replace(/[^a-z0-9]/gi, '');
  return compact ? compact.slice(0, 8).toUpperCase() : null;
};
