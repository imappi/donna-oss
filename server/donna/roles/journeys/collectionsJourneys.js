// Donna — the invoicing_collections JOURNEY TESTS (S6's
// `required_journey_tests`, docs/design-donna-specialist-roles.md §5).
//
// WHAT A JOURNEY IS HERE. The R1 certification manifest
// (roles/roleCertification.js) declares two end-to-end runs by id. Until now
// they were DECLARED-BUT-UNBUILT: the gate read red with `journey_run_missing`,
// deliberately, so nothing could claim Autonomous on a role whose whole
// production loop had never been driven once. These are those two runs.
//
// A journey is not a unit test with more steps. Its subject is the HANDOFF
// BETWEEN SEAMS: the executor claims the row the pay-link sweep saw, the
// webhook cancels the reminder the cadence actually scheduled, the case reaches
// its terminal because the real writers put it there. Everything runs against
// ONE stateful substrate (journeySubstrate.js) so no stage is handed fixtures
// the previous stage did not actually write.
//
// THE TWO-TERMINAL-STATES CHECK IS THE POINT. Each journey ends by asserting
// the CLAUDE.md first principle over its own wreckage: every row it touched
// rests either DONE (settled/executed/cancelled-with-a-receipt) or ON THE OWNER
// (escalated, hold_for_approval) — never in a firm-side limbo. A journey that
// merely proved "the send went out" would miss the thing certification is for.
//
// HONESTY RULES (the modelLaneGate discipline, applied to a test harness):
//   - the gate is PASS only when every check passed, the substrate modelled
//     every statement (`unrouted` empty — several modules soft-fail their reads,
//     so an unmodelled query would otherwise read as an innocent empty set),
//     and nothing threw;
//   - external PROVIDERS are faked at their boundary (Stripe, the email
//     deliverer) because they are not Donna; no Donna module is ever faked;
//   - what the run could not exercise is RECORDED as an observation in the
//     report, never quietly dropped — a journey's silence about a gap is the
//     failure mode certification exists to prevent;
//   - model ids ride from the receipts the run produced, never from code.
//
// The report this produces is what `scripts/run_role_certification.js --journey
// <id>=<path>` consumes; the gather refuses a report that does not declare the
// ROLE_JOURNEY_RUN_ARTIFACT kind (2026-08-15 — before that it read
// `gate === 'PASS'` and nothing else, so a hand-authored blob passed), a
// report whose own `journey` id is not the one it is supplied under
// (2026-08-16 — before that a real passing report for one journey could stand
// in for the other), and a report stamped at a different role-runtime vintage
// (2026-08-16 — evidence must not outlive the runtime it certifies), then the
// gate reads `gate === 'PASS'`.

import { executeDueOutboundActions } from '../../outbound/actionExecutor.js';
import { buildOutboundInvoiceModel } from '../../outbound/issuance.js';
import { loadOutboundPack } from '../../outbound/packs.js';
import { applyPayLinkWebhookEvent, ensureOutboundPayLinks } from '../../outbound/payLinks.js';
import { detectOverdueReceivables } from '../../outbound/receivableCases.js';
import { CURRENT_ROLE_RUNTIME_VERSION, ROLE_JOURNEY_RUN_ARTIFACT } from '../roleCertification.js';
import { createJourneySubstrate } from './journeySubstrate.js';
import { toLocalIsoDay } from '../../dates.js';

// The kind is named in roleCertification.js (the gather refuses any other),
// re-exported here so report producers and tests keep one import — the
// leashTestRun.js pattern.
export { ROLE_JOURNEY_RUN_ARTIFACT };

const FIRM = 'firm-journey';
const CLIENT = 'client-journey';
const PACK = 'gb'; // the R1 manifest certifies invoicing_collections × GB
const BASE_ENV = { OUTBOUND_PUBLIC_BASE_URL: 'https://donna.test' };

// ── The run recorder ────────────────────────────────────────────────────────

const createRun = ({ id, description, now }) => {
  const steps = [];
  const observations = [];
  let current = null;
  const api = {
    step(name) {
      current = { step: name, checks: [] };
      steps.push(current);
      return current;
    },
    check(name, ok, detail = null) {
      if (!current) api.step('preamble');
      current.checks.push({ check: name, status: ok ? 'pass' : 'fail', detail });
      return Boolean(ok);
    },
    // Something the run deliberately did not (or could not) exercise. Recorded
    // in the report so a reader sees the edge of the evidence.
    observe(note) {
      observations.push(String(note));
    },
    report({ substrate, evidence = {}, error = null }) {
      const failures = [];
      for (const entry of steps) {
        for (const check of entry.checks) {
          if (check.status !== 'pass') failures.push(`${entry.step}: ${check.check}${check.detail ? ` (${check.detail})` : ''}`);
        }
      }
      const unrouted = substrate?.unrouted ?? [];
      for (const sql of unrouted) failures.push(`substrate could not model a statement: ${sql}`);
      if (error) failures.push(`threw: ${error?.message || String(error)}`);
      return {
        artifact: ROLE_JOURNEY_RUN_ARTIFACT,
        journey: id,
        description,
        runtime_version: CURRENT_ROLE_RUNTIME_VERSION,
        role: 'invoicing_collections',
        jurisdiction: 'GB',
        produced_at: new Date(now).toISOString(),
        clock: new Date(now).toISOString(),
        gate: failures.length ? 'FAIL' : 'PASS',
        steps,
        failures,
        observations,
        evidence
      };
    }
  };
  return api;
};

// ── Shared seed ─────────────────────────────────────────────────────────────
// A production-shaped GB client: one owner business, one counterparty with an
// email channel, the collections lane hired to Clara (the bench's first hire),
// and the outbound stages a canary client actually runs at.

