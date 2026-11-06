import test from 'node:test';
import assert from 'node:assert/strict';

import { buildOwnerMediaGroupSummaryText, buildOwnerMediaSummaryText, runOwnerMediaTerminalSummarySweep, sendOwnerMediaParseSummary } from './ownerMediaParseSummary.js';

// ── the pure renderer ────────────────────────────────────────────────────

test('completed parse with vendor and amount renders the consequence line', () => {
  const text = buildOwnerMediaSummaryText({
    document: { parse_status: 'completed', vendor_name: 'Exxon', total_amount: '42.17', currency: 'usd', document_date: '2026-07-12' },
    clientName: 'Honeybee Hills Apiary LLC'
  });
  assert.equal(text, 'Read it: Exxon, 42.17 USD, 12 Jul 2026. It is filed for Honeybee Hills Apiary LLC.');
});

test('completed parse without vendor or amount says so honestly', () => {
  const text = buildOwnerMediaSummaryText({
    document: { parse_status: 'completed', vendor_name: '', total_amount: null },
    clientName: 'Honeybee Hills Apiary LLC'
  });
  assert.equal(text, 'I read the photo but could not pull a vendor or amount from it. It is saved for Honeybee Hills Apiary LLC.');
});

test('failed parse is surfaced, never silent', () => {
  const text = buildOwnerMediaSummaryText({ document: { parse_status: 'failed' }, clientName: 'Honeybee Hills Apiary LLC' });
  assert.equal(text, 'I could not read that photo. It is saved for Honeybee Hills Apiary LLC and marked as needing another look.');
});

// N failures in one sweep burst must not render byte-identical texts (the
// 2026-07-21 first-tick burst read as a double-send): name the photo.
test('failed parse names the photo and upload date when the row carries them', () => {
  const text = buildOwnerMediaSummaryText({
    document: { parse_status: 'failed', filename: 'file_8.jpg', uploaded_at: '2026-07-21T11:58:00.000Z' },
    clientName: 'Honeybee Hills Apiary LLC'
  });
  assert.equal(text, 'I could not read the photo file_8.jpg from 21 Jul 2026. It is saved for Honeybee Hills Apiary LLC and marked as needing another look.');
});

test('failed parse with a filename but no usable date drops the from clause', () => {
  const text = buildOwnerMediaSummaryText({ document: { parse_status: 'failed', filename: 'file_9.jpg' }, clientName: 'X' });
  assert.equal(text, 'I could not read the photo file_9.jpg. It is saved for X and marked as needing another look.');
});

test('duplicate_pending tells the owner it is already on file', () => {
  const text = buildOwnerMediaSummaryText({ document: { parse_status: 'duplicate_pending' }, clientName: 'Honeybee Hills Apiary LLC' });
  assert.equal(text, 'I already have this one on file for Honeybee Hills Apiary LLC. Nothing else needed.');
});

test('duplicate_pending names the photo when the row carries it', () => {
  const text = buildOwnerMediaSummaryText({
    document: { parse_status: 'duplicate_pending', filename: 'IMG_9446.jpg', uploaded_at: new Date('2026-07-21T12:10:00.000Z') },
    clientName: 'Honeybee Hills Apiary LLC'
  });
  assert.equal(text, 'I already have IMG_9446.jpg from 21 Jul 2026 on file for Honeybee Hills Apiary LLC. Nothing else needed.');
});

// The upload's own filename is a synthetic CDN name; the duplicate envelope
// names the CANONICAL doc it byte-matched — prefer that (2026-07-21 report:
// "I already have file_16.pdf on file" read as noise).
test('duplicate_pending points at the canonical doc when the duplicate envelope names it', () => {
  const text = buildOwnerMediaSummaryText({
    document: {
      parse_status: 'duplicate_pending',
      filename: 'file_16.pdf',
      uploaded_at: '2026-07-21T16:40:00.000Z',
      parse_summary: {
        reason: 'byte_match',
        existing_document_id: 'doc-exxon-1',
        existing_filename: 'exxon-receipt-jul.pdf',
        existing_uploaded_at: '2026-07-12T09:00:00.000Z'
      }
    },
    clientName: 'Honeybee Hills Apiary LLC'
  });
  assert.equal(text, 'I already have this one on file for Honeybee Hills Apiary LLC. It matches exxon-receipt-jul.pdf from 12 Jul 2026. Nothing else needed.');
});

