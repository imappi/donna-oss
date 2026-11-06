// Product feedback capture — the sidebar Feedback modal's write path
// (migration 115). Meta-product lane: a note ABOUT Donna, not books data,
// so it lives in its own thin module over queryFirmDb (the
// marketingWaitlistDb shape) rather than in the firm engine. The row's
// resting state 'new' is the terminal "on Kari"; 'seen'/'resolved' are his
// receipts when he acts.

import { randomUUID } from 'node:crypto';

import { queryFirmDb } from './firmDb.js';

// Exported so migrations.test.js can pin the 115 CHECK vocabulary to this
// runtime set (the house drift guard: a kind this module writes but the
// column rejects would be a silent write failure).
export const FEEDBACK_KINDS = ['bug', 'idea', 'note'];

const VALID_KINDS = new Set(FEEDBACK_KINDS);
const MAX_MESSAGE_CHARS = 8000;
const MAX_CONTEXT_VALUE_CHARS = 300;

// Context is client-supplied — keep only the shallow, known-useful fields
// and cap each value, so the jsonb column can't become an arbitrary-payload
// dumping ground.
const CONTEXT_FIELDS = ['view', 'client_id', 'shell', 'viewport', 'user_agent'];

const sanitizeContext = (context) => {
  if (!context || typeof context !== 'object') return {};
  const clean = {};
  for (const field of CONTEXT_FIELDS) {
    const value = context[field];
    if (typeof value === 'string' && value.trim()) {
      clean[field] = value.trim().slice(0, MAX_CONTEXT_VALUE_CHARS);
    }
  }
  return clean;
};

export const recordUserFeedbackInDb = async ({
  firmId,
  kind,
  message,
  context = {},
  submittedBy = null,
  deps = {}
} = {}) => {
  const query = deps.query || queryFirmDb;
  const makeId = deps.randomUUID || randomUUID;

  const cleanMessage = String(message || '').trim().slice(0, MAX_MESSAGE_CHARS);
  if (!cleanMessage) {
    const error = new Error('Say something first — the note is empty.');
    error.statusCode = 400;
    error.code = 'FEEDBACK_MESSAGE_REQUIRED';
    throw error;
  }
  const cleanKind = VALID_KINDS.has(kind) ? kind : 'note';
  const id = `fb_${makeId()}`;

  await query(
    `insert into user_feedback (id, firm_id, kind, message, context, submitted_by)
     values ($1, $2, $3, $4, $5::jsonb, $6)`,
    [
      id,
      firmId,
      cleanKind,
      cleanMessage,
      JSON.stringify(sanitizeContext(context)),
      typeof submittedBy === 'string' && submittedBy.trim() ? submittedBy.trim() : null
    ]
  );
  return { ok: true, id };
};