const seedTables = ({ stages = {}, extra = {} } = {}) => ({
  clients: [{
    id: CLIENT, firm_id: FIRM, company_name: 'Roofline Ltd', jurisdiction: 'GB',
    profile: {
      jurisdiction: 'GB',
      payment_instructions: 'Faster Payments sort 04-00-04, account 12345678',
      owner_email: 'owner@roofline.test',
      accounting_basis: 'accrual',
      stripe_account_id: 'acct_journey_roofline'
    }
  }],
  client_capability_config: Object.entries({
    OUTBOUND_DUNNING: 'canary', ...stages
  }).map(([flag_key, stage]) => ({
    firm_id: FIRM, client_id: CLIENT, flag_key, stage, source: 'journey', valid_to: null
  })),
  client_parties: [{
    id: 'party-brickworth', firm_id: FIRM, client_id: CLIENT,
    display_name: 'Brickworth Ltd', normalized_name: 'brickworth ltd', status: 'active',
    do_not_contact: false, preferred_language: null, is_customer: true
  }],
  party_channels: [{
    id: 'channel-brickworth', firm_id: FIRM, client_id: CLIENT, party_id: 'party-brickworth',
    channel_kind: 'email', normalized_value: 'ap@brickworth.test',
    is_primary: true, valid_until: null
  }],
  // The bench's first hire (S2/S4): the collections lane belongs to an ACTIVE
  // ai_occupant, which is what makes the role events in journey 2 record at all.
  client_assignments: [{
    id: 'assignment-clara', firm_id: FIRM, client_id: CLIENT,
    role: 'invoicing_collections', assignment_kind: 'specialist_role', status: 'active',
    principal_type: 'ai_occupant', principal_id: 'donna_ai', ai_profile: 'clara'
  }],
  ...extra
});

