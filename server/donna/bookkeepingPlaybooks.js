// Donna — L2 bookkeeping playbook library v1 (accounting-runtime hardening, Slice I).
//
// The L2 doctrine (CLAUDE.md "Donna is an accounting runtime"): curated bookkeeping
// skills ON DEMAND — retrieved per-case, never main-prompt bloat. A playbook encodes
// the boring professional judgment for a RECOGNIZED transaction pattern: what to do,
// what NOT to do, and when to escalate. It GUIDES the model's proposals and NEVER
// bypasses checks or authority — the deterministic preflight, the capability gate,
// and the authority envelope refuse exactly as they would without it, and "escalate"
// always means an OWNER ask (`ask_client`), never a firm-side parking lot (the
// two-terminal-states principle).
//
// v1 shipped ONE playbook — `stripe_payout_reconciliation` — because payment-processor
// payout intermediation is the Failure-B escalation class verbatim (CLAUDE.md: the
// pilot client's invoice whose GBP charge settled FX-converted via a processor; three hops a
// human bridges in a second). The library SHAPE is general so the next playbook is a
// data addition, not a design change — proven by `processor_payout_reconciliation`
// (Square / Shopify Payments), added when Honeybee's first shadow-sizing window showed
// its June statement carries SHOPIFY INC ACH / SQUARE INC payouts and zero Stripe
// traffic: the same net-batch settlement pattern under the processors this book
// actually uses.
//
// Retrieval is DELIBERATELY deterministic (word-bounded descriptor patterns over the
// same description/raw_description text the firmFacts merchant recipe keys on). This
// is not the #497 fuzzy-classifier trap: retrieval is a RECALL aid whose output gates
// nothing — a missed match means no guidance (the strong model judges unaided, as
// today), a spurious match adds guidance the model is free to ignore. Nothing here
// substitutes for the model's judgment; the playbook text itself defers to documents,
// the client's words, and jurisdiction facts.
//
// Config staging (plan §7): `BOOKKEEPING_PLAYBOOK_RETRIEVAL` through the config plane
// (client_capability_config, migration 042), per client, Honeybee-first. Unlike the
// F/H observe gates (whose enrichment predated their flags, so they default observe),
// this flag guards NEW live behaviour — prompt injection changes what the model
// proposes — so BOTH duals fall back to false: no DB row ⇒ fully dormant
// (byte-identical prompt), the `OPERATOR_CAPABILITY_ENFORCE` precedent.
//   off / dry_run — nothing: no selection, no stamp, no injection.
//   shadow        — observe-only sizing: selection runs and the match is STAMPED on
//                   the assistant message payload (`playbooks_matched`), but the
//                   prompt is untouched. "How often would this fire" before it acts.
//   canary / auto — acts: matched playbooks are injected into the prompt's workspace
//                   context and stamped (`playbooks_injected`); the apply receipt's
//                   `playbooks_used` renders that persisted stamp.
//
// Pure leaf: imports only clientConfig.js (the flag-dual helpers), no DB, no LLM —
// loads in-sandbox under `node --test` like operatorCapability.js / memoryPacket.js.

import { clientFlagActs, clientFlagObserves } from './clientConfig.js';

export const BOOKKEEPING_PLAYBOOK_FLAG_KEY = 'BOOKKEEPING_PLAYBOOK_RETRIEVAL';

// Acts ⇒ inject into the prompt (canary/auto). Observes ⇒ selection runs and is
// stamped for sizing (shadow/canary/auto). Both dormant without a DB row (env
// fallback false — new live behaviour lands off, the fail-closed direction §6).
export const playbookRetrievalActs = ({ snapshot = null, env = process.env } = {}) =>
  clientFlagActs({ flagKey: BOOKKEEPING_PLAYBOOK_FLAG_KEY, snapshot, envFallback: () => false, env });

export const playbookRetrievalObserves = ({ snapshot = null, env = process.env } = {}) =>
  clientFlagObserves({ flagKey: BOOKKEEPING_PLAYBOOK_FLAG_KEY, snapshot, envFallback: () => false, env });

// Keep the injected context tight (retrieved per-case ≠ main-prompt bloat): at most
// this many playbooks ride one prompt, in library order.
export const MAX_PLAYBOOKS_PER_CASE = 2;

