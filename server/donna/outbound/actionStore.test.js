// Action store (M0.3, G2/G10). Mock-pg harness. Pins:
//   - deterministic idempotency key; a duplicate mint dedupes to the row;
//   - mint refuses without a gate verdict; flag_off mints NOTHING; any other
//     block mints a visible 'cancelled' terminal WITH a refusal receipt;
//     hold rests on the owner; auto_execute schedules;
//   - the receipt bar is enforced at the writer: approved_by / authority /
//     model mandatory, outcome from the closed enum;
//   - approval requires a non-system principal; only hold_for_approval flips;
//   - finalize flips executing → executed with the receipt in the same flow
//     (no receipt, no flip); failed records error + receipt;
//   - suppression writer normalizes reason and is idempotent.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOutboundIdempotencyKey, mintOutboundAction, insertOutboundReceipt,
  approveOutboundAction, cancelOutboundAction, finalizeOutboundSend,
  markOutboundActionFailed, addOutboundSuppression, isOutboundSuppressed,
  markExecutedOutboundActionWrong, reverseExecutedOutboundArPost
} from './actionStore.js';

const makeMockClient = (handlers = []) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (text === 'begin' || text === 'commit' || text === 'rollback') return { rows: [], rowCount: 0 };
      for (const h of handlers) {
        if (text.includes(h.match)) {
          if (h.throw) throw h.throw;
          const rows = typeof h.rows === 'function' ? h.rows({ sql: text, params }) : (h.rows || []);
          return { rows, rowCount: rows.length };
        }
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

const audited = (client, action) => client.calls.some(
  (c) => c.sql.includes('insert into audit_events') && (c.params || []).includes(action)
);

const BASE = { firmId: 'firm-1', clientId: 'client-1' };
const MINT_BASE = {
  ...BASE, actionType: 'send_receivable_reminder', targetPartyId: 'p-1',
  anchorType: 'document', anchorId: 'doc-1', packId: 'us',
  template: 'reminder_step_1', language: null, cadenceStep: 1
};

const insertedActionRow = ({ params }) => [{
  id: params[0], firm_id: params[1], client_id: params[2], action_type: params[3],
  target_party_id: params[4], status: params[16], gate_verdict: params[14],
  cancel_reason: params[20], model: params[22], config_snapshot_id: params[23]
}];

test('idempotency key is deterministic over (type, target, anchor, step)', () => {
  const a = buildOutboundIdempotencyKey({
    actionType: 'send_receivable_reminder', targetPartyId: 'p-1',
    anchorType: 'document', anchorId: 'doc-1', cadenceStep: 2
  });
  assert.equal(a, 'send_receivable_reminder:p-1:document:doc-1:step-2');
  assert.equal(a, buildOutboundIdempotencyKey({
    actionType: 'send_receivable_reminder', targetPartyId: 'p-1',
    anchorType: 'document', anchorId: 'doc-1', cadenceStep: 2
  }));
});

test('mint refuses without a gate verdict and on unknown action types', async () => {
  const client = makeMockClient([]);
  await assert.rejects(() => mintOutboundAction(client, { ...MINT_BASE, gate: null }), /gate verdict/);
  await assert.rejects(
    () => mintOutboundAction(client, { ...MINT_BASE, actionType: 'send_spam', gate: { verdict: 'auto_execute' } }),
    /unknown action_type/
  );
});

test('flag_off mints nothing (a dark pipeline is dark)', async () => {
  const client = makeMockClient([]);
  const result = await mintOutboundAction(client, {
    ...MINT_BASE, gate: { verdict: 'blocked', reasons: ['flag_off'], mode: 'off', stage: null }
  });
  assert.equal(result.refused, 'flag_off');
  assert.equal(client.calls.length, 0, 'no insert at all');
});

test('a non-flag block mints a visible cancelled terminal with a refusal receipt', async () => {
  const client = makeMockClient([
    { match: 'insert into outbound_actions', rows: insertedActionRow }
  ]);
  const result = await mintOutboundAction(client, {
    ...MINT_BASE,
    gate: { verdict: 'blocked', reasons: ['recipient_suppressed'], mode: 'act', stage: 'canary', flagKey: 'OUTBOUND_DUNNING' }
  });
  assert.equal(result.action.status, 'cancelled');
  assert.equal(result.action.cancel_reason, 'recipient_suppressed');
  const receipt = client.calls.find((c) => c.sql.includes('insert into outbound_action_receipts'));
  assert.ok(receipt, 'refusal receipted');
  assert.ok(receipt.params.includes('refused'));
  assert.ok(receipt.params.includes('system:gate'));
  assert.ok(audited(client, 'outbound_action.minted'));
});

test('hold rests on the owner; auto_execute schedules; duplicates dedupe', async () => {
  const held = makeMockClient([{ match: 'insert into outbound_actions', rows: insertedActionRow }]);
  const heldResult = await mintOutboundAction(held, {
    ...MINT_BASE, gate: { verdict: 'hold_for_approval', reasons: ['stage_below_auto'], mode: 'act', stage: 'canary' }
  });
  assert.equal(heldResult.action.status, 'hold_for_approval');

  const auto = makeMockClient([{ match: 'insert into outbound_actions', rows: insertedActionRow }]);
  const autoResult = await mintOutboundAction(auto, {
    ...MINT_BASE, gate: { verdict: 'auto_execute', reasons: [], mode: 'act', stage: 'auto' },
    scheduledFor: '2026-08-01T00:00:00Z'
  });
  assert.equal(autoResult.action.status, 'scheduled');

  const dupe = makeMockClient([
    { match: 'insert into outbound_actions', rows: [] },
    { match: 'select * from outbound_actions where firm_id = $1 and client_id = $2 and idempotency_key', rows: [{ id: 'existing' }] }
  ]);
  const dupeResult = await mintOutboundAction(dupe, {
    ...MINT_BASE, gate: { verdict: 'hold_for_approval', reasons: [], mode: 'act', stage: 'canary' }
  });
  assert.equal(dupeResult.deduped, true);
  assert.equal(dupeResult.action.id, 'existing');
  assert.ok(!audited(dupe, 'outbound_action.minted'), 'no duplicate audit');
});

test('the receipt bar is enforced at the writer', async () => {
  const client = makeMockClient([]);
  await assert.rejects(
    () => insertOutboundReceipt(client, {
      ...BASE, actionId: 'a-1', actionType: 'send_receivable_reminder',
      channel: 'email', outcome: 'sent', approvedBy: null, authority: 'x', model: 'm'
    }),
    /mandatory/
  );
  await assert.rejects(
    () => insertOutboundReceipt(client, {
      ...BASE, actionId: 'a-1', actionType: 'send_receivable_reminder',
      channel: 'email', outcome: 'delivered', approvedBy: 'a', authority: 'x', model: 'm'
    }),
    /unknown outcome/
  );
});

test('AR-4E: sent receipt persists exact language, HTML, attachment and versioned fingerprints', async () => {
  const client = makeMockClient([]);
  await insertOutboundReceipt(client, {
    ...BASE, actionId: 'a-1', actionType: 'issue_invoice', targetPartyId: 'p-1',
    channel: 'email', recipient: 'ap@example-ae.example', outcome: 'sent',
    approvedBy: 'owner:kari', authority: 'per_send_owner_approval', model: 'deterministic:pack:ae@v4',
    renderedSubject: 'Invoice', renderedBody: 'plain', renderedHtml: '<html>plain</html>',
    requestedLanguage: 'ar', actualLanguage: 'en', languageSource: 'party_explicit_fallback',
    languageFallbackBasis: 'party_fallback_language:en', correspondenceLocale: 'en-AE',
    templateName: 'invoice_issue', templateCatalogId: 'ae', templateCatalogVersion: 4,
    attachmentManifest: [{ filename: 'invoice.pdf', sha256: 'abc' }],
    contentFingerprint: 'sha256:content', deliveryContractVersion: 2,
    deliveryContractFingerprint: 'sha256:contract'
  });
  const receipt = client.calls.find((call) => call.sql.includes('insert into outbound_action_receipts'));
  assert.match(receipt.sql.replace(/\s+/g, ' '), /rendered_html, attachment_manifest/);
  assert.deepEqual(receipt.params.slice(18), [
    'ar', 'en', 'party_explicit_fallback', 'party_fallback_language:en', 'en-AE',
    'invoice_issue', 'ae', 4, '<html>plain</html>',
    JSON.stringify([{ filename: 'invoice.pdf', sha256: 'abc' }]),
    'sha256:content', 2, 'sha256:contract'
  ]);
});

test('approval requires a non-system principal and only flips hold_for_approval', async () => {
  const client = makeMockClient([
    { match: "set status = 'approved'", rows: ({ params }) => [{ id: params[0], action_type: 'send_receivable_reminder' }] }
  ]);
  await assert.rejects(
    () => approveOutboundAction(client, { ...BASE, actionId: 'a-1', actorType: 'system' }),
    /non-system/
  );
  const approved = await approveOutboundAction(client, {
    ...BASE, actionId: 'a-1', actorType: 'owner', actorId: 'kari'
  });
  assert.ok(approved);
  assert.ok(audited(client, 'outbound_action.approved'));

  const stale = makeMockClient([{ match: "set status = 'approved'", rows: [] }]);
  assert.equal(await approveOutboundAction(stale, { ...BASE, actionId: 'a-1', actorType: 'owner' }), null);
});

test('cancel is terminal and receipted', async () => {
  const client = makeMockClient([
    { match: "set status = 'cancelled'", rows: [{ id: 'a-1', action_type: 'send_receivable_reminder', target_party_id: 'p-1', model: null, config_snapshot_id: null }] }
  ]);
  const cancelled = await cancelOutboundAction(client, {
    ...BASE, actionId: 'a-1', reason: 'already_settled', actorType: 'owner', actorId: 'kari'
  });
  assert.ok(cancelled);
  const receipt = client.calls.find((c) => c.sql.includes('insert into outbound_action_receipts'));
  assert.ok(receipt.params.includes('cancelled'));
  assert.ok(receipt.params.includes('already_settled'));
  assert.ok(audited(client, 'outbound_action.cancelled'));
});

test('finalize flips executing → executed with the receipt together; nothing else flips', async () => {
  const client = makeMockClient([
    { match: "set status = 'executed'", rows: [{ id: 'a-1', action_type: 'send_receivable_reminder', target_party_id: 'p-1', config_snapshot_id: 'cfg-1' }] }
  ]);
  const result = await finalizeOutboundSend(client, {
    ...BASE, actionId: 'a-1',
    receipt: {
      channel: 'email', recipient: 'ap@acme-com.example', approvedBy: 'owner:kari',
      authority: 'per_send_owner_approval', model: 'deterministic:pack:us@v1',
      renderedSubject: 's', renderedBody: 'b', providerMessageId: 'rs-1'
    }
  });
  assert.ok(result.receiptId);
  const receipt = client.calls.find((c) => c.sql.includes('insert into outbound_action_receipts'));
  assert.ok(receipt.params.includes('rs-1'), 'provider message id on the receipt');
  assert.ok(audited(client, 'outbound_action.executed'));

  const notExecuting = makeMockClient([{ match: "set status = 'executed'", rows: [] }]);
  assert.equal(await finalizeOutboundSend(notExecuting, {
    ...BASE, actionId: 'a-1', receipt: { channel: 'email', approvedBy: 'a', authority: 'b', model: 'm' }
  }), null);
});

test('markOutboundActionFailed records the error and a failed receipt', async () => {
  const client = makeMockClient([
    { match: "set status = 'failed'", rows: [{ id: 'a-1', action_type: 'send_receivable_reminder', target_party_id: 'p-1', config_snapshot_id: null }] }
  ]);
  const failed = await markOutboundActionFailed(client, {
    ...BASE, actionId: 'a-1', error: 'provider 500',
    receipt: { channel: 'email', approvedBy: 'config_stage:auto', authority: 'stage:auto:OUTBOUND_DUNNING', model: 'm' }
  });
  assert.ok(failed);
  const receipt = client.calls.find((c) => c.sql.includes('insert into outbound_action_receipts'));
  assert.ok(receipt.params.includes('failed'));
  assert.ok(audited(client, 'outbound_action.failed'));
});

test('suppression writer normalizes reason and value; reader matches', async () => {
  const client = makeMockClient([]);
  const added = await addOutboundSuppression(client, {
    ...BASE, channelKind: 'email', value: ' AP@Acme-com.EXAMPLE ', reason: 'weird_reason'
  });
  assert.equal(added.reason, 'manual');
  assert.equal(added.normalized, 'ap@acme-com.example');
  assert.ok(audited(client, 'outbound_suppression.added'));

  const hit = makeMockClient([{ match: 'from outbound_suppression', rows: [{ 1: 1 }] }]);
  assert.equal(await isOutboundSuppressed(hit, { ...BASE, channelKind: 'email', value: 'ap@acme-com.example' }), true);
  assert.equal(await isOutboundSuppressed(makeMockClient([]), { ...BASE, channelKind: 'email', value: '' }), false);
});

// ── reply_if_wrong: the owner "this was wrong" verb on an executed send ──────

test('mark-wrong requires a non-system principal', async () => {
  const client = makeMockClient([]);
  await assert.rejects(
    () => markExecutedOutboundActionWrong(client, { ...BASE, actionId: 'a-1', actorType: 'system' }),
    /non-system/
  );
  await assert.rejects(
    () => markExecutedOutboundActionWrong(client, { ...BASE, actionId: 'a-1' }),
    /non-system/
  );
  assert.equal(client.calls.length, 0, 'refused before any query');
});

test('mark-wrong records the reply_if_wrong correction INSIDE the writer, guarded to executed + unmarked', async () => {
  const client = makeMockClient([
    { match: 'update outbound_actions', rows: ({ params }) => [{
      id: params[0], action_type: 'send_receivable_reminder', status: 'executed',
      payload: { owner_marked_wrong_at: '2026-07-24T12:00:00Z' }
    }] },
    { match: 'insert into outbound_earned_auto', rows: [{ id: 'ea-1', state: 'counting', clean_streak: 0 }] }
  ]);
  const action = await markExecutedOutboundActionWrong(client, {
    ...BASE, actionId: 'a-1', actorType: 'owner', actorId: 'kari@books.example'
  });
  assert.ok(action, 'the executed row was marked');
  const update = client.calls.find((c) => c.sql.includes('update outbound_actions'));
  assert.ok(update.sql.includes("status = 'executed'"), 'only executed sends can be marked');
  assert.ok(update.sql.includes("(payload->>'owner_marked_wrong_at') is null"),
    'the idempotency marker guards the SAME update — a second click matches zero rows');
  assert.ok(update.sql.includes('owner_marked_wrong_at'), 'the marker is stamped in the same update');
  const correction = client.calls.find((c) => c.sql.includes('insert into outbound_earned_auto'));
  assert.ok(correction, 'the D1 correction is recorded inside the writer — no surface can skip it');
  assert.ok(JSON.stringify(correction.params).includes('reply_if_wrong'),
    'the reserved kind is reply_if_wrong');
  assert.ok(audited(client, 'outbound_action.marked_wrong'));
  // No state change and no receipt: the send happened — this is a correction
  // record, not a cancel.
  assert.ok(!update.sql.includes("set status"), 'the action status is untouched');
  assert.ok(!client.calls.some((c) => c.sql.includes('insert into outbound_action_receipts')));
});

test('a second mark-wrong matches zero rows and records NO second correction', async () => {
  const client = makeMockClient([{ match: 'update outbound_actions', rows: [] }]);
  const result = await markExecutedOutboundActionWrong(client, {
    ...BASE, actionId: 'a-1', actorType: 'owner', actorId: 'kari@books.example'
  });
  assert.equal(result, null);
  assert.ok(!client.calls.some((c) => c.sql.includes('insert into outbound_earned_auto')),
    'no correction on an already-marked (or non-executed) row');
  assert.ok(!audited(client, 'outbound_action.marked_wrong'));
});

test('mark-wrong records the carrying channel in the audit metadata (v2 email replies), absent for v1 clicks', async () => {
  const markHandlers = () => [
    { match: 'update outbound_actions', rows: ({ params }) => [{
      id: params[0], action_type: 'send_receivable_reminder', status: 'executed',
      payload: { owner_marked_wrong_at: '2026-07-24T12:00:00Z' }
    }] },
    { match: 'insert into outbound_earned_auto', rows: [{ id: 'ea-1', state: 'counting', clean_streak: 0 }] }
  ];
  const markedWrongAudit = (client) => client.calls.find((c) =>
    c.sql.includes('insert into audit_events')
    && (c.params || []).includes('outbound_action.marked_wrong'));

  const viaEmail = makeMockClient(markHandlers());
  await markExecutedOutboundActionWrong(viaEmail, {
    ...BASE, actionId: 'a-1', actorType: 'owner', actorId: 'owner@acme-com.example', channel: 'email_reply'
  });
  assert.ok(JSON.stringify(markedWrongAudit(viaEmail).params).includes('email_reply'),
    'the email channel is receipted');

  const viaClick = makeMockClient(markHandlers());
  await markExecutedOutboundActionWrong(viaClick, {
    ...BASE, actionId: 'a-1', actorType: 'owner', actorId: 'kari@books.example'
  });
  assert.ok(!JSON.stringify(markedWrongAudit(viaClick).params).includes('channel'),
    'the v1 workspace click carries no channel key — additive, not a rewrite');
});

// ── post_send_reversal: the owner "undo the books entry" verb (the LAST
// reserved D1 kind — reverses the AR journal, never the send) ────────────────

const reversalHandlers = () => [
  { match: 'update outbound_actions', rows: ({ sql, params }) => (
    sql.includes('ar_post_reversed_at') && sql.includes('jsonb_set')
      && sql.includes("(payload->>'ar_post_reversed_at') is null")
      ? [{
          id: params[0], action_type: 'issue_invoice', status: 'executed',
          payload: { ar_journal_id: 'journal-1', ar_post_reversed_at: '2026-07-25T12:00:00Z' }
        }]
      : [{ id: params[0] }]
  ) },
  { match: 'insert into outbound_earned_auto', rows: [{ id: 'ea-1', state: 'counting', clean_streak: 0 }] }
];

test('reverse-post requires a non-system principal', async () => {
  const client = makeMockClient([]);
  await assert.rejects(
    () => reverseExecutedOutboundArPost(client, { ...BASE, actionId: 'a-1', actorType: 'system' }),
    /non-system/
  );
  await assert.rejects(
    () => reverseExecutedOutboundArPost(client, { ...BASE, actionId: 'a-1' }),
    /non-system/
  );
  assert.equal(client.calls.length, 0, 'refused before any query');
});

test('reverse-post: marker + reversal + D1 correction + audit ride one writer, atomically', async () => {
  const client = makeMockClient(reversalHandlers());
  const reverseCalls = [];
  const result = await reverseExecutedOutboundArPost(client, {
    ...BASE, actionId: 'a-1', actorType: 'owner', actorId: 'kari@books.example',
    impls: { reverseArJournal: async (args) => { reverseCalls.push(args); return { reversal_journal_id: 'journal-rev-1', original_journal_id: 'journal-1' }; } }
  });
  assert.ok(result, 'the executed row was claimed');
  assert.equal(result.reversal.reversal_journal_id, 'journal-rev-1');

  const claim = client.calls.find((c) => c.sql.includes("(payload->>'ar_post_reversed_at') is null"));
  assert.ok(claim, 'the idempotency marker guards the claim UPDATE');
  assert.ok(claim.sql.includes("status = 'executed'"), 'only executed sends');
  assert.ok(claim.sql.includes("action_type = 'issue_invoice'"), 'only invoice sends carry an AR post');
  assert.ok(claim.sql.includes("(payload->>'ar_journal_id') is not null"),
    'a skipped AR leg has nothing to reverse — the claim refuses');

  assert.equal(reverseCalls.length, 1, 'the books motion routed through the firmDb reversal writer');
  assert.equal(reverseCalls[0].arJournalId, 'journal-1');

  const correction = client.calls.find((c) => c.sql.includes('insert into outbound_earned_auto'));
  assert.ok(correction, 'the D1 correction is recorded inside the writer — no surface can skip it');
  assert.ok(JSON.stringify(correction.params).includes('post_send_reversal'),
    'the reserved kind is post_send_reversal');
  assert.ok(audited(client, 'outbound_action.ar_post_reversed'));

  const stampReversalId = client.calls.find((c) => c.sql.includes('ar_reversal_journal_id'));
  assert.ok(stampReversalId, 'the reversal journal id is stamped on the action payload');
});

test('a second reverse-post matches zero rows: no reversal, no second correction', async () => {
  const client = makeMockClient([{ match: 'update outbound_actions', rows: [] }]);
  const reverseCalls = [];
  const result = await reverseExecutedOutboundArPost(client, {
    ...BASE, actionId: 'a-1', actorType: 'owner', actorId: 'kari@books.example',
    impls: { reverseArJournal: async (args) => { reverseCalls.push(args); return {}; } }
  });
  assert.equal(result, null);
  assert.equal(reverseCalls.length, 0, 'the books writer is never touched');
  assert.ok(!client.calls.some((c) => c.sql.includes('insert into outbound_earned_auto')));
  assert.ok(!audited(client, 'outbound_action.ar_post_reversed'));
});

test('a books-side refusal throws OUT of the writer — the caller\'s rollback un-stamps the marker (no correction, no audit)', async () => {
  const client = makeMockClient(reversalHandlers());
  const locked = new Error('Adjustment journal date falls inside a locked period.');
  locked.code = 'LEDGER_ADJUSTMENT_DATE_LOCKED';
  await assert.rejects(
    () => reverseExecutedOutboundArPost(client, {
      ...BASE, actionId: 'a-1', actorType: 'owner', actorId: 'kari@books.example',
      impls: { reverseArJournal: async () => { throw locked; } }
    }),
    (e) => e.code === 'LEDGER_ADJUSTMENT_DATE_LOCKED'
  );
  assert.ok(!client.calls.some((c) => c.sql.includes('insert into outbound_earned_auto')),
    'no correction recorded on a refused reversal');
  assert.ok(!audited(client, 'outbound_action.ar_post_reversed'));
});

// ── G13(b): the fingerprint is stamped BY THE WRITER at approval ─────────────
// Not by the approval surfaces. A surface that forgot to pass one would leave
// the column NULL, and NULL reads as "nothing to compare" — silently no
// protection at all. Same reasoning as editHeldOutboundActionDraft's D1
// recorder living at the writer.

const ISSUANCE_DRAFT = {
  invoice: {
    invoiceNumber: 'INV-2026-0001', currency: 'USD', total: 1500, dueDate: '2026-08-10',
    lines: [{ description: 'May retainer', quantity: 1, unitPrice: 1500, net: 1500 }]
  }
};

const approvalClient = (overrides = []) => makeMockClient([
  ...overrides,
  { match: "set status = 'approved'", rows: ({ params }) => [{ id: params[0], action_type: 'issue_invoice' }] },
  { match: 'from outbound_actions', rows: [{
    action_type: 'issue_invoice', anchor_type: 'issued_invoice',
    anchor_id: 'inv-1', target_party_id: 'p-1',
    pack_id: 'us', template: 'invoice_issue', language: null
  }] },
  { match: 'from issued_invoices', rows: [{ draft: ISSUANCE_DRAFT }] },
  { match: 'from party_channels where firm_id', rows: [
    { id: 'ch-1', channel_kind: 'email', normalized_value: 'ap@acme-com.example', is_primary: true }
  ] }
]);

test('G13(b): approving an issuance action stamps the consequence fingerprint', async () => {
  const client = approvalClient();
  await approveOutboundAction(client, {
    ...BASE, actionId: 'a-1', actorType: 'owner', actorId: 'kari'
  });
  const update = client.calls.find((c) => c.sql.includes("set status = 'approved'"));
  assert.match(update.sql.replace(/\s+/g, ' '), /approved_consequence_fingerprint = \$6/);
  const fingerprint = update.params[5];
  assert.match(fingerprint, /^sha256:[0-9a-f]{64}$/, 'a real fingerprint, not a placeholder');

  // It is the SAME value the executor will re-compute at send — the two ends
  // agree because they call one pure function, not two implementations.
  const { fingerprintIssuanceConsequence } = await import('./consequenceFingerprint.js');
  assert.equal(
    fingerprint,
    fingerprintIssuanceConsequence({ recipient: 'ap@acme-com.example', anchorRow: { draft: ISSUANCE_DRAFT } })
  );

  // And it is in the audit metadata, so "what did they approve" is answerable
  // from the receipt alone.
  const audit = client.calls.find((c) => c.sql.includes('insert into audit_events'));
  assert.match(String(audit.params.at(-1)), /approved_consequence_fingerprint/);
});

test('G13(b): a non-issuance approval stamps NULL (a reminder has no drafted document)', async () => {
  const client = makeMockClient([
    { match: "set status = 'approved'", rows: ({ params }) => [{ id: params[0], action_type: 'send_receivable_reminder' }] },
    { match: 'from outbound_actions', rows: [{
      action_type: 'send_receivable_reminder', anchor_type: 'document',
      anchor_id: 'doc-1', target_party_id: 'p-1',
      pack_id: 'us', template: 'reminder_step_1', language: null
    }] }
  ]);
  await approveOutboundAction(client, {
    ...BASE, actionId: 'a-1', actorType: 'owner', actorId: 'kari'
  });
  const update = client.calls.find((c) => c.sql.includes("set status = 'approved'"));
  assert.equal(update.params[5], null, 'nothing to fingerprint, and we do not invent one');
});

test('G13(b): a consequence fingerprint failure stays soft when the required delivery contract succeeds', async () => {
  // The anchor read throws. The approval must still land — refusing to approve
  // because a GUARD could not be computed would put the owner's decision at the
  // mercy of our own instrumentation.
  let anchorReads = 0;
  const client = approvalClient([{
    match: 'from issued_invoices',
    rows: () => {
      anchorReads += 1;
      if (anchorReads === 1) throw new Error('consequence observer exploded');
      return [{ draft: ISSUANCE_DRAFT }];
    }
  }]);
  const approved = await approveOutboundAction(client, {
    ...BASE, actionId: 'a-1', actorType: 'owner', actorId: 'kari'
  });
  assert.ok(approved, 'the approval still lands');
  const update = client.calls.find((c) => c.sql.includes("set status = 'approved'"));
  assert.equal(update.params[5], null, 'and degrades to the pre-104 no-op, not to a wrong value');
});

test('AR-4E: unsupported requested language blocks approval; explicit fallback stamps the contract', async () => {
  const blocked = approvalClient([{
    match: 'from client_parties',
    rows: [{ preferred_language: 'fr', fallback_language: null }]
  }]);
  await assert.rejects(
    () => approveOutboundAction(blocked, {
      ...BASE, actionId: 'a-1', actorType: 'owner', actorId: 'kari'
    }),
    (error) => error.code === 'OUTBOUND_REQUESTED_LANGUAGE_UNAVAILABLE'
  );
  assert.ok(!blocked.calls.some((call) => call.sql.includes("set status = 'approved'")));

  const allowed = approvalClient([{
    match: 'from client_parties',
    rows: [{ preferred_language: 'fr', fallback_language: 'en' }]
  }]);
  await approveOutboundAction(allowed, {
    ...BASE, actionId: 'a-1', actorType: 'owner', actorId: 'kari'
  });
  const update = allowed.calls.find((call) => call.sql.includes("set status = 'approved'"));
  assert.equal(update.params[6], 2);
  assert.match(update.params[7], /^sha256:[0-9a-f]{64}$/);
});

// ── S5 role events at the writers (roles/roleEvents.js) ──────────────────────
// The role↔owner handoff/resume events are recorded AT the store writers so
// every surface emits them. Laws pinned here: a HIRED lane's hold-resting mint
// and send-time hold record 'role.handed_to_owner'; approve/decline record
// 'role.resumed_from_owner' with the typed outcome; an un-hired lane records
// NOTHING (the S4 never-invent-a-teammate law); a pre-hold cancel records
// nothing (the item never rested on the owner).

const ACTIVE_COLLECTIONS_ASSIGNMENT = {
  match: 'from client_assignments',
  rows: [{
    id: 'role-assign-1', role: 'invoicing_collections',
    principal_type: 'ai_occupant', principal_id: 'donna_ai',
    ai_profile: 'clara', status: 'active'
  }]
};

test('S5: a hold-resting mint on a hired lane records the role handoff (receipt + typed inbox row)', async () => {
  const client = makeMockClient([
    { match: 'insert into outbound_actions', rows: insertedActionRow },
    ACTIVE_COLLECTIONS_ASSIGNMENT
  ]);
  await mintOutboundAction(client, {
    ...MINT_BASE, gate: { verdict: 'hold_for_approval', reasons: ['stage_below_auto'], mode: 'act', stage: 'canary' }
  });
  assert.ok(audited(client, 'role.handed_to_owner'));
  const inbox = client.calls.find((c) => c.sql.includes('insert into loop_event_inbox'));
  assert.ok(inbox, 'the typed trigger row rides the same transaction');
  assert.ok(inbox.params.includes('role.handed_to_owner'));
});

test('S5: an un-hired lane narrates nothing — no role event on any writer', async () => {
  const client = makeMockClient([
    { match: 'insert into outbound_actions', rows: insertedActionRow }
  ]);
  await mintOutboundAction(client, {
    ...MINT_BASE, gate: { verdict: 'hold_for_approval', reasons: ['stage_below_auto'], mode: 'act', stage: 'canary' }
  });
  assert.ok(!audited(client, 'role.handed_to_owner'));
  assert.ok(!client.calls.some((c) => c.sql.includes('insert into loop_event_inbox')));
});

test('S5: a scheduled (auto) mint records no handoff — nothing rested on the owner', async () => {
  const client = makeMockClient([
    { match: 'insert into outbound_actions', rows: insertedActionRow },
    ACTIVE_COLLECTIONS_ASSIGNMENT
  ]);
  await mintOutboundAction(client, {
    ...MINT_BASE, gate: { verdict: 'auto_execute', reasons: [], mode: 'act', stage: 'auto' }
  });
  assert.ok(!audited(client, 'role.handed_to_owner'));
});

test('S5: owner approval records the resume with outcome approved', async () => {
  const client = makeMockClient([
    { match: "set status = 'approved'", rows: ({ params }) => [{ id: params[0], action_type: 'send_receivable_reminder' }] },
    ACTIVE_COLLECTIONS_ASSIGNMENT
  ]);
  await approveOutboundAction(client, {
    ...BASE, actionId: 'a-1', actorType: 'owner', actorId: 'kari'
  });
  assert.ok(audited(client, 'role.resumed_from_owner'));
  const audit = client.calls.find(
    (c) => c.sql.includes('insert into audit_events') && (c.params || []).includes('role.resumed_from_owner')
  );
  const metadata = JSON.parse(audit.params[6]);
  assert.equal(metadata.outcome, 'approved');
  assert.equal(metadata.next_commitment, 'send_on_next_sweep');
});

test('S5: an owner decline of a HELD row records the resume with outcome declined', async () => {
  const client = makeMockClient([
    { match: "set status = 'cancelled'", rows: [{
      id: 'a-1', action_type: 'send_receivable_reminder', target_party_id: 'p-1',
      model: null, config_snapshot_id: null, prior_status: 'hold_for_approval'
    }] },
    ACTIVE_COLLECTIONS_ASSIGNMENT
  ]);
  await cancelOutboundAction(client, {
    ...BASE, actionId: 'a-1', reason: 'owner_declined', actorType: 'owner', actorId: 'kari'
  });
  const audit = client.calls.find(
    (c) => c.sql.includes('insert into audit_events') && (c.params || []).includes('role.resumed_from_owner')
  );
  assert.ok(audit, 'decline records the resume event');
  const metadata = JSON.parse(audit.params[6]);
  assert.equal(metadata.outcome, 'declined');
  assert.equal(metadata.next_commitment, 'closed');
});

test('S5: a system cancel of a HELD row records outcome withdrawn; a pre-hold cancel records nothing', async () => {
  const held = makeMockClient([
    { match: "set status = 'cancelled'", rows: [{
      id: 'a-1', action_type: 'send_receivable_reminder', target_party_id: 'p-1',
      model: null, config_snapshot_id: null, prior_status: 'hold_for_approval'
    }] },
    ACTIVE_COLLECTIONS_ASSIGNMENT
  ]);
  await cancelOutboundAction(held, {
    ...BASE, actionId: 'a-1', reason: 'already_settled', actorType: 'system'
  });
  const heldAudit = held.calls.find(
    (c) => c.sql.includes('insert into audit_events') && (c.params || []).includes('role.resumed_from_owner')
  );
  assert.ok(heldAudit, 'a settled-anchor pullback of a held row is a withdrawal');
  assert.equal(JSON.parse(heldAudit.params[6]).outcome, 'withdrawn');

  const scheduled = makeMockClient([
    { match: "set status = 'cancelled'", rows: [{
      id: 'a-2', action_type: 'send_receivable_reminder', target_party_id: 'p-1',
      model: null, config_snapshot_id: null, prior_status: 'scheduled'
    }] },
    ACTIVE_COLLECTIONS_ASSIGNMENT
  ]);
  await cancelOutboundAction(scheduled, {
    ...BASE, actionId: 'a-2', reason: 'owner_cancelled', actorType: 'owner', actorId: 'kari'
  });
  assert.ok(!audited(scheduled, 'role.resumed_from_owner'), 'never rested on the owner — no resume to record');
});