// Reads with joins, subqueries or jsonb paths that the substrate's generic
// layer does not model. Each projects LIVE state (never a fixture), so the
// candidate lists a sweep sees are the rows the previous stage actually wrote.
// First match wins: the gap-resolution scan MUST sit before the
// 'from receivable_cases rc' pay-links route, because its statement contains
// that fragment too and would otherwise be handed a pay-link candidate shape.
const substrateRoutes = () => [
  {
    // The shared coding/posting context probes canonical native lineage even
    // for this unmarked GB book. Model the live client projection explicitly;
    // the generic SQL substrate cannot evaluate PostgreSQL to_char.
    match: "as birth_created_at from clients where firm_id=$1 and id=$2",
    rows: ({ state, params }) => (state.clients || [])
      .filter((row) => row.firm_id === params[0] && row.id === params[1])
      .map((row) => ({ ...row, birth_created_at: row.created_at == null ? null
        : new Date(row.created_at).toISOString().replace(/Z$/, '000Z') }))
  },
  {
    // Preserve resource/firm/action scoping and numeric receipt order. This
    // journey has no native birth events; do not manufacture an empty response.
    match: 'from audit_events where firm_id=$1 and resource_id=$2 and action = any($3::text[]) order by audit_events.id',
    rows: ({ state, params }) => (state.audit_events || [])
      .filter((row) => row.firm_id === params[0] && row.resource_id === params[1] && params[2].includes(row.action))
      .sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0)
      .map((row) => ({ ...row, id: String(row.id) }))
  },
  {
    // The retained-scope owner also reads the persisted hosted-review receipt
    // (`pilot.prepared`, F-2). Same scoping and current-life fence as production;
    // this journey's client was not born through a hosted-review intake, so the
    // projection over state.audit_events is honestly empty.
    match: "from audit_events where firm_id=$1 and resource_id=$2 and action='pilot.prepared'",
    rows: ({ state, params }) => (state.audit_events || [])
      .filter((row) => row.firm_id === params[0] && row.resource_id === params[1] && row.action === 'pilot.prepared'
        && (row.metadata?.processing_scope === 'document_processing_review_only'
          || row.metadata?.authority_basis === 'authenticated_singapore_firm_creation'))
      .filter((row) => !(state.audit_events || []).some((d) => d.firm_id === params[0] && d.resource_id === params[1]
        && d.action === 'client.delete' && BigInt(d.id) > BigInt(row.id)))
      .sort((a, b) => BigInt(b.id) < BigInt(a.id) ? -1 : 1).slice(0, 1)
      .map((row) => ({ id: String(row.id), metadata: row.metadata }))
  },
  {
    // Invoice send revalidates current country before choosing a statutory
    // floor. Project the same live identity; the journey has no concurrency.
    match: 'select * from clients where firm_id = $1 and id = $2 for share',
    rows: ({ state, params }) => (state.clients || [])
      .filter((row) => row.firm_id === params[0] && row.id === params[1])
  },
  {
    // readClientConfigSnapshot's cohort layer. No cohort membership in a
    // journey seed, so this is genuinely empty — modelled rather than left
    // unrouted, because the caller soft-fails and would hide the difference.
    match: 'from cohort_capability_config cc',
    rows: () => []
  },
  {
    // detectOverdueReceivables' client identity read: the jurisdiction rides
    // the profile. Routed because the generic projection cannot model the
    // jsonb coalesce — and a silently-null jurisdiction would skip the whole
    // detector as 'no_pack_for_jurisdiction' while the journey reads green.
    match: "coalesce(profile->>'jurisdiction', jurisdiction)",
    rows: ({ state, params }) => (state.clients || [])
      .filter((row) => row.firm_id === params[0] && row.id === params[1])
      .map((row) => ({
        company_name: row.company_name ?? null,
        profile: row.profile ?? null,
        jurisdiction: row.profile?.jurisdiction ?? row.jurisdiction ?? null
      }))
  },
  {
    // The detector's gap-resolution re-mint scan: open step-0 cases with a
    // named gap, joined to their anchors. Projects live case rows; empty when
    // every case minted cleanly, which is the honest read, not a stub.
    match: 'left join issued_invoices ii',
    rows: ({ state, params }) => (state.receivable_cases || [])
      .filter((row) => row.firm_id === params[0] && row.client_id === params[1])
      .filter((row) => row.status === 'open' && Number(row.current_step || 0) === 0 && row.status_reason != null)
      .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
      .slice(0, Number(params[2]) || 25)
      .map((row) => {
        const doc = (state.documents || []).find((d) =>
          row.anchor_type === 'document' && d.id === row.anchor_id
          && d.firm_id === row.firm_id && d.client_id === row.client_id) || null;
        const inv = (state.issued_invoices || []).find((i) =>
          row.anchor_type === 'issued_invoice' && i.id === row.anchor_id
          && i.firm_id === row.firm_id && i.client_id === row.client_id) || null;
        return {
          case_id: row.id, anchor_type: row.anchor_type, anchor_id: row.anchor_id,
          status_reason: row.status_reason,
          doc_customer_name: doc?.customer_name ?? null,
          doc_reference_number: doc?.reference_number ?? null,
          doc_structured_reference: doc?.structured_reference ?? null,
          doc_total_amount: doc?.total_amount ?? null,
          doc_currency: doc?.currency ?? null,
          doc_due_date: doc?.due_date ?? null,
          inv_buyer_name: inv?.buyer_name ?? null,
          inv_buyer_email: inv?.buyer_email ?? null,
          inv_invoice_number: inv?.draft?.invoice?.invoiceNumber ?? null,
          inv_total_amount: inv ? Number(inv.draft?.invoice?.total ?? 0) : null,
          inv_currency: inv?.draft?.invoice?.currency ?? null,
          inv_due_date: inv?.draft?.invoice?.dueDate ?? null,
          inv_reference_number: inv?.draft?.finvoice?.invoiceDetails?.referenceNumber
            ?? inv?.draft?.finvoice?.paymentDetails?.referenceNumber
            ?? inv?.draft?.invoice?.referenceNumber ?? null
        };
      })
  },
  {
    // The detector's parsed-document candidate lane (aliased + a not-exists
    // dedupe subquery). Journey 1 seeds no documents, so this projects empty —
    // honestly: the SAME predicates production applies, over live state.
    match: 'from documents d',
    rows: ({ state, params }) => (state.documents || [])
      .filter((row) => row.firm_id === params[0] && row.client_id === params[1])
      .filter((row) => row.document_type === 'sales_invoice')
      .filter((row) => (row.parse_status ?? 'completed') === 'completed')
      .filter((row) => row.payment_status === 'unpaid')
      .filter((row) => row.due_date != null && String(row.due_date) < String(params[2]))
      .filter((row) => Number(row.total_amount || 0) > 0)
      .filter((row) => !(state.receivable_cases || []).some((rc) =>
        rc.firm_id === row.firm_id && rc.client_id === row.client_id
        && rc.anchor_type === 'document' && rc.anchor_id === row.id))
      .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)))
      .slice(0, Number(params[3]) || 25)
      .map((row) => ({
        id: row.id, customer_name: row.customer_name ?? null, due_date: row.due_date,
        total_amount: row.total_amount, currency: row.currency,
        reference_number: row.reference_number ?? null,
        structured_reference: row.structured_reference ?? null
      }))
  },
  {
    // The detector's issued-invoice candidate lane (the M2 opener the
    // 2026-08-15 run report wrongly recorded as missing — this route is what
    // lets journey 1 DRIVE it). Same predicates as production, live rows.
    match: 'from issued_invoices ii',
    rows: ({ state, params }) => (state.issued_invoices || [])
      .filter((row) => row.firm_id === params[0] && row.client_id === params[1])
      .filter((row) => row.status === 'issued' && (row.kind ?? 'invoice') === 'invoice')
      .filter((row) => {
        const due = row.draft?.invoice?.dueDate;
        return due != null && String(due) < String(params[2]);
      })
      .filter((row) => Number(row.draft?.invoice?.total ?? 0) > 0)
      .filter((row) => !(state.receivable_cases || []).some((rc) =>
        rc.firm_id === row.firm_id && rc.client_id === row.client_id
        && rc.anchor_type === 'issued_invoice' && rc.anchor_id === row.id))
      .sort((a, b) => String(a.draft?.invoice?.dueDate).localeCompare(String(b.draft?.invoice?.dueDate)))
      .slice(0, Number(params[3]) || 25)
      .map((row) => ({
        id: row.id, buyer_name: row.buyer_name ?? null, buyer_email: row.buyer_email ?? null,
        invoice_number: row.draft?.invoice?.invoiceNumber ?? null,
        due_date: row.draft?.invoice?.dueDate ?? null,
        currency: row.draft?.invoice?.currency ?? null,
        total_amount: Number(row.draft?.invoice?.total ?? 0),
        reference_number: row.draft?.finvoice?.invoiceDetails?.referenceNumber
          ?? row.draft?.finvoice?.paymentDetails?.referenceNumber
          ?? row.draft?.invoice?.referenceNumber ?? null
      }))
  },
  {
    // cancelOutboundAction's guarded CTE (status flip + prior_status). A WRITE
    // route: it applies the statement's own semantics to live state — the
    // status guard is the statement's, the substrate still decides nothing.
    match: 'with prior as',
    rows: ({ state, params, nowIso }) => {
      const row = (state.outbound_actions || []).find((candidate) =>
        candidate.id === params[0] && candidate.firm_id === params[1] && candidate.client_id === params[2]);
      if (!row || !['scheduled', 'hold_for_approval', 'approved'].includes(row.status)) return [];
      const prior = row.status;
      row.status = 'cancelled';
      row.cancel_reason = String(params[3] ?? 'unspecified');
      row.updated_at = nowIso();
      return [{ ...row, prior_status: prior }];
    }
  },
  {
    // The ledger post path's duplicate + locked-period guard (a left join the
    // generic layer does not model). Projects live journals; the close-period
    // column stays null because a journey seeds no locked period — modelled so
    // the guard genuinely runs rather than being skipped.
    match: 'from ledger_journals lj',
    rows: ({ state, params }) => (state.ledger_journals || [])
      .filter((row) => row.firm_id === params[0] && row.client_id === params[1]
        && row.source_type === params[2] && row.source_id === params[3])
      .slice(0, 1)
      .map((row) => ({
        id: row.id, status: row.status, journal_date: row.journal_date,
        close_period_id: (state.close_periods || []).find((period) =>
          period.firm_id === row.firm_id && period.client_id === row.client_id
          && period.status === 'locked'
          && period.period_start <= row.journal_date && period.period_end >= row.journal_date)?.id ?? null
      }))
  },
  {
    // ensureOutboundPayLinks candidate source 1: open cases with no link yet.
    match: 'from receivable_cases rc',
    rows: ({ state }) => (state.receivable_cases || [])
      .filter((row) => row.firm_id === FIRM && row.client_id === CLIENT && row.status === 'open')
      .filter((row) => Number(row.amount || 0) > 0 && row.currency)
      .filter((row) => !(state.outbound_payment_links || []).some((link) =>
        link.firm_id === row.firm_id && link.client_id === row.client_id
        && link.anchor_type === row.anchor_type && link.anchor_id === row.anchor_id))
      .map((row) => ({
        id: row.id, anchor_type: row.anchor_type, anchor_id: row.anchor_id,
        invoice_number: row.invoice_number ?? null, amount: row.amount, currency: row.currency
      }))
  },
  {
    // ensureOutboundPayLinks candidate source 2: pending issue_invoice actions
    // with no link yet (an invoice on the pay-links block needs its link BEFORE
    // the issue email renders).
    match: 'from outbound_actions a',
    rows: ({ state }) => (state.outbound_actions || [])
      .filter((row) => row.firm_id === FIRM && row.client_id === CLIENT)
      .filter((row) => row.action_type === 'issue_invoice')
      .filter((row) => ['hold_for_approval', 'scheduled', 'approved'].includes(row.status))
      .filter((row) => Number(row.amount || 0) > 0 && row.currency)
      .filter((row) => !(state.outbound_payment_links || []).some((link) =>
        link.firm_id === row.firm_id && link.client_id === row.client_id
        && link.anchor_type === row.anchor_type && link.anchor_id === row.anchor_id))
      .map((row) => ({
        id: row.id, anchor_type: row.anchor_type, anchor_id: row.anchor_id,
        invoice_number: row.payload?.render_values?.invoice_number ?? null,
        amount: row.amount, currency: row.currency
      }))
  }
];