// ---------------------------------------------------------------------------
// The library. Each playbook:
//   id            — stable id; what the payload stamp and the receipt's
//                   `playbooks_used` carry (contract: array of strings).
//   title         — one line, rendered to the model.
//   triggers      — word-bounded RegExps (no /g — lastIndex statefulness) tested
//                   against "description raw_description counterparty".
//   what_it_is    — the pattern recognition sentence (what this bank line IS).
//   do / do_not   — the professional judgment, imperative, bounded.
//   escalate_when — when the answer is the OWNER's: each entry names an ask_client
//                   escalation, honouring the two terminal states.
//   tax_note      — jurisdiction posture, always deferring to the client block.
// ---------------------------------------------------------------------------
export const BOOKKEEPING_PLAYBOOKS = Object.freeze([
  Object.freeze({
    id: 'stripe_payout_reconciliation',
    title: 'Stripe payout reconciliation (payment-processor settlement)',
    triggers: Object.freeze([/\bstripe\b/i]),
    what_it_is:
      'A bank line from Stripe is a PAYOUT: a net batch settlement from the payment processor, '
      + 'not a payment from any single customer. Stripe collects the client\'s customer charges, '
      + 'deducts its processing fees (and any refunds, disputes, or reserves), and pays out the NET '
      + 'on a rolling schedule — possibly FX-converted into the bank account\'s currency. The '
      + 'counterparty on the bank line is the processor; the real counterparties are the customers '
      + 'behind the batch.',
    do: Object.freeze([
      'Reconcile the payout against the payout BATCH it settles (charges minus fees minus refunds for the period), not against any single invoice.',
      'Expect the net amount to differ from every individual invoice: a payout usually spans several charges and always nets out fees.',
      'Explain the payout as its parts: the gross charges settle the customer invoices / sales for the period; the difference is processor fees, coded to a payment-processing fees expense account; refunds reverse the original revenue.',
      'Treat a currency mismatch against the invoices as EXPECTED processor behaviour (Stripe settles FX-converted), not as evidence against the match — bridge amounts through the payout\'s own conversion.',
      'When customer invoices exist in the book (a payment link on the invoice is a strong signal), prefer settling those invoices through the processor batch over inventing a new income line.'
    ]),
    do_not: Object.freeze([
      'Do not code the whole payout as revenue or sales — that double-counts revenue already recognized on invoices and buries the processing fees.',
      'Do not force a one-to-one amount match to a single invoice; a near-miss amount plus a Stripe descriptor is a net batch, not a discount or partial payment.',
      'Do not code the fee difference to generic bank charges or leave it unexplained — it is a processor fee expense.',
      'Do not rest at "no exact match found": the batch explanation (or an owner ask for the payout report) is the terminal state, never an unexplained income line.'
    ]),
    escalate_when: Object.freeze([
      'The batch composition cannot be derived from the book and there is no payout report: ask the OWNER for the Stripe payout report or read access to the Stripe account.',
      'The payout settles charges that have no corresponding invoice or sales record in the book: ask the OWNER for the underlying sales evidence.',
      'The tax treatment of processor fees is unclear for this client\'s jurisdiction: propose the conservative treatment and put the open tax question to the OWNER.'
    ]),
    tax_note:
      'Processor fees are exempt/input-tax-free financial services in SOME regimes but not all — '
      + 'judge per the client block\'s jurisdiction and tax profile; never assume one regime\'s rule.'
  }),
  Object.freeze({
    id: 'processor_payout_reconciliation',
    title: 'Payment-processor payout reconciliation (Square / Shopify Payments)',
    // SQUARE needs the INC/UP qualifier — bare \bsquare\b false-positives on
    // ordinary merchant names (TOWN SQUARE MARKET, SQUARE ONE CAFE). SHOPIFY is
    // distinctive enough to stand alone.
    triggers: Object.freeze([/\bshopify\b/i, /\bsquare\s+inc\b/i, /\bsquareup\b/i]),
    what_it_is:
      'A bank line from Square or Shopify is a PAYOUT: a net batch settlement from the payment '
      + 'processor, not a payment from any single customer. The processor collects the client\'s '
      + 'card/online takings, deducts its processing fees (and any refunds, disputes, or reserves), '
      + 'and pays out the NET on a rolling schedule — Square typically settles a day\'s (or a few '
      + 'days\') card takings next business day; Shopify Payments settles the store\'s orders for a '
      + 'payout period. The counterparty on the bank line is the processor; the real counterparties '
      + 'are the customers behind the batch.',
    do: Object.freeze([
      'Reconcile the payout against the settlement BATCH it pays out (gross takings minus fees minus refunds for the period) — for Square that is usually a daily sales summary, for Shopify the payout report\'s order list — never against a single sale.',
      'Expect the net deposit to differ from every individual sale and from the day\'s gross: the difference is processing fees (and any refunds or instant-transfer fees).',
      'Explain the payout as its parts: gross takings settle the sales/invoices for the period; the fee difference is coded to a payment-processing fees expense account; refunds reverse the original revenue.',
      'When the book has no separate sales records for the batch, gross the payout UP — recognize the gross takings as revenue and the fee difference as processing-fee expense — rather than booking the net deposit as sales.',
      'When sales records or invoices exist in the book, prefer settling them through the processor batch over inventing a new income line.'
    ]),
    do_not: Object.freeze([
      'Do not code the whole payout as revenue when the underlying sales are already recognized — that double-counts revenue and buries the processing fees.',
      'Do not book the NET deposit as the period\'s sales when nothing else records them — that silently understates both revenue and fees by the same amount.',
      'Do not force a one-to-one amount match to a single sale or invoice; a near-miss amount plus a processor descriptor is a net batch, not a discount or partial payment.',
      'Do not code the fee difference to generic bank charges or leave it unexplained — it is a processor fee expense.',
      'Do not rest at "no exact match found": the batch explanation (or an owner ask for the payout report) is the terminal state, never an unexplained income line.'
    ]),
    escalate_when: Object.freeze([
      'The batch composition cannot be derived from the book and there is no payout report: ask the OWNER for the Square/Shopify payout report or read access to the processor dashboard.',
      'The payout settles takings that have no corresponding sales record in the book: ask the OWNER for the underlying sales evidence (daily summaries, order exports).',
      'The payout carries an unexplained hold, reserve, or dispute deduction, or the tax treatment of processor fees is unclear for this client\'s jurisdiction: propose the conservative treatment and put the open question to the OWNER.'
    ]),
    tax_note:
      'Processor fees are exempt/input-tax-free financial services in SOME regimes but not all — '
      + 'judge per the client block\'s jurisdiction and tax profile. Square and Shopify Payments '
      + 'clients are normally the merchant of record for their own sales; never assume one '
      + 'regime\'s rule.'
  }),
  Object.freeze({
    id: 'credit_card_payment_settlement',
    title: 'Credit-card payment (liability settlement, not an expense)',
    // Card-issuer payment descriptors: AMEX EPAYMENT ACH (the Honeybee June
    // statement's real line), plus the common issuer autopay/e-payment forms.
    // Word-bounded so ordinary merchants using a card BRAND word in their name
    // don't trigger; the signal is issuer + payment, not the brand alone.
    triggers: Object.freeze([
      /\bamex\s+epayment\b/i,
      /\bamerican\s+express\s+(?:ach\s+)?pmt\b/i,
      /\b(?:chase|citi|capital\s*one|discover|barclays?)\s+(?:card\s*)?(?:e-?payment|epay|autopay|crcardpmt|payment)\b/i,
      /\bcrcardpmt\b/i
    ]),
    what_it_is:
      'A payment from the bank account to a credit-card issuer settles the card\'s outstanding '
      + 'BALANCE — it is a transfer against a liability (credit card payable), not a new expense. '
      + 'The real expenses are the individual charges on the card statement; they are recognized '
      + 'when charged, on their own lines, not when the balance is paid off.',
    do: Object.freeze([
      'Code the payment against the credit-card liability account (e.g. "Credit card payable - American Express"), reducing the balance owed.',
      'Reconcile the payment amount against the card statement\'s payment line or statement balance for the period.',
      'If the card\'s charges are not yet in the book (no card feed or statement ingested), treat that as the missing evidence — the expenses live there, not on this bank line.'
    ]),
    do_not: Object.freeze([
      'Do not code the payment as an expense — the charges on the card statement are the expenses; coding the payment too double-counts every one of them.',
      'Do not code it to bank fees, interest, or a generic category because the issuer name looks like a vendor — the issuer here is a lender being repaid.',
      'Do not net it against revenue or treat a large payment as suspicious by size alone; card balances are routinely multiples of any single charge.'
    ]),
    escalate_when: Object.freeze([
      'No credit-card statement or card feed exists in the book for the period the payment covers: ask the OWNER for the card statement so the underlying charges can be recognized.',
      'The payment does not tie to any card balance the book knows about (unknown card, unknown issuer account): ask the OWNER which card this pays and for its statement.',
      'Charges on the card appear personal or mixed-use: ask the OWNER to identify the personal portion rather than guessing a split.'
    ]),
    tax_note:
      'The payment itself has no tax treatment (out of scope — a liability settlement); any input '
      + 'tax lives on the individual card charges per the client block\'s jurisdiction. Card '
      + 'interest and fees, if charged, follow the jurisdiction\'s finance-cost rules.'
  }),
  Object.freeze({
    id: 'interaccount_transfer',
    title: 'Inter-account transfer (movement between the client\'s own accounts)',
    // Bank transfer descriptors: the Honeybee June statement's real form
    // (ONLINE TRANSFER TO CHECKING ...) plus the common to/from variants.
    // Deliberately NOT a bare \btransfer\b — wire transfers TO third parties
    // are payments, not internal movements; the trigger needs the
    // to/from-own-account shape.
    triggers: Object.freeze([
      /\bonline\s+transfer\s+(?:to|from)\s+(?:checking|savings|chk|sav)\b/i,
      /\btransfer\s+(?:to|from)\s+(?:checking|savings|chk|sav)\b/i,
      /\binternal\s+transfer\b/i,
      /\bxfer\s+(?:to|from)\s+(?:checking|savings|chk|sav)\b/i
    ]),
    what_it_is:
      'A transfer between two of the client\'s OWN bank accounts moves money; it creates no income '
      + 'and no expense. Each side of the movement appears once in each account\'s feed — an outflow '
      + 'in one account and a matching inflow in the other, usually same-day or next-day for the '
      + 'same amount.',
    do: Object.freeze([
      'Code the line as a transfer between accounts (bank transfer / inter-account clearing per the chart), out of profit and loss entirely.',
      'When the counterpart account is also in the book, expect and reconcile the mirror line — same amount, opposite direction, close date.',
      'If only ONE side is in the book (the other account is not connected), the transfer still is not income or expense — code it as a transfer and note which account it went to or came from.'
    ]),
    do_not: Object.freeze([
      'Do not code an inbound transfer as sales/revenue — it is the client\'s own money arriving from their other account.',
      'Do not code an outbound transfer as an expense or owner drawing without evidence — a transfer to the client\'s own savings is neither.',
      'Do not match a transfer line against a customer invoice or supplier bill on amount alone — the mirror bank line is its counterpart, not a trade document.'
    ]),
    escalate_when: Object.freeze([
      'The destination/source account is unknown to the book and its ownership is unclear (could be the owner\'s personal account): ask the OWNER whose account it is — that answer decides transfer vs drawing/contribution.',
      'Transfers to a personal account are frequent or irregular and the treatment (drawings vs reimbursement vs payroll) is unsettled: put the policy question to the OWNER.',
      'A mirror line for a material transfer never appears in the connected counterpart account: ask the OWNER for that account\'s statement for the period.'
    ]),
    tax_note:
      'Out of scope in every regime — an internal movement of the client\'s own funds carries no '
      + 'GST/VAT/sales-tax treatment. The tax question only arises if the "transfer" turns out to '
      + 'be a drawing or contribution — judge that per the ownership answer, not the descriptor.'
  })
]);

