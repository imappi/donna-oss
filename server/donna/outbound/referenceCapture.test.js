// Structured reference capture (G12 — the approved post-parse enricher lane,
// Kari 2026-07-24). Pins:
//   - the two-pass extraction: unspaced and space-grouped viitteet capture;
//     invalid runs and embedded-in-longer-run digits do not; two distinct
//     valid references = ambiguity (no capture);
//   - THE AMERICA-FIRST GUARD: a scheme-less pack (the US) exits after one
//     pack resolution — the transactions table is never queried;
//   - flag off = fully dark; shadow = counted would-captures, ZERO writes;
//   - act: single candidate → structured_reference + checked_at; none /
//     ambiguous → checked_at only (idempotence — no line is rescanned);
//   - the capture noise floor equals the settlement matcher's structured
//     disqualification floor (the cross-module contract);
//   - pre-098 databases soft-skip (42703).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureStructuredReferences, extractSchemeReferences,
  captureDocumentStructuredReferences, documentReferenceCandidateText,
  CAPTURE_MIN_DIGITS, REFERENCE_CAPTURE_FLAG_KEY
} from './referenceCapture.js';
import {
  finnishReferenceNumber, isValidFinnishReferenceNumber
} from '../finland/verkkolasku.js';
import { STRUCTURED_REFERENCE_MIN_DIGITS } from '../issuedInvoiceSettlementMath.js';

const FIRM = 'firm-1';
const CLIENT = 'client-1';
const BINDING = { validate: isValidFinnishReferenceNumber };

// Real check-digit references, minted by the KEEP layer — never hand-typed.
const VIITE = finnishReferenceNumber('2026007');      // 8 digits
const OTHER_VIITE = finnishReferenceNumber('9910023'); // 8 digits, distinct

test('the capture noise floor equals the settlement matcher\'s disqualification floor', () => {
  assert.equal(CAPTURE_MIN_DIGITS, STRUCTURED_REFERENCE_MIN_DIGITS,
    'referenceCapture.CAPTURE_MIN_DIGITS must equal issuedInvoiceSettlementMath.STRUCTURED_REFERENCE_MIN_DIGITS');
});

test('extraction: unspaced and space-grouped viitteet capture; noise does not', () => {
  assert.deepEqual(extractSchemeReferences(`MAKSU VIITE ${VIITE} EUR 745,00`, BINDING), [VIITE]);
  // Banks display grouped references — the space-joined pass catches them.
  const spaced = `${VIITE.slice(0, 4)} ${VIITE.slice(4)}`;
  assert.deepEqual(extractSchemeReferences(`Viite: ${spaced}`, BINDING), [VIITE]);
  // The same reference in both forms is ONE distinct candidate.
  assert.deepEqual(extractSchemeReferences(`${VIITE} (viite ${spaced})`, BINDING), [VIITE]);
  // Embedded in a longer run: the longer run is not check-digit valid here,
  // and the embedded digits are never extracted as a standalone candidate.
  const embedded = `1${VIITE}5`;
  if (!isValidFinnishReferenceNumber(embedded)) {
    assert.deepEqual(extractSchemeReferences(`REF ${embedded}`, BINDING), []);
  }
  // Below the noise floor: dropped even if check-digit valid.
  const short = finnishReferenceNumber('123'); // 4 digits
  assert.deepEqual(extractSchemeReferences(`viite ${short}`, BINDING), []);
  // Two distinct valid references → both reported (the caller refuses).
  const two = extractSchemeReferences(`${VIITE} ja ${OTHER_VIITE}`, BINDING);
  assert.equal(two.length, 2);
  assert.deepEqual(extractSchemeReferences('', BINDING), []);
  assert.deepEqual(extractSchemeReferences(`ref ${VIITE}`, {}), [], 'no validator, no candidates');
});

// ── Mock-pg harness (the detector test shape) ────────────────────────────────