// The external boundary, faked because it is NOT Donna: a Stripe double that
// records what was asked of it, and an email deliverer that captures the exact
// rendered content the receipt will also carry.
const createProviders = () => {
  const sent = [];
  const stripeCalls = [];
  let linkSequence = 0;
  const stripe = {
    paymentLinks: {
      create: async (params, options) => {
        linkSequence += 1;
        stripeCalls.push({ params, options });
        return { id: `plink_journey_${linkSequence}`, url: `https://pay.stripe.test/plink_journey_${linkSequence}` };
      }
    },
    prices: {
      create: async (params, options) => {
        stripeCalls.push({ params, options });
        return { id: `price_journey_${stripeCalls.length}` };
      }
    },
    products: {
      create: async (params, options) => {
        stripeCalls.push({ params, options });
        return { id: `prod_journey_${stripeCalls.length}` };
      }
    }
  };
  return {
    sent,
    stripeCalls,
    stripeFactory: async () => stripe,
    deliverers: {
      email: async ({ recipient, subject, body }) => {
        sent.push({ recipient, subject, body });
        return { providerMessageId: `msg-journey-${sent.length}` };
      }
    }
  };
};

// ── Shared assertions ───────────────────────────────────────────────────────

// Terminal statuses per the two-terminal-states principle, read over the rows
// the journey actually produced.
const OUTBOUND_DONE = ['executed', 'cancelled'];
const OUTBOUND_ON_OWNER = ['hold_for_approval'];
const CASE_DONE = ['settled', 'stopped'];
const CASE_ON_OWNER = ['escalated', 'paused', 'disputed'];

const assertNothingRestsFirmSide = (run, substrate) => {
  const stranded = substrate.rows('outbound_actions').filter((row) =>
    ![...OUTBOUND_DONE, ...OUTBOUND_ON_OWNER].includes(row.status));
  run.check(
    'two_terminal_states_outbound',
    stranded.length === 0,
    stranded.length
      ? `${stranded.length} action(s) rest firm-side: ${stranded.map((r) => `${r.id}=${r.status}`).join(', ')}`
      : 'every outbound action rests done or on the owner'
  );
  const cases = substrate.rows('receivable_cases');
  const restingCases = cases.filter((row) => ![...CASE_DONE, ...CASE_ON_OWNER].includes(row.status));
  run.check(
    'two_terminal_states_cases',
    restingCases.length === 0,
    restingCases.length
      ? `${restingCases.length} case(s) rest firm-side: ${restingCases.map((r) => `${r.id}=${r.status}`).join(', ')}`
      : 'every receivable case rests done or on the owner'
  );
};

// INV-S7: every claimed send names which role's leash covered it.
const leashCheckOn = (receipt) =>
  (receipt?.checks || []).find((check) => check.check === 'role_leash') || null;

const sentReceipts = (substrate) =>
  substrate.rows('outbound_action_receipts').filter((row) => row.outcome === 'sent');

const modelIdsFromReceipts = (substrate) =>
  [...new Set(substrate.rows('outbound_action_receipts').map((row) => row.model).filter(Boolean))].sort();

// ── Journey 1 — invoice to settlement ───────────────────────────────────────

