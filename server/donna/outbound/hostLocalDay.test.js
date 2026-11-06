// RT-15a acceptance fixture (audit F-11, the day-shift half of the sweep):
// every outbound "today" stamp is the HOST-local calendar day, never the UTC
// day. Each case pins `now` at an instant whose UTC day and host-local day
// differ — 01:30 in Dubai is still the previous day in UTC; 22:30 in New
// York is already the next day in UTC — and asserts the day the owner reads
// on the wall clock: the issue date on a drafted invoice or quote, the
// `today`/`horizon` bounds the payable and receivable detectors hand to SQL.
// Written before the sweep: on the toISOString().slice(0, 10) tree every
// case fails under its non-UTC zone.
//
// The zone is swapped through process.env.TZ per case (Node re-reads TZ on
// change; dates.test.js relies on the same) and restored in `finally`, so
// the file is honest under any CI zone, including the RT-15b matrix entry.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createOutboundInvoiceDraft, createOutboundQuoteDraft } from './issuance.js';
import { detectUpcomingPayables, payableNoticeLeadDays } from './payableNotices.js';
import { detectOverdueReceivables } from './receivableCases.js';
import { loadOutboundPack } from './packs.js';

const FIRM = 'firm-tz';
const CLIENT = 'client-tz';
const pack = loadOutboundPack('us');
const LINES = [{ description: 'Consulting', quantity: 1, unit_price: 500 }];

// 2026-07-24 21:30 UTC is 2026-07-25 01:30 in Dubai (UTC+4).
const DUBAI_EARLY_MORNING = Date.parse('2026-07-24T21:30:00Z');
// 2026-07-25 02:30 UTC is 2026-07-24 22:30 in New York (UTC-4 in July).
const NEW_YORK_LATE_EVENING = Date.parse('2026-07-25T02:30:00Z');

const withTz = async (tz, fn) => {
  const prior = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env.TZ;
    else process.env.TZ = prior;
  }
};

// The narrowest fake pg client the two paths need: the flags at canary so
// the pipeline acts, one client row so the pack resolves, and every other
// read empty. Writes are recorded, never answered with rows the paths
// would then act on.
const makeClient = ({ flags }) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (text.includes('from client_capability_config')) {
        return { rows: flags.map((flag_key) => ({ flag_key, stage: 'canary', source: 'test', client_id: CLIENT })) };
      }
      if (text.includes('from clients where firm_id')) {
        return { rows: [{ company_name: 'Roofline Co', profile: { jurisdiction: 'US', email: 'owner@roofline-co.example' }, jurisdiction: 'US' }] };
      }
      if (text.includes('insert into client_parties')) return { rows: [{ id: 'p-1' }] };
      if (text.includes('from client_parties where firm_id = $1 and client_id = $2 and id = $3')) {
        return { rows: [{ id: 'p-1', display_name: 'Acme LLC', do_not_contact: false, preferred_language: null }] };
      }
      if (text.includes('insert into party_channels') || text.includes('from party_channels where firm_id')) {
        return { rows: [{ id: 'ch-1', channel_kind: 'email', normalized_value: 'ap@acme-com.example', is_primary: true }] };
      }
      if (text.includes('insert into outbound_actions')) {
        return { rows: [{ id: params[0], status: params[16], action_type: params[3], language: params[9], scheduled_for: params[17], cadence_step: params[18], payload: JSON.parse(params[10]) }] };
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

// The draft writers, recording what the pipeline built for the row.
const draftImpls = (built) => ({
  createInvoiceDraft: async (args) => {
    built.invoice = args.buildDraft({ sequence: 1 });
    return { id: 'inv-1', status: 'draft_pending_confirmation', draft: built.invoice.draft, buyer_email: built.invoice.buyerEmail };
  },
  createQuoteDraft: async (args) => {
    built.quote = args.buildDraft({ sequence: 1 });
    return { id: 'quote-1', status: 'draft_pending_confirmation', draft: built.quote.draft, valid_until: built.quote.validUntil };
  },
  markInvoiceIssued: async () => { throw new Error('not reached'); },
  markQuoteSent: async () => { throw new Error('not reached'); }
});

const documentsQuery = (client) => client.calls.find((c) => /from documents d/i.test(c.sql));

test('an invoice drafted at 01:30 Dubai is dated that Dubai day, not the UTC day before', async () => {
  await withTz('Asia/Dubai', async () => {
    const built = {};
    await createOutboundInvoiceDraft(makeClient({ flags: ['OUTBOUND_INVOICING', 'OUTBOUND_PAY_LINKS'] }), {
      firmId: FIRM, clientId: CLIENT, pack, env: {},
      seller: { name: 'Roofline Co' }, buyer: { name: 'Acme LLC', email: 'ap@acme-com.example' },
      lines: LINES, paymentInstructions: 'ACH 123', now: DUBAI_EARLY_MORNING, impls: draftImpls(built)
    });
    assert.equal(built.invoice.draft.invoice.date, '2026-07-25', 'issue date is the host-local day');
    assert.equal(built.invoice.draft.invoice.dueDate, '2026-08-08', 'due date counts from the host-local issue day');
  });
});

test('a quote drafted at 22:30 New York is dated that New York day, not the UTC day after', async () => {
  await withTz('America/New_York', async () => {
    const built = {};
    await createOutboundQuoteDraft(makeClient({ flags: ['OUTBOUND_QUOTES'] }), {
      firmId: FIRM, clientId: CLIENT, pack, env: {},
      seller: { name: 'Roofline Co' }, buyer: { name: 'Acme LLC', email: 'ap@acme-com.example' },
      lines: LINES, validityDays: 30, now: NEW_YORK_LATE_EVENING, impls: draftImpls(built)
    });
    assert.equal(built.quote.draft.quote.date, '2026-07-24', 'issue date is the host-local day');
    assert.equal(built.quote.draft.quote.validUntil, '2026-08-23', 'validity counts from the host-local issue day');
  });
});

test('the payable detector bounds its window on the Dubai day at 01:30 Dubai', async () => {
  await withTz('Asia/Dubai', async () => {
    const client = makeClient({ flags: ['OUTBOUND_PAYABLES'] });
    await detectUpcomingPayables({ client, firmId: FIRM, clientId: CLIENT, env: {}, now: DUBAI_EARLY_MORNING });
    const query = documentsQuery(client);
    assert.ok(query, 'the detector reached its candidate query');
    assert.equal(payableNoticeLeadDays({}), 7);
    assert.equal(query.params[2], '2026-07-25', 'today is the host-local day');
    assert.equal(query.params[3], '2026-08-01', 'the horizon is lead days past the host-local day');
  });
});

test('the receivable detector reads "today" as the New York day at 22:30 New York', async () => {
  await withTz('America/New_York', async () => {
    const client = makeClient({ flags: ['OUTBOUND_DUNNING'] });
    await detectOverdueReceivables({ client, firmId: FIRM, clientId: CLIENT, env: {}, now: NEW_YORK_LATE_EVENING });
    const query = documentsQuery(client);
    assert.ok(query, 'the detector reached its candidate query');
    assert.equal(query.params[2], '2026-07-24', 'today is the host-local day');
  });
});