const txRow = (over = {}) => ({
  id: 'tx-1', description: `SEPA IN viite ${VIITE}`, raw_description: null,
  source_line: null, contact: null,
  ...over
});

const makeCaptureClient = ({
  stage = 'canary', jurisdiction = 'FI', rows = [txRow()], overrides = []
} = {}) => {
  const calls = [];
  const handlers = [
    ...overrides,
    { match: 'from clients where firm_id', rows: [{ jurisdiction }] },
    { match: 'from client_capability_config', rows: [
      { flag_key: REFERENCE_CAPTURE_FLAG_KEY, stage, source: 'test', client_id: CLIENT }
    ] },
    { match: 'from cohort_capability_config', rows: [] },
    { match: 'from transactions', rows },
    { match: 'update transactions', rows: [] },
    { match: 'insert into audit_events', rows: [] }
  ];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      for (const h of handlers) {
        if (text.includes(h.match)) {
          if (h.throw) throw h.throw;
          const out = typeof h.rows === 'function' ? h.rows({ sql: text, params }) : (h.rows || []);
          return { rows: out, rowCount: out.length };
        }
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

test('act: a single valid viite captures — structured_reference + checked_at in one write', async () => {
  const client = makeCaptureClient({});
  const stats = await captureStructuredReferences({
    client, firmId: FIRM, clientId: CLIENT, env: {}
  });
  assert.equal(stats.scanned, 1, JSON.stringify(stats));
  assert.equal(stats.captured, 1);
  const update = client.calls.find((c) => c.sql.includes('set structured_reference ='));
  assert.ok(update, 'capture write issued');
  assert.equal(update.params[3], VIITE);
  const receipt = client.calls.find((c) => c.sql.includes('insert into audit_events'));
  assert.ok(receipt, 'aggregate capture receipt recorded');
  assert.ok(String(receipt.params[2]).includes('outbound.reference_capture'));
});

test('act: zero or ambiguous candidates stamp checked_at ONLY — never a guessed write', async () => {
  const client = makeCaptureClient({
    rows: [
      txRow({ id: 'tx-none', description: 'CARD PAYMENT 500,00' }),
      txRow({ id: 'tx-two', description: `${VIITE} ja ${OTHER_VIITE}` })
    ]
  });
  const stats = await captureStructuredReferences({
    client, firmId: FIRM, clientId: CLIENT, env: {}
  });
  assert.equal(stats.none_found, 1, JSON.stringify(stats));
  assert.equal(stats.ambiguous, 1);
  assert.equal(stats.captured, 0);
  assert.ok(!client.calls.some((c) => c.sql.includes('set structured_reference =')));
  const stamps = client.calls.filter((c) => c.sql.includes('set structured_reference_checked_at = now()'));
  assert.equal(stamps.length, 2, 'both lines stamped examined');
});

test('AMERICA-FIRST: a scheme-less pack (US) exits after pack resolution — transactions never queried', async () => {
  const client = makeCaptureClient({ jurisdiction: 'US' });
  const stats = await captureStructuredReferences({
    client, firmId: FIRM, clientId: CLIENT, env: {}
  });
  assert.equal(stats.skipped, true);
  assert.equal(stats.reason, 'no_reference_scheme');
  assert.ok(!client.calls.some((c) => c.sql.includes('from transactions')),
    'zero transaction reads for a scheme-less pack');
  assert.ok(!client.calls.some((c) => c.sql.includes('update transactions')));
});

test('flag off: fully dark (config read only)', async () => {
  const client = makeCaptureClient({ stage: 'off' });
  const stats = await captureStructuredReferences({
    client, firmId: FIRM, clientId: CLIENT, env: {}
  });
  assert.equal(stats.skipped, true);
  assert.equal(stats.reason, 'flag_off');
  assert.ok(!client.calls.some((c) => c.sql.includes('from transactions')));
});

test('shadow: would-captures counted with one receipt, ZERO writes (not even checked_at)', async () => {
  const client = makeCaptureClient({ stage: 'shadow' });
  const stats = await captureStructuredReferences({
    client, firmId: FIRM, clientId: CLIENT, env: {}
  });
  assert.equal(stats.shadow_would_capture, 1, JSON.stringify(stats));
  assert.equal(stats.captured, 0);
  assert.ok(!client.calls.some((c) => c.sql.includes('update transactions')), 'shadow mutates nothing');
  const receipt = client.calls.find((c) => c.sql.includes('insert into audit_events'));
  assert.ok(String(receipt.params[2]).includes('would_capture'));
});

test('pre-098 database soft-skips (42703), never throws', async () => {
  const client = makeCaptureClient({
    overrides: [{ match: 'from transactions', throw: Object.assign(new Error('column does not exist'), { code: '42703' }) }]
  });
  const stats = await captureStructuredReferences({
    client, firmId: FIRM, clientId: CLIENT, env: {}
  });
  assert.equal(stats.skipped, true);
  assert.equal(stats.reason, 'tables_absent');
});

// ── The parsed-invoice lane (G12's invoice-side sibling; migration 101) ──────

test('document candidate text excludes every invoice-number source', () => {
  const references = [
    { type: 'invoice_number', value: VIITE },
    { type: 'other', value: OTHER_VIITE },
    { type: 'order_id', value: 'PO-9988' }
  ];
  const text = documentReferenceCandidateText(references);
  assert.ok(!text.includes(VIITE),
    'an invoice_number entry NEVER feeds capture — even one that check-digit-validates');
  assert.ok(text.includes(OTHER_VIITE));
  assert.ok(text.includes('PO-9988'));
  assert.equal(documentReferenceCandidateText(null), '');
  assert.equal(documentReferenceCandidateText('not-an-array'), '');
});

const docRefRow = (over = {}) => ({
  id: 'doc-1',
  extracted_references: [
    { type: 'invoice_number', value: '2026007' },
    { type: 'other', value: VIITE }
  ],
  ...over
});

const makeDocCaptureClient = ({
  stage = 'canary', jurisdiction = 'FI', rows = [docRefRow()], overrides = []
} = {}) => {
  const calls = [];
  const handlers = [
    ...overrides,
    { match: 'from clients where firm_id', rows: [{ jurisdiction }] },
    { match: 'from client_capability_config', rows: [
      { flag_key: REFERENCE_CAPTURE_FLAG_KEY, stage, source: 'test', client_id: CLIENT }
    ] },
    { match: 'from cohort_capability_config', rows: [] },
    { match: 'from documents', rows },
    { match: 'update documents', rows: [] },
    { match: 'insert into audit_events', rows: [] }
  ];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      for (const h of handlers) {
        if (text.includes(h.match)) {
          if (h.throw) throw h.throw;
          const out = typeof h.rows === 'function' ? h.rows({ sql: text, params }) : (h.rows || []);
          return { rows: out, rowCount: out.length };
        }
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

test('doc act: a single valid viite from the parsed references captures with a receipt', async () => {
  const client = makeDocCaptureClient({});
  const stats = await captureDocumentStructuredReferences({
    client, firmId: FIRM, clientId: CLIENT, env: {}
  });
  assert.equal(stats.scanned, 1, JSON.stringify(stats));
  assert.equal(stats.captured, 1);
  const select = client.calls.find((c) => c.sql.includes('from documents'));
  assert.ok(select.sql.includes("document_type = 'sales_invoice'"), 'sales invoices only');
  assert.ok(select.sql.includes('structured_reference_checked_at is null'), 'idempotent work queue');
  const update = client.calls.find((c) => c.sql.includes('set structured_reference ='));
  assert.ok(update, 'capture write issued');
  assert.ok(update.sql.includes('update documents'));
  assert.equal(update.params[3], VIITE);
  const receipt = client.calls.find((c) => c.sql.includes('insert into audit_events'));
  assert.ok(String(receipt.params[2]).includes('outbound.document_reference_capture'));
});

test('doc act: an invoice number that happens to check-digit-validate captures NOTHING', async () => {
  // The exclusion pin: documents.reference_number / invoice_number entries ARE
  // the invoice number (M3's honest line). A viite-valid invoice number must
  // never be stamped as the payment reference — the doc stamps examined-only
  // and the chase keeps resting on the owner.
  const client = makeDocCaptureClient({
    rows: [docRefRow({ extracted_references: [{ type: 'invoice_number', value: VIITE }] })]
  });
  const stats = await captureDocumentStructuredReferences({
    client, firmId: FIRM, clientId: CLIENT, env: {}
  });
  assert.equal(stats.none_found, 1, JSON.stringify(stats));
  assert.equal(stats.captured, 0);
  assert.ok(!client.calls.some((c) => c.sql.includes('set structured_reference =')));
  assert.ok(client.calls.some((c) => c.sql.includes('set structured_reference_checked_at = now()')),
    'examined-only stamp');
});

test('doc act: ambiguity (two distinct valid references) stamps examined-only — never a guessed write', async () => {
  const client = makeDocCaptureClient({
    rows: [docRefRow({
      extracted_references: [
        { type: 'other', value: VIITE },
        { type: 'other', value: OTHER_VIITE }
      ]
    })]
  });
  const stats = await captureDocumentStructuredReferences({
    client, firmId: FIRM, clientId: CLIENT, env: {}
  });
  assert.equal(stats.ambiguous, 1, JSON.stringify(stats));
  assert.equal(stats.captured, 0);
  assert.ok(!client.calls.some((c) => c.sql.includes('set structured_reference =')));
});

test('doc AMERICA-FIRST: a scheme-less pack (US) exits — documents never queried', async () => {
  const client = makeDocCaptureClient({ jurisdiction: 'US' });
  const stats = await captureDocumentStructuredReferences({
    client, firmId: FIRM, clientId: CLIENT, env: {}
  });
  assert.equal(stats.skipped, true);
  assert.equal(stats.reason, 'no_reference_scheme');
  assert.ok(!client.calls.some((c) => c.sql.includes('from documents')),
    'zero document reads for a scheme-less pack');
  assert.ok(!client.calls.some((c) => c.sql.includes('update documents')));
});

test('doc flag off: fully dark; shadow: counted would-captures, ZERO writes', async () => {
  const off = makeDocCaptureClient({ stage: 'off' });
  const offStats = await captureDocumentStructuredReferences({
    client: off, firmId: FIRM, clientId: CLIENT, env: {}
  });
  assert.equal(offStats.skipped, true);
  assert.equal(offStats.reason, 'flag_off');
  assert.ok(!off.calls.some((c) => c.sql.includes('from documents')));

  const shadow = makeDocCaptureClient({ stage: 'shadow' });
  const shadowStats = await captureDocumentStructuredReferences({
    client: shadow, firmId: FIRM, clientId: CLIENT, env: {}
  });
  assert.equal(shadowStats.shadow_would_capture, 1, JSON.stringify(shadowStats));
  assert.equal(shadowStats.captured, 0);
  assert.ok(!shadow.calls.some((c) => c.sql.includes('update documents')), 'shadow mutates nothing');
  const receipt = shadow.calls.find((c) => c.sql.includes('insert into audit_events'));
  assert.ok(String(receipt.params[2]).includes('outbound.document_reference_capture_would_capture'));
});

test('doc pre-101 database soft-skips (42703), never throws', async () => {
  const client = makeDocCaptureClient({
    overrides: [{ match: 'from documents', throw: Object.assign(new Error('column does not exist'), { code: '42703' }) }]
  });
  const stats = await captureDocumentStructuredReferences({
    client, firmId: FIRM, clientId: CLIENT, env: {}
  });
  assert.equal(stats.skipped, true);
  assert.equal(stats.reason, 'tables_absent');
});