const runInvoiceToSettlement = async ({ now, logger }) => {
  const id = 'journey.collections.invoice-to-settlement.v1';
  const description = 'issue → send → overdue sweep opens the chase → pay-link settlement cancels it → receivable case terminal, production-shaped';
  const run = createRun({ id, description, now });
  const providers = createProviders();
  // Host-local days, as the outbound pipeline under test stamps them.
  const issueDate = toLocalIsoDay(now);
  const dueDate = toLocalIsoDay(now + 30 * 86_400_000);

  const pack = loadOutboundPack(PACK);
  const built = buildOutboundInvoiceModel({
    pack,
    // taxRegistered is TRI-STATE and the GB floor refuses on unknown; a small
    // owner below the VAT threshold is the honest journey subject, so it is
    // RECORDED as false rather than left null.
    seller: { name: 'Roofline Ltd', taxRegistered: false, address: '4 Kiln Row, Leeds LS1 1AA' },
    buyer: { name: 'Brickworth Ltd', address: '12 Wharf Street, Leeds LS2 7EQ' },
    lines: [{ description: 'Roof survey and report', quantity: 1, unit_price: 1250 }],
    invoiceNumber: '2026001', date: issueDate, dueDate, taxTotal: 0,
    // The GB statutory floor requires the time of supply as its own fact; the
    // builder refuses to default it from the issue date. A survey delivered on
    // the day it is invoiced makes them equal — stated, not inferred.
    supplyDate: issueDate,
    paymentInstructionsResolved: true
  });
  if (!built.ok) {
    // A seed the real builder refuses is a broken journey, not a red gate for
    // the code under test — say so plainly instead of running on a null draft.
    throw new Error(`journey seed invalid: buildOutboundInvoiceModel refused it (${built.errors.join('; ')})`);
  }
  const builtInvoice = built.invoice;

  const substrate = createJourneySubstrate({
    now,
    routes: substrateRoutes(),
    tables: seedTables({
      stages: { OUTBOUND_INVOICING: 'canary', OUTBOUND_PAY_LINKS: 'canary' },
      extra: {
        // The client's own chart, role-resolved: the AR leg refuses by NAME
        // without these two, so a journey that omitted them would prove the
        // send and quietly skip the books.
        ledger_accounts: [
          {
            id: 'acct-ar', firm_id: FIRM, client_id: CLIENT, status: 'active',
            canonical_role: 'asset.accounts_receivable', code: '1100',
            name: 'Trade debtors', account_type: 'asset', normal_balance: 'debit',
            currency: 'GBP', tax_type: null
          },
          {
            id: 'acct-revenue', firm_id: FIRM, client_id: CLIENT, status: 'active',
            canonical_role: 'revenue.operating', code: '4000',
            name: 'Sales', account_type: 'revenue', normal_balance: 'credit',
            currency: 'GBP', tax_type: null
          }
        ],
        // The issuance anchor as createOutboundInvoiceDraft leaves it: a draft
        // awaiting the owner's confirmation, carrying the invoice model the AR
        // leg reads. Built by the REAL builder (buildOutboundInvoiceModel over
        // the real GB pack) rather than hand-written — a hand-written draft
        // would drift from the shape production actually persists, and the
        // journey would then certify against a fiction.
        issued_invoices: [{
          id: 'issued-2026001', firm_id: FIRM, client_id: CLIENT,
          status: 'draft_pending_confirmation', kind: 'invoice', invoice_number: '2026001',
          buyer_name: 'Brickworth Ltd', buyer_email: 'ap@brickworth.test',
          target_party_id: 'party-brickworth', currency: 'GBP', total: 1250,
          draft: { invoice: builtInvoice }
        }],
        outbound_actions: [{
          id: 'action-issue', firm_id: FIRM, client_id: CLIENT,
          action_type: 'issue_invoice', target_party_id: 'party-brickworth',
          anchor_type: 'issued_invoice', anchor_id: 'issued-2026001', pack_id: PACK,
          template: 'invoice_issue', language: null,
          payload: {
            due_date: dueDate,
            render_values: {
              owner_business_name: 'Roofline Ltd', counterparty_name: 'Brickworth Ltd',
              invoice_number: '2026001', invoice_total: '1,250.00', currency: 'GBP',
              issue_date: issueDate, due_date: dueDate,
              lines_block: 'Roof survey and report — 1,250.00 GBP',
              payment_instructions: 'Faster Payments sort 04-00-04, account 12345678'
            }
          },
          amount: 1250, currency: 'GBP', confidence: 0.95,
          status: 'approved', approved_by_actor_type: 'owner', approved_by_actor_id: 'kari',
          scheduled_for: new Date(now - 3_600_000).toISOString(), cadence_step: 0,
          model: null, config_snapshot_id: null,
          approval_token: 'approval-issue', unsubscribe_token: 'unsub-issue',
          gate_basis: {}, created_at: new Date(now - 86_400_000).toISOString()
        }]
      }
    })
  });

  let error = null;
  try {
    // ── Step 1: the pay-link sweep runs BEFORE the send (production order:
    //    detect → ensure → execute), so the issue email can carry the link.
    run.step('pay_link_ensured_before_send');
    const linkStats = await ensureOutboundPayLinks({
      client: substrate, firmId: FIRM, clientId: CLIENT,
      env: { ...BASE_ENV, STRIPE_SECRET_KEY: 'sk_journey' },
      stripeFactory: providers.stripeFactory, logger
    });
    run.check('sweep_considered_the_pending_invoice', linkStats.considered === 1, JSON.stringify(linkStats));
    run.check('link_created', linkStats.created === 1, JSON.stringify(linkStats));
    const link = substrate.rows('outbound_payment_links')[0] || null;
    run.check('link_row_persisted_active', link?.status === 'active', link ? `status=${link.status}` : 'no link row');
    run.check(
      'link_anchored_to_the_invoice',
      link?.anchor_type === 'issued_invoice' && link?.anchor_id === 'issued-2026001',
      link ? `${link.anchor_type}:${link.anchor_id}` : 'no link row'
    );

    // ── Step 2: the executor sends the invoice.
    run.step('invoice_issued_and_sent');
    const sendStats = await executeDueOutboundActions({
      client: substrate, firmId: FIRM, clientId: CLIENT,
      env: BASE_ENV, now,
      deliverers: providers.deliverers,
      paidTruthCheck: async () => 'unpaid',
      logger
    });
    run.check('one_send_executed', sendStats.sent === 1, JSON.stringify(sendStats));
    run.check('no_sweep_errors', sendStats.errors === 0, `errors=${sendStats.errors}`);
    const email = providers.sent[0] || null;
    run.check('addressed_to_the_counterparty_channel', email?.recipient === 'ap@brickworth.test', email?.recipient || 'nothing sent');
    run.check(
      'body_carries_the_live_pay_link',
      Boolean(email?.body?.includes(link?.url || '\u0000')),
      link?.url || 'no link url'
    );
    const issueReceipt = sentReceipts(substrate).find((row) => row.action_type === 'issue_invoice') || null;
    run.check('send_receipted', Boolean(issueReceipt), issueReceipt ? issueReceipt.id : 'no sent receipt');
    run.check(
      'receipt_carries_the_rendered_content',
      issueReceipt?.rendered_body === email?.body && issueReceipt?.rendered_subject === email?.subject,
      'receipt content must equal what the provider was handed'
    );
    const leash = leashCheckOn(issueReceipt);
    run.check(
      'inv_s7_role_leash_named_on_the_send',
      leash?.status === 'pass' && leash?.role === 'invoicing_collections',
      JSON.stringify(leash)
    );
    run.check(
      'authority_is_the_owner_approval',
      issueReceipt?.authority === 'per_send_owner_approval',
      issueReceipt?.authority || 'none'
    );
    // The AR ledger leg is a COMPONENT consequence of this identity. It either
    // posts or lands a NAMED skip — both are receipted, and the run report
    // states which, because a silently-absent books leg is exactly the failure
    // a certification journey exists to catch.
    const arCheck = (issueReceipt?.checks || []).find((check) => check.check === 'ar_ledger_post') || null;
    run.check('ar_ledger_leg_named_in_the_receipt', Boolean(arCheck), JSON.stringify(arCheck));
    run.check('ar_ledger_leg_posted', arCheck?.status === 'pass', JSON.stringify(arCheck));
    if (arCheck && arCheck.status !== 'pass') {
      run.observe(`the AR ledger leg did not post in this run: ${arCheck.status}/${arCheck.detail}`);
    }
    run.check(
      'journal_id_stamped_on_the_action',
      substrate.rows('outbound_actions')[0]?.payload?.ar_journal_id === arCheck?.detail,
      `payload.ar_journal_id must equal the receipt's journal id (${arCheck?.detail})`
    );
    // The Keep layer's own invariant, asserted over what the run actually
    // wrote: a sent invoice that books an unbalanced journal is the exact
    // failure mode a certification journey must not let through.
    const lines = substrate.rows('ledger_lines');
    const debits = lines.reduce((total, line) => total + Number(line.debit || 0), 0);
    const credits = lines.reduce((total, line) => total + Number(line.credit || 0), 0);
    run.check('journal_is_double_entry', lines.length >= 2, `${lines.length} ledger line(s)`);
    run.check('journal_balances', debits === credits && debits > 0, `DR ${debits} / CR ${credits}`);
    run.check(
      'receivable_debited_revenue_credited',
      lines.some((line) => line.account_code === '1100' && Number(line.debit) === 1250)
        && lines.some((line) => line.account_code === '4000' && Number(line.credit) === 1250),
      JSON.stringify(lines.map((line) => ({ code: line.account_code, dr: line.debit, cr: line.credit })))
    );
    run.check(
      'ledger_post_receipted',
      substrate.countAudit('ledger.post_sales_invoice') === 1,
      `audits=${substrate.countAudit('ledger.post_sales_invoice')}`
    );
    const anchor = substrate.rows('issued_invoices')[0] || null;
    run.check('anchor_flipped_to_issued', anchor?.status === 'issued', anchor?.status || 'no anchor');

    // ── Step 3: a week past due, the hourly sweep's detector opens the chase.
    //    This is the REAL production opener (outboundActionsDue.js →
    //    detectOverdueReceivables, the issued-invoice lane that landed with
    //    M2/#1589): the case and the step-1 reminder below are whatever the
    //    sweep actually minted, not a direct writer call. The 2026-08-15 run
    //    report's observation claiming this opener did not exist was checked
    //    against the tree and was WRONG — this step is the machine-checked
    //    correction.
    run.step('overdue_detected_case_opened');
    const overdueNow = Date.parse(`${dueDate}T09:00:00Z`) + 8 * 86_400_000; // GB step 1 fires at due+7d
    substrate.advanceTo(overdueNow);
    const detected = await detectOverdueReceivables({
      client: substrate, firmId: FIRM, clientId: CLIENT,
      env: BASE_ENV, now: overdueNow,
      paidTruthCheck: async () => 'unpaid',
      logger
    });
    run.check('issued_invoice_scanned_by_the_sweep', detected.issued_scanned === 1, JSON.stringify(detected));
    run.check('case_opened_by_the_sweep', detected.cases_opened === 1, JSON.stringify(detected));
    run.check('step_1_reminder_minted_through_the_gate', detected.actions_minted === 1, JSON.stringify(detected));
    run.check(
      'no_detector_errors_or_owner_gaps',
      detected.errors === 0 && detected.needs_owner_input === 0,
      JSON.stringify(detected)
    );
    const openedCase = substrate.rows('receivable_cases')[0] || null;
    run.check(
      'case_anchored_to_the_issued_invoice',
      openedCase?.anchor_type === 'issued_invoice' && openedCase?.anchor_id === 'issued-2026001'
        && openedCase?.status === 'open',
      JSON.stringify(openedCase && { anchor: `${openedCase.anchor_type}:${openedCase.anchor_id}`, status: openedCase.status })
    );
    run.check(
      'party_resolved_to_the_known_counterparty',
      openedCase?.target_party_id === 'party-brickworth'
        && substrate.rows('client_parties').length === 1,
      'suggest-and-confirm: the detector must enrich the existing Brickworth party, never mint a twin'
    );
    run.check(
      'case_opening_receipted',
      substrate.countAudit('receivable_case.opened') === 1,
      `audits=${substrate.countAudit('receivable_case.opened')}`
    );
    const reminder = substrate.rows('outbound_actions')
      .find((row) => row.action_type === 'send_receivable_reminder') || null;
    run.check(
      'reminder_is_cadence_step_1',
      reminder?.cadence_step === 1 && reminder?.template === 'reminder_step_1',
      reminder ? `${reminder.template}@step${reminder.cadence_step}` : 'no reminder minted'
    );
    run.check(
      'reminder_rests_on_the_owner',
      reminder?.status === 'hold_for_approval' && reminder?.gate_verdict === 'hold_for_approval',
      reminder ? `${reminder.status}/${reminder.gate_verdict}` : 'no reminder minted'
    );
    const minted = substrate.auditFor('role.handed_to_owner')[0] || null;
    run.check(
      'mint_handoff_attributed_to_claras_lane',
      minted?.metadata?.current_actor === 'owner'
        && minted?.metadata?.occupant?.ai_profile === 'clara',
      JSON.stringify(minted?.metadata?.occupant)
    );
    run.observe('the parsed-document candidate lane scanned an empty documents table in this run — the issued-invoice lane is this journey\'s subject; the parsed lane is unit-covered in receivableCases.test.js, and journey 2 chases a parsed-document anchor.');

    // ── Step 4: the customer pays through the link.
    run.step('pay_link_settlement');
    const applied = await applyPayLinkWebhookEvent({
      client: substrate,
      event: {
        id: 'evt_journey_1', type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_journey_1', payment_link: link?.provider_link_id,
            payment_status: 'paid', amount_total: 125_000
          }
        }
      }
    });
    run.check('webhook_handled', applied?.handled === true && applied?.deduped === false, JSON.stringify(applied));
    run.check('settled_amount_from_the_provider', applied?.settled_amount === 1250, String(applied?.settled_amount));
    const settledLink = substrate.rows('outbound_payment_links')[0] || null;
    run.check('link_flipped_settled', settledLink?.status === 'settled', settledLink?.status || 'no link');
    run.check(
      'settlement_receipted',
      substrate.countAudit('outbound_payment_link.settled') === 1,
      `audits=${substrate.countAudit('outbound_payment_link.settled')}`
    );
    // The chase the sweep opened in step 3 converges with the money: the
    // pending step-1 reminder cancels NOW, receipted — the seam this journey
    // exists to cross (the webhook cancelling a reminder the detector minted).
    run.check('pending_chase_cancelled_by_settlement', applied?.cancelled_pending_actions === 1, JSON.stringify(applied));
    const cancelledReminder = substrate.rows('outbound_actions')
      .find((row) => row.action_type === 'send_receivable_reminder') || null;
    run.check(
      'reminder_cancelled_as_already_settled',
      cancelledReminder?.status === 'cancelled' && cancelledReminder?.cancel_reason === 'already_settled',
      cancelledReminder ? `${cancelledReminder.status}/${cancelledReminder.cancel_reason}` : 'no reminder row'
    );
    const cancelReceipt = substrate.rows('outbound_action_receipts')
      .find((row) => row.outcome === 'cancelled') || null;
    run.check(
      'cancel_receipted_with_settlement_authority',
      cancelReceipt?.authority === 'payment_link_settlement',
      cancelReceipt?.authority || 'no cancelled receipt'
    );
    const resumed = substrate.auditFor('role.resumed_from_owner')[0] || null;
    run.check(
      'held_item_withdrawn_from_the_owners_queue',
      resumed?.metadata?.outcome === 'withdrawn',
      JSON.stringify(resumed?.metadata && { outcome: resumed.metadata.outcome, reasons: resumed.metadata.reasons })
    );

    // ── Step 5: the terminal.
    run.step('terminal_state');
    const settledCase = substrate.rows('receivable_cases')[0] || null;
    run.check('case_reached_the_settled_terminal', settledCase?.status === 'settled', settledCase?.status || 'no case');
    run.check(
      'case_terminal_is_receipted',
      substrate.countAudit('receivable_case.settled') === 1,
      `audits=${substrate.countAudit('receivable_case.settled')}`
    );
    // Idempotency: the provider re-delivering the same event must not settle twice.
    const replay = await applyPayLinkWebhookEvent({
      client: substrate,
      event: {
        id: 'evt_journey_1', type: 'checkout.session.completed',
        data: { object: { id: 'cs_journey_1', payment_link: link?.provider_link_id, payment_status: 'paid', amount_total: 125_000 } }
      }
    });
    run.check('replayed_webhook_deduped', replay?.deduped === true, JSON.stringify(replay));
    run.check(
      'replay_did_not_double_settle',
      substrate.countAudit('outbound_payment_link.settled') === 1,
      `audits=${substrate.countAudit('outbound_payment_link.settled')}`
    );
    assertNothingRestsFirmSide(run, substrate);
  } catch (thrown) {
    error = thrown;
  }

  return run.report({
    substrate,
    error,
    evidence: {
      emails_sent: providers.sent.length,
      stripe_calls: providers.stripeCalls.length,
      audit_actions: substrate.auditActions(),
      outbound_action_statuses: substrate.rows('outbound_actions')
        .map((row) => ({ action_type: row.action_type, status: row.status })),
      receivable_case_statuses: substrate.rows('receivable_cases').map((row) => ({ id: row.id, status: row.status, reason: row.status_reason ?? null })),
      payment_link_statuses: substrate.rows('outbound_payment_links').map((row) => ({ id: row.id, status: row.status })),
      loop_events: substrate.rows('loop_event_inbox').map((row) => row.event_type),
      // The model-id-is-part-of-the-receipt rail: read from what the run wrote.
      receipt_models: modelIdsFromReceipts(substrate)
    }
  });
};