test('duplicate_pending accepts a stringified duplicate envelope', () => {
  const text = buildOwnerMediaSummaryText({
    document: {
      parse_status: 'duplicate_pending',
      parse_summary: JSON.stringify({ existing_filename: 'exxon-receipt-jul.pdf' })
    },
    clientName: 'X'
  });
  assert.equal(text, 'I already have this one on file for X. It matches exxon-receipt-jul.pdf. Nothing else needed.');
});

test('in-flight statuses render nothing (no speculative claims)', () => {
  assert.equal(buildOwnerMediaSummaryText({ document: { parse_status: 'processing' } }), null);
  assert.equal(buildOwnerMediaSummaryText({ document: { parse_status: 'pending' } }), null);
});

test('the summary copy obeys the Donna voice rule: no em or en dashes', () => {
  const variants = [
    buildOwnerMediaSummaryText({ document: { parse_status: 'completed', vendor_name: 'Exxon', total_amount: 42.17, currency: 'USD', document_date: '2026-07-12' }, clientName: 'X' }),
    buildOwnerMediaSummaryText({ document: { parse_status: 'completed' }, clientName: 'X' }),
    buildOwnerMediaSummaryText({ document: { parse_status: 'failed' }, clientName: 'X' }),
    buildOwnerMediaSummaryText({ document: { parse_status: 'failed', filename: 'file_8.jpg', uploaded_at: '2026-07-21T11:58:00.000Z' }, clientName: 'X' }),
    buildOwnerMediaSummaryText({ document: { parse_status: 'duplicate_pending' }, clientName: 'X' }),
    buildOwnerMediaSummaryText({ document: { parse_status: 'duplicate_pending', filename: 'IMG_9446.jpg', uploaded_at: '2026-07-21T12:10:00.000Z' }, clientName: 'X' }),
    buildOwnerMediaSummaryText({ document: { parse_status: 'duplicate_pending', parse_summary: { existing_filename: 'exxon.pdf', existing_uploaded_at: '2026-07-12T09:00:00.000Z' } }, clientName: 'X' })
  ];
  for (const text of variants) {
    assert.ok(text);
    assert.doesNotMatch(text, /—|–/);
  }
});

// ── the combined album renderer (one summary for a multi-file send) ──────

test('an all-read album renders one message with per-file lines, a total, and All filed', () => {
  const text = buildOwnerMediaGroupSummaryText({
    documents: [
      { parse_status: 'completed', vendor_name: 'Exxon Mobil', total_amount: '51.38', currency: 'USD', document_date: '2025-07-28' },
      { parse_status: 'completed', vendor_name: 'Exxon Mobil', total_amount: '51.38', currency: 'USD', document_date: '2025-07-29' }
    ],
    clientName: 'Honeybee Hills Apiary LLC'
  });
  assert.equal(text, [
    'Read 2 documents for Honeybee Hills Apiary LLC:',
    'Exxon Mobil, 51.38 USD, 28 Jul 2025',
    'Exxon Mobil, 51.38 USD, 29 Jul 2025',
    'Total 102.76 USD.',
    'All filed.'
  ].join('\n'));
});

test('a mixed album names each outcome and totals only what was read', () => {
  const text = buildOwnerMediaGroupSummaryText({
    documents: [
      { parse_status: 'completed', vendor_name: 'Exxon Mobil', total_amount: 51.38, currency: 'USD', document_date: '2025-07-28' },
      { parse_status: 'failed', filename: 'file_18.jpg' },
      { parse_status: 'duplicate_pending', filename: 'file_19.pdf', parse_summary: { existing_filename: 'exxon-jun.pdf' } }
    ],
    clientName: 'X'
  });
  assert.equal(text, [
    'Your 3 files for X:',
    'Exxon Mobil, 51.38 USD, 28 Jul 2025',
    'file_18.jpg: I could not read it. It is saved and marked as needing another look.',
    'file_19.pdf: already on file, it matches exxon-jun.pdf.',
    'Total 51.38 USD.'
  ].join('\n'));
});