const HAYSTACK_MAX = 2000;
const bound = (value, max) => {
  if (typeof value !== 'string') return '';
  return value.length > max ? value.slice(0, max) : value;
};

// Deterministic per-case retrieval. Inputs are the SAME text fields the firmFacts
// merchant-scope recipe keys on (description + raw_description), plus the resolved
// counterparty when a caller has one. Pure recall: [] on no signal, never a throw.
export const selectPlaybooksForCase = ({ description = '', raw_description: rawDescription = '', counterparty = '' } = {}) => {
  const haystack = bound(
    [description, rawDescription, counterparty]
      .map((part) => (typeof part === 'string' ? part : ''))
      .join(' '),
    HAYSTACK_MAX
  ).trim();
  if (!haystack) return [];
  return BOOKKEEPING_PLAYBOOKS
    .filter((playbook) => playbook.triggers.some((re) => re.test(haystack)))
    .slice(0, MAX_PLAYBOOKS_PER_CASE);
};

// Compact, bounded rendering for the prompt's workspace context (the known_facts
// discipline: structured, length-capped, no free growth). Triggers stay out — they
// are retrieval plumbing, not guidance.
const LIST_ITEM_MAX = 300;
const boundList = (list) =>
  (Array.isArray(list) ? list : []).map((item) => bound(item, LIST_ITEM_MAX)).filter(Boolean);