// ── Journey 2 — cadence exhausted, the owner holds the next step ────────────

const runCadenceToOwnerEscalation = async ({ now, logger }) => {
  const id = 'journey.collections.cadence-to-owner-escalation.v1';
  const description = 'reminder cadence exhausted → decide_collection_next_step rests on the owner, receipted';
  const run = createRun({ id, description, now });
  const providers = createProviders();
  // The GB pack's cadence is three steps, escalating to the owner after step 3.
  const dueDate = toLocalIsoDay(now - 44 * 86_400_000); // host-local day

  const substrate = createJourneySubstrate({
    now,
    routes: substrateRoutes(),
    tables: seedTables({
      extra: {
        outbound_actions: [{
          id: 'action-reminder-3', firm_id: FIRM, client_id: CLIENT,
          action_type: 'send_receivable_reminder', target_party_id: 'party-brickworth',
          anchor_type: 'document', anchor_id: 'doc-brickworth-014', pack_id: PACK,
          template: 'reminder_step_3', language: null,
          payload: {
            due_date: dueDate,
            render_values: {
              owner_business_name: 'Roofline Ltd', counterparty_name: 'Brickworth Ltd',
              invoice_number: 'INV-2026-014', amount_due: '1,250.00', currency: 'GBP',
              due_date: dueDate,
              payment_instructions: 'Faster Payments sort 04-00-04, account 12345678'
            }
          },
          amount: 1250, currency: 'GBP', confidence: 0.9,
          status: 'approved', approved_by_actor_type: 'owner', approved_by_actor_id: 'kari',
          scheduled_for: new Date(now - 3_600_000).toISOString(), cadence_step: 3,
          model: null, config_snapshot_id: null,
          approval_token: 'approval-reminder-3', unsubscribe_token: 'unsub-reminder-3',
          gate_basis: {}, created_at: new Date(now - 14 * 86_400_000).toISOString()
        }],
        receivable_cases: [{
          id: 'case-brickworth', firm_id: FIRM, client_id: CLIENT,
          anchor_type: 'document', anchor_id: 'doc-brickworth-014',
          target_party_id: 'party-brickworth', pack_id: PACK,
          invoice_number: 'INV-2026-014', status: 'open', status_reason: null,
          current_step: 2, last_action_id: null,
          amount: 1250, currency: 'GBP',
          next_due_at: new Date(now - 3_600_000).toISOString(),
          created_at: new Date(now - 30 * 86_400_000).toISOString()
        }]
      }
    })
  });

  let error = null;
  try {
    // ── Step 1: the final reminder goes out.
    run.step('final_cadence_step_sent');
    const stats = await executeDueOutboundActions({
      client: substrate, firmId: FIRM, clientId: CLIENT,
      env: BASE_ENV, now,
      deliverers: providers.deliverers,
      paidTruthCheck: async () => 'unpaid',
      logger
    });
    run.check('one_send_executed', stats.sent === 1, JSON.stringify(stats));
    run.check('no_sweep_errors', stats.errors === 0, `errors=${stats.errors}`);
    const receipt = sentReceipts(substrate)[0] || null;
    const leash = leashCheckOn(receipt);
    run.check(
      'inv_s7_role_leash_named_on_the_send',
      leash?.status === 'pass' && leash?.role === 'invoicing_collections',
      JSON.stringify(leash)
    );
    const paidTruth = (receipt?.checks || []).find((check) => check.check === 'paid_truth') || null;
    run.check('paid_truth_re_checked_at_send', paidTruth?.status === 'pass', JSON.stringify(paidTruth));

    // ── Step 2: the cadence is exhausted — nothing further is minted.
    run.step('cadence_exhausted');
    run.check('escalation_counted', stats.cadence_escalations === 1, JSON.stringify(stats));
    run.check('no_further_reminder_minted', stats.cadence_minted === 0, `cadence_minted=${stats.cadence_minted}`);
    run.check(
      'exhaustion_receipted',
      substrate.countAudit('outbound_action.cadence_exhausted') === 1,
      `audits=${substrate.countAudit('outbound_action.cadence_exhausted')}`
    );
    const exhaustion = substrate.auditFor('outbound_action.cadence_exhausted')[0] || null;
    run.check('escalates_to_the_owner', exhaustion?.metadata?.escalate_to === 'owner', JSON.stringify(exhaustion?.metadata));
    run.check(
      'reminder_count_is_the_pack_cadence',
      substrate.rows('outbound_actions').filter((row) => row.action_type === 'send_receivable_reminder').length === 1,
      'the exhausted step must not spawn a fourth reminder'
    );

    // ── Step 3: the role hands the decision to the owner (S5), with the
    //    commitment the manifest names.
    run.step('handed_to_the_owner');
    const handed = substrate.auditFor('role.handed_to_owner')[0] || null;
    run.check('role_event_recorded', Boolean(handed), handed ? 'one role.handed_to_owner receipt' : 'none');
    run.check(
      'next_commitment_is_decide_collection_next_step',
      handed?.metadata?.next_commitment === 'decide_collection_next_step',
      handed?.metadata?.next_commitment || 'absent'
    );
    run.check('current_actor_is_the_owner', handed?.metadata?.current_actor === 'owner', handed?.metadata?.current_actor || 'absent');
    run.check(
      'attributed_to_the_hired_occupant',
      handed?.metadata?.responsible_role === 'invoicing_collections'
        && handed?.metadata?.occupant?.ai_profile === 'clara',
      JSON.stringify(handed?.metadata?.occupant)
    );
    run.check('reason_is_the_exhausted_cadence', (handed?.metadata?.reasons || []).includes('cadence_exhausted'), JSON.stringify(handed?.metadata?.reasons));
    const inbox = substrate.rows('loop_event_inbox');
    run.check(
      'loop_event_queued_for_the_owner_lane',
      inbox.length === 1 && inbox[0].event_type === 'role.handed_to_owner',
      JSON.stringify(inbox.map((row) => row.event_type))
    );

    // ── Step 4: the case rests ON THE OWNER, not on the firm.
    run.step('terminal_state');
    const chased = substrate.rows('receivable_cases')[0] || null;
    run.check('case_escalated', chased?.status === 'escalated', chased?.status || 'no case');
    run.check('case_reason_named', chased?.status_reason === 'cadence_exhausted', chased?.status_reason || 'absent');
    run.check('case_has_no_pending_next_due', !chased?.next_due_at, String(chased?.next_due_at));
    run.check(
      'case_escalation_receipted',
      substrate.countAudit('receivable_case.escalated') === 1,
      `audits=${substrate.countAudit('receivable_case.escalated')}`
    );
    assertNothingRestsFirmSide(run, substrate);
  } catch (thrown) {
    error = thrown;
  }

  return run.report({
    substrate,
    error,
    evidence: {
      emails_sent: providers.sent.length,
      audit_actions: substrate.auditActions(),
      outbound_action_statuses: substrate.rows('outbound_actions').map((row) => ({ id: row.id, status: row.status, step: row.cadence_step })),
      receivable_case_statuses: substrate.rows('receivable_cases').map((row) => ({ id: row.id, status: row.status, reason: row.status_reason ?? null })),
      loop_events: substrate.rows('loop_event_inbox').map((row) => row.event_type),
      receipt_models: modelIdsFromReceipts(substrate)
    }
  });
};