test('album totals split per currency', () => {
  const text = buildOwnerMediaGroupSummaryText({
    documents: [
      { parse_status: 'completed', vendor_name: 'A', total_amount: 10, currency: 'USD', document_date: '2026-07-01' },
      { parse_status: 'completed', vendor_name: 'B', total_amount: 20, currency: 'EUR', document_date: '2026-07-02' }
    ]
  });
  assert.match(text, /Total 10\.00 USD, 20\.00 EUR\./);
});

test('an album with a non-terminal member renders nothing (no speculative claims)', () => {
  const text = buildOwnerMediaGroupSummaryText({
    documents: [
      { parse_status: 'completed', vendor_name: 'A', total_amount: 10, currency: 'USD' },
      { parse_status: 'processing' }
    ]
  });
  assert.equal(text, null);
});

test('the album copy obeys the Donna voice rule: no em or en dashes', () => {
  const variants = [
    buildOwnerMediaGroupSummaryText({
      documents: [
        { parse_status: 'completed', vendor_name: 'A', total_amount: 10, currency: 'USD', document_date: '2026-07-01' },
        { parse_status: 'failed', filename: 'f.jpg' },
        { parse_status: 'duplicate_pending', filename: 'g.pdf', parse_summary: { existing_filename: 'h.pdf' } }
      ],
      clientName: 'X'
    })
  ];
  for (const text of variants) {
    assert.ok(text);
    assert.doesNotMatch(text, /—|–/);
  }
});

// ── the send pipeline (real function, stubbed deps) ──────────────────────

// The REAL persisted shape: registerDocumentInDb stores the whole
// registration document as the payload column, so the registrar's markers
// sit NESTED at payload.payload.* (the 2026-07-21 first-firing bug was
// reading them flat). The base fixture uses the nested shape on purpose —
// the happy path below is the regression pin for that bug.
const baseDoc = {
  id: 'tg_doc_1',
  client_id: 'honeybee-hills-apiary-llc',
  parse_status: 'completed',
  vendor_name: 'Exxon',
  total_amount: '42.17',
  currency: 'USD',
  document_date: '2026-07-12',
  payload: {
    id: 'tg_doc_1',
    client_id: 'honeybee-hills-apiary-llc',
    document_type: 'receipt',
    filename: 'file_13.jpg',
    mime_type: 'image/jpeg',
    parse_run_id: 'run-1',
    payload: { source: 'telegram', channel: 'telegram', owner_initiated: true, inbound_reply_id: 'msg-1', media_id: 'media-1' }
  }
};

const happyDeps = (overrides = {}) => ({
  getOwnerMediaDoc: async () => baseDoc,
  loadClientConfigSnapshot: async () => ({ OWNER_CHANNEL_TELEGRAM: { stage: 'canary' } }),
  flagActs: async () => true,
  getActiveTelegramBindingForClient: async () => ({ phone_e164: '8555810486', phone_hash: 'hash' }),
  getClientDisplayName: async () => 'Honeybee Hills Apiary LLC',
  claimSummarySend: async () => ({ claimed: true }),
  sendText: async () => ({ ok: true }),
  ...overrides
});

test('happy path sends the rendered summary to the bound chat', async () => {
  const sent = [];
  const outcome = await sendOwnerMediaParseSummary({
    firmId: 'firm-1',
    documentId: 'tg_doc_1',
    deps: happyDeps({ sendText: async (args) => { sent.push(args); return { ok: true }; } })
  });
  assert.equal(outcome.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, '8555810486');
  assert.equal(sent[0].text, 'Read it: Exxon, 42.17 USD, 12 Jul 2026. It is filed for Honeybee Hills Apiary LLC.');
});

test('non-owner-initiated documents are skipped', async () => {
  const outcome = await sendOwnerMediaParseSummary({
    firmId: 'firm-1',
    documentId: 'doc-portal',
    deps: happyDeps({ getOwnerMediaDoc: async () => ({ ...baseDoc, payload: {} }) })
  });
  assert.deepEqual(outcome, { sent: false, skipped: 'not_owner_initiated' });
});