export const renderPlaybooksForPrompt = (playbooks = []) =>
  (Array.isArray(playbooks) ? playbooks : [])
    .slice(0, MAX_PLAYBOOKS_PER_CASE)
    .map((playbook) => ({
      id: bound(playbook?.id, 64),
      title: bound(playbook?.title, 160),
      what_it_is: bound(playbook?.what_it_is, 800),
      do: boundList(playbook?.do),
      do_not: boundList(playbook?.do_not),
      escalate_when: boundList(playbook?.escalate_when),
      tax_note: bound(playbook?.tax_note, 400)
    }))
    .filter((playbook) => playbook.id);

// The persisted mint-time stamp → the receipt's `playbooks_used` ids. Same sanitize
// discipline as memoryPacket's id lists: strings only, trimmed, deduped. null when the
// message carries no stamp (nothing injected / pre-slice message / doc- or feed-chat),
// so the receipt keeps its bare [] — "no playbook recorded", distinct from a recorded
// empty which cannot occur (an empty stamp is never written).
export const playbookIdsFromMessagePayload = (payload = null) => {
  const stamp = payload?.playbooks_injected;
  if (!Array.isArray(stamp)) return null;
  const out = [];
  const seen = new Set();
  for (const entry of stamp) {
    const id = typeof entry === 'string' ? entry.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
};