// ── The registry ────────────────────────────────────────────────────────────

export const JOURNEY_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'journey.collections.invoice-to-settlement.v1',
    role: 'invoicing_collections',
    jurisdiction: 'GB',
    run: runInvoiceToSettlement
  }),
  Object.freeze({
    id: 'journey.collections.cadence-to-owner-escalation.v1',
    role: 'invoicing_collections',
    jurisdiction: 'GB',
    run: runCadenceToOwnerEscalation
  })
]);

export const findJourneyDefinition = (journeyId) =>
  JOURNEY_DEFINITIONS.find((entry) => entry.id === journeyId) || null;

// A fixed clock: journey scheduling arithmetic must be exact, not "whenever CI
// ran". Overridable so a caller can re-run a journey at another instant.
export const DEFAULT_JOURNEY_CLOCK = Date.parse('2026-08-14T09:00:00Z');

export const runJourney = async (journeyId, {
  now = DEFAULT_JOURNEY_CLOCK,
  logger = { warn: () => {}, log: () => {}, error: () => {} }
} = {}) => {
  const definition = findJourneyDefinition(journeyId);
  if (!definition) throw new Error(`unknown journey '${journeyId}' — see JOURNEY_DEFINITIONS`);
  return definition.run({ now, logger });
};

export const runAllJourneys = async (options = {}) => {
  const out = {};
  for (const definition of JOURNEY_DEFINITIONS) {
    out[definition.id] = await runJourney(definition.id, options);
  }
  return out;
};