test('flat markers (no nesting) still send: the reader accepts both shapes', async () => {
  const sent = [];
  const outcome = await sendOwnerMediaParseSummary({
    firmId: 'firm-1',
    documentId: 'tg_doc_1',
    deps: happyDeps({
      getOwnerMediaDoc: async () => ({ ...baseDoc, payload: { owner_initiated: true, channel: 'telegram' } }),
      sendText: async (args) => { sent.push(args); return { ok: true }; }
    })
  });
  assert.equal(outcome.sent, true);
  assert.equal(sent.length, 1);
});

test('a portal upload with a nested non-telegram channel is skipped', async () => {
  const outcome = await sendOwnerMediaParseSummary({
    firmId: 'firm-1',
    documentId: 'doc-portal',
    deps: happyDeps({
      getOwnerMediaDoc: async () => ({
        ...baseDoc,
        payload: { ...baseDoc.payload, payload: { ...baseDoc.payload.payload, source: 'whatsapp', channel: 'whatsapp' } }
      })
    })
  });
  assert.deepEqual(outcome, { sent: false, skipped: 'not_telegram' });
});

test('a send failure returns a typed skip, never throws, claim stays burned', async () => {
  const outcome = await sendOwnerMediaParseSummary({
    firmId: 'firm-1', documentId: 'tg_doc_1',
    deps: happyDeps({ sendText: async () => { throw new Error('telegram 502'); } })
  });
  assert.deepEqual(outcome, { sent: false, skipped: 'send_failed' });
});

test('flag off skips (born dark)', async () => {
  const outcome = await sendOwnerMediaParseSummary({
    firmId: 'firm-1', documentId: 'tg_doc_1',
    deps: happyDeps({ flagActs: async () => false })
  });
  assert.deepEqual(outcome, { sent: false, skipped: 'flag_off' });
});

test('env master gate off skips', async () => {
  const outcome = await sendOwnerMediaParseSummary({
    firmId: 'firm-1', documentId: 'tg_doc_1',
    deps: happyDeps({ loadClientConfigSnapshot: async () => null })
  });
  assert.deepEqual(outcome, { sent: false, skipped: 'env_gate_off' });
});

test('a taken claim means a leg retry stays silent (exactly-once)', async () => {
  const sent = [];
  const outcome = await sendOwnerMediaParseSummary({
    firmId: 'firm-1', documentId: 'tg_doc_1',
    deps: happyDeps({
      claimSummarySend: async () => ({ claimed: false }),
      sendText: async (args) => { sent.push(args); return { ok: true }; }
    })
  });
  assert.deepEqual(outcome, { sent: false, skipped: 'already_sent' });
  assert.equal(sent.length, 0);
});

test('no active binding skips without throwing', async () => {
  const outcome = await sendOwnerMediaParseSummary({
    firmId: 'firm-1', documentId: 'tg_doc_1',
    deps: happyDeps({ getActiveTelegramBindingForClient: async () => null })
  });
  assert.deepEqual(outcome, { sent: false, skipped: 'no_active_binding' });
});

test('a name-lookup failure sends unnamed rather than blocking', async () => {
  const sent = [];
  const outcome = await sendOwnerMediaParseSummary({
    firmId: 'firm-1', documentId: 'tg_doc_1',
    deps: happyDeps({
      getClientDisplayName: async () => { throw new Error('unavailable'); },
      sendText: async (args) => { sent.push(args); return { ok: true }; }
    })
  });
  assert.equal(outcome.sent, true);
  assert.equal(sent[0].text, 'Read it: Exxon, 42.17 USD, 12 Jul 2026. It is filed.');
});

// ── the album send flow (one combined summary per media group) ───────────

const groupMemberDoc = (id, extra = {}) => ({
  ...baseDoc,
  id,
  payload: {
    ...baseDoc.payload,
    payload: { ...baseDoc.payload.payload, media_group_id: 'album-1' }
  },
  ...extra
});

const groupHappyDeps = (overrides = {}) => happyDeps({
  getOwnerMediaDoc: async () => groupMemberDoc('tg_doc_a'),
  listGroupDocs: async () => [
    groupMemberDoc('tg_doc_a', { vendor_name: 'Exxon Mobil', total_amount: '51.38', currency: 'USD', document_date: '2025-07-28' }),
    groupMemberDoc('tg_doc_b', { vendor_name: 'Exxon Mobil', total_amount: '51.38', currency: 'USD', document_date: '2025-07-29' })
  ],
  listClaimedDocIds: async () => [],
  claimGroupSend: async () => ({ claimed: true }),
  ...overrides
});

test('an album member with a still-parsing sibling waits (group_pending, nothing sent)', async () => {
  const sent = [];
  const outcome = await sendOwnerMediaParseSummary({
    firmId: 'firm-1', documentId: 'tg_doc_a',
    deps: groupHappyDeps({
      listGroupDocs: async () => [
        groupMemberDoc('tg_doc_a'),
        groupMemberDoc('tg_doc_b', { parse_status: 'processing' })
      ],
      sendText: async (args) => { sent.push(args); return { ok: true }; }
    })
  });
  assert.deepEqual(outcome, { sent: false, skipped: 'group_pending' });
  assert.equal(sent.length, 0);
});

test('the last album member to finish sends ONE combined summary and mints per-doc claims', async () => {
  const sent = [];
  const groupClaims = [];
  const docClaims = [];
  const outcome = await sendOwnerMediaParseSummary({
    firmId: 'firm-1', documentId: 'tg_doc_b',
    deps: groupHappyDeps({
      claimGroupSend: async (args) => { groupClaims.push(args); return { claimed: true }; },
      claimSummarySend: async (args) => { docClaims.push(args.documentId); return { claimed: true }; },
      sendText: async (args) => { sent.push(args); return { ok: true }; }
    })
  });
  assert.equal(outcome.sent, true);
  assert.deepEqual(outcome.covered, ['tg_doc_a', 'tg_doc_b']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, [
    'Read 2 documents for Honeybee Hills Apiary LLC:',
    'Exxon Mobil, 51.38 USD, 28 Jul 2025',
    'Exxon Mobil, 51.38 USD, 29 Jul 2025',
    'Total 102.76 USD.',
    'All filed.'
  ].join('\n'));
  assert.equal(groupClaims[0].mediaGroupId, 'album-1');
  assert.equal(groupClaims[0].kind, 'summary');
  assert.deepEqual(docClaims, ['tg_doc_a', 'tg_doc_b']);
});

test('a taken group claim keeps sibling retries silent (exactly-once for the album)', async () => {
  const sent = [];
  const outcome = await sendOwnerMediaParseSummary({
    firmId: 'firm-1', documentId: 'tg_doc_a',
    deps: groupHappyDeps({
      claimGroupSend: async () => ({ claimed: false }),
      sendText: async (args) => { sent.push(args); return { ok: true }; }
    })
  });
  assert.deepEqual(outcome, { sent: false, skipped: 'already_sent' });
  assert.equal(sent.length, 0);
});

test('members already spoken for (inline duplicate reply) are excluded from the combined text', async () => {
  const sent = [];
  const outcome = await sendOwnerMediaParseSummary({
    firmId: 'firm-1', documentId: 'tg_doc_a',
    deps: groupHappyDeps({
      listClaimedDocIds: async () => ['tg_doc_b'],
      sendText: async (args) => { sent.push(args); return { ok: true }; }
    })
  });
  assert.equal(outcome.sent, true);
  assert.deepEqual(outcome.covered, ['tg_doc_a']);
  assert.doesNotMatch(sent[0].text, /29 Jul 2025/);
});

test('a group-path failure degrades to the per-file summary, never silence (the 2026-07-22 miss)', async () => {
  const sent = [];
  const outcome = await sendOwnerMediaParseSummary({
    firmId: 'firm-1', documentId: 'tg_doc_a',
    deps: groupHappyDeps({
      listGroupDocs: async () => { throw new ReferenceError('listOwnerMediaGroupDocsInDb is not defined'); },
      sendText: async (args) => { sent.push(args); return { ok: true }; }
    })
  });
  assert.equal(outcome.sent, true);
  assert.match(sent[0].text, /^Read it: Exxon, 42\.17 USD/);
});

// The 2026-07-22 production miss in one static check: the module's default
// (un-stubbed) DB dependencies are only evaluated in PROD, where deps is
// empty — a referenced-but-unimported firmDb symbol passes node --check,
// passes every stubbed test, and throws a ReferenceError on every real
// invocation. Pin: every *InDb identifier used in the module body appears
// in its firmDb import list.
test('every firmDb identifier the module references is actually imported', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const source = readFileSync(fileURLToPath(new URL('./ownerMediaParseSummary.js', import.meta.url)), 'utf8');
  const importMatch = source.match(/import\s*\{([^}]+)\}\s*from\s*'\.\.\/firmDb\.js'/);
  assert.ok(importMatch, 'firmDb import block exists');
  const imported = new Set(importMatch[1].split(',').map((name) => name.trim()).filter(Boolean));
  const code = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const used = new Set((code.match(/\b\w+InDb\b/g) || []));
  for (const name of used) {
    assert.ok(imported.has(name), `${name} is used but not imported from firmDb.js`);
  }
});

test('a lone registered album member falls through to the single-document summary', async () => {
  const sent = [];
  const outcome = await sendOwnerMediaParseSummary({
    firmId: 'firm-1', documentId: 'tg_doc_a',
    deps: groupHappyDeps({
      listGroupDocs: async () => [groupMemberDoc('tg_doc_a')],
      sendText: async (args) => { sent.push(args); return { ok: true }; }
    })
  });
  assert.equal(outcome.sent, true);
  assert.match(sent[0].text, /^Read it: Exxon, 42\.17 USD/);
});

// ── the terminal-summary sweep (F-2: the fail path is never chat-silent) ──

test('the sweep drives every gathered terminal doc through the send pipeline', async () => {
  const sentFor = [];
  const outcome = await runOwnerMediaTerminalSummarySweep({
    firmId: 'firm-1',
    deps: {
      listDocsNeedingSummary: async ({ firmId, lookbackHours, limit }) => {
        assert.equal(firmId, 'firm-1');
        assert.ok(lookbackHours > 0);
        assert.ok(limit > 0);
        return [
          { id: 'tg_doc_failed', client_id: 'client-1', parse_status: 'failed' },
          { id: 'tg_doc_dup', client_id: 'client-1', parse_status: 'duplicate_pending' }
        ];
      },
      sendSummary: async ({ documentId }) => { sentFor.push(documentId); return { sent: true }; }
    }
  });
  assert.deepEqual(sentFor, ['tg_doc_failed', 'tg_doc_dup']);
  assert.deepEqual(outcome, { swept: 2, sent: 2, skipped: {} });
});

test('the sweep counts typed skips without stopping (gates stay authoritative in the send path)', async () => {
  const outcome = await runOwnerMediaTerminalSummarySweep({
    firmId: 'firm-1',
    deps: {
      listDocsNeedingSummary: async () => [
        { id: 'd1' }, { id: 'd2' }, { id: 'd3' }
      ],
      sendSummary: async ({ documentId }) => (documentId === 'd2'
        ? { sent: true }
        : { sent: false, skipped: 'flag_off' })
    }
  });
  assert.deepEqual(outcome, { swept: 3, sent: 1, skipped: { flag_off: 2 } });
});

test('a gather failure returns a typed summary and never throws', async () => {
  const outcome = await runOwnerMediaTerminalSummarySweep({
    firmId: 'firm-1',
    deps: { listDocsNeedingSummary: async () => { throw new Error('db down'); } }
  });
  assert.deepEqual(outcome, { swept: 0, sent: 0, skipped: {}, gather_failed: true });
});

test('a throwing send is counted and the sweep continues to the next doc', async () => {
  const sentFor = [];
  const outcome = await runOwnerMediaTerminalSummarySweep({
    firmId: 'firm-1',
    deps: {
      listDocsNeedingSummary: async () => [{ id: 'd1' }, { id: 'd2' }],
      sendSummary: async ({ documentId }) => {
        if (documentId === 'd1') throw new Error('broken dep');
        sentFor.push(documentId);
        return { sent: true };
      }
    }
  });
  assert.deepEqual(sentFor, ['d2']);
  assert.deepEqual(outcome, { swept: 2, sent: 1, skipped: { threw: 1 } });
});
