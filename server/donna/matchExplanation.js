// Match explanation generator for transaction detail view.
//
// Builds structured, natural-language explanations from reconciliation
// match data, auto-categorize metadata, and client rules. Determines
// confidence level to control UI mode:
//   confident → "Matched to..." with no action buttons
//   review    → explanation + chat available
//   uncertain → "Ask client" visible + LLM-generated reasoning

// Mirrors the FE transactionMatchHero.isMeaningfulMatch — a positive
// (non-rejected) document-side match. When one exists the transaction
// already has document evidence, so the categorization pipeline's
// "no supporting document — ask the client" verdict is wrong on its
// face. We suppress the proactive ask-client card server-side rather
// than relying on the FE guard alone (which depends on the `match`
// prop being threaded through every render path). This is the cleaner
// server-side fix flagged in the Layer 3 handoff: a "SUGGESTED: ASK
// CLIENT" card rendering alongside a real match.
const MEANINGFUL_MATCH_STATUSES = new Set(['confirmed', 'auto_matched', 'suggested']);
const isMeaningfulMatch = (match) =>
  !!match && MEANINGFUL_MATCH_STATUSES.has(String(match.status || '').toLowerCase());

// The firm's accept is a persisted terminal verdict. A line the firm
// has decided (accepted/resolved) — or that has already posted/synced —
// must NEVER render a proactive "ask the client what this was" card: the
// firm already made the call, and the legacy confidence ladder below has
// no standing to re-open it. (Sighted: a pilot client's loan deposits, coded
// and accepted in one feed-chat command, each still showed "SUGGESTED:
// ASK CLIENT — confirm whether it's business income" — a question that
// contradicts the firm's own decision.) Mirrors the feed chat's
// decided-rows doctrine (feedChat.js) and the reconciled-tab vocabulary
// (RECONCILED_STATES). NOTE: "evidence owed" (ai_suggestion
// .evidence_required, the #378 pill — "documentation to follow") is a
// separate waiting-on-paperwork state, not a request to ask the client
// what the line is.
const FIRM_DECIDED_REVIEW_STATES = new Set(['accepted', 'resolved', 'synced', 'posted']);
const isFirmDecided = (reviewItem) =>
  FIRM_DECIDED_REVIEW_STATES.has(
    String(reviewItem?.review_state || reviewItem?.payload?.review_state || '').toLowerCase()
  );

const formatMoney = (amount, currency = 'USD') => {
  // null / undefined / '' mean "no amount" — NOT zero. Number(null) is 0,
  // which would render a misleading "USD 0.00" — or "null 0.00" when the
  // currency is also absent (a sparsely-parsed payout settlement has neither
  // total_amount nor currency). Drop the value instead.
  if (amount === null || amount === undefined || amount === '') return null;
  if (!Number.isFinite(Number(amount))) return null;
  const formatted = Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const ccy = String(currency ?? '').trim();
  return ccy ? `${ccy} ${formatted}` : formatted;
};

// Best-effort counterparty from the bank line itself — a headline fallback
// for when the matched document was extracted without a vendor/customer
// (e.g. a Shopify payout settlement parsed as a bare receipt). Strips a
// leading rail/method token and a trailing reference number so
// "SHOPIFY INC ACH 889512" reads as "SHOPIFY INC". Returns null when
// there's nothing usable, so the existing filename fallback still applies.
const cleanBankCounterparty = (transaction) => {
  const raw = String(
    transaction?.counterparty
    || transaction?.contact
    || transaction?.description
    || transaction?.raw_description
    || ''
  ).trim();
  if (!raw) return null;
  const cleaned = raw
    .replace(/^(card|wire|debit|credit|payment|transfer|sale)\s+/i, '')
    .split(/[|,:(]/)[0]
    .replace(/\s+\d{4,}\s*$/, '')
    .replace(/\s+(ach|eft|wire)\s*$/i, '')
    .trim();
  return cleaned || null;
};

const buildAmountPhrase = (matchReason) => {
  if (!matchReason?.amount) return null;
  const { exact, delta, transaction, document } = matchReason.amount;
  if (exact) return 'exact amount match';
  if (Number.isFinite(delta) && Math.abs(delta) < 1) return 'amount matches within rounding';
  if (Number.isFinite(delta)) {
    const pct = Number.isFinite(document) && document > 0
      ? Math.abs(delta / document * 100).toFixed(1)
      : null;
    return `amount is close (${delta > 0 ? '+' : ''}${delta.toFixed(2)} difference${pct ? `, ${pct}%` : ''})`;
  }
  return null;
};

const buildDatePhrase = (matchReason) => {
  if (!matchReason?.date) return null;
  const { gap_days, due_date } = matchReason.date;
  if (!Number.isFinite(gap_days)) return null;
  if (gap_days === 0) return 'paid on the bill date';
  if (gap_days > 0 && gap_days <= 3) return `paid ${gap_days} day${gap_days > 1 ? 's' : ''} after the bill`;
  if (gap_days > 0 && due_date) return 'paid within the due-date window';
  if (gap_days > 0) return `paid ${gap_days} days after the bill date`;
  if (gap_days < 0) return `paid ${Math.abs(gap_days)} days before the bill date`;
  return null;
};

const buildVendorPhrase = (matchReason, document) => {
  const hints = matchReason?.hints || [];
  const vendorName = document?.vendor_name || document?.customer_name;
  if (!vendorName) return null;

  if (hints.includes('ref_match')) return `reference number matches ${vendorName}`;
  if (hints.includes('vendor_exact')) return `vendor confirmed (${vendorName})`;
  if (hints.includes('vendor_overlap') || hints.includes('vendor_fuzzy')) {
    return `vendor name matches (${vendorName})`;
  }
  return `linked to ${vendorName}`;
};

const confidenceLevelForMatch = (match, reviewItem) => {
  const score = Number(match?.match_confidence || 0);
  const autoCategSource = reviewItem?.payload?.auto_categorize_source || '';

  if (match?.status === 'confirmed') return 'confident';
  if (match?.status === 'auto_matched') return 'confident';
  if (autoCategSource === 'client_rule') return 'confident';
  if (score >= 0.85) return 'confident';
  if (score >= 0.6 || autoCategSource.includes('vendor_signal') || autoCategSource === 'merchant_lookup') return 'review';
  return 'uncertain';
};

const confidenceLevelForUnmatched = (reviewItem) => {
  const source = reviewItem?.payload?.auto_categorize_source || '';
  const confidence = reviewItem?.payload?.auto_categorize_confidence;

  if (source === 'client_rule') return 'confident';
  if (source === 'merchant_lookup' && confidence >= 0.85) return 'confident';
  if (source === 'merchant_lookup') return 'review';
  if (source.includes('vendor_signal')) return 'review';
  if (source.includes('word_overlap')) return 'uncertain';
  if (!source) return 'uncertain';
  return 'review';
};

const buildProactiveAskClient = ({ transaction, confidence }) => {
  if (confidence === 'confident') return null;
  const desc = String(transaction?.description || transaction?.raw_description || '').trim();
  const merchantHint = desc
    .replace(/^(card|wire|debit|credit|payment|transfer|sale)\s+/i, '')
    .split(/[|,:(]/)[0]
    .trim()
    .slice(0, 60);
  const amountIn = Number(transaction?.money_in || 0);
  const amount = Number(transaction?.money_out || transaction?.money_in || 0);
  const currency = transaction?.currency || transaction?.account_currency || '';
  // The pg driver returns DATE columns as JavaScript Date objects (not
  // ISO strings), so `String(transaction.transaction_date)` lands as
  // "Mon Jun 16 2025 00:00:00 GMT+0000…" — and `.slice(0, 10)` of THAT
  // produces "Mon Jun 16", which `new Date(…T00:00:00)` then refuses
  // to parse. Honeybee's IRS row hit exactly this and rendered the
  // client question as "on Invalid Date for USD 3683.67". Coerce
  // through `new Date(...)` directly: it accepts both Date instances
  // (returns a copy) and ISO strings, and we validate before formatting.
  const datePart = transaction?.transaction_date || transaction?.date || null;
  let dateStr = '';
  if (datePart) {
    const parsed = datePart instanceof Date ? datePart : new Date(datePart);
    if (!Number.isNaN(parsed.getTime())) {
      dateStr = parsed.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    }
  }

  const parts = [];
  if (merchantHint) parts.push(`the ${merchantHint} transaction`);
  else parts.push('this transaction');
  const meta = [dateStr, amount > 0 ? `${currency} ${amount.toFixed(2)}` : ''].filter(Boolean).join(' for ');
  if (meta) parts.push(`on ${meta}`);

  // Direction-aware wording: asking whether incoming money is "a
  // business expense" read as nonsense on a EUR 7,500 capital receipt.
  const purposeWord = amountIn > 0 ? 'business income' : 'a business expense';
  const question = `Hi — quick check on ${parts.join(' ')}. Could you let me know what this was for and confirm whether it's ${purposeWord}? Thanks!`;
  return {
    question,
    evidence_type: 'business_purpose',
    reason: confidence === 'uncertain'
      ? 'No matching vendor pattern or supporting document — client confirmation recommended.'
      : 'Category suggestion has limited confidence — client confirmation recommended.'
  };
};

// The strong coding pass (#312, batch-suggest) writes its verdict to
// payload.ai_suggestion on both the transaction and its review item.
// When present it is THE decision for this line: the model's own
// confidence and its own ask-or-not call (evidence_required +
// ask_client_question, which it leaves empty when no question is
// needed). matchExplanation's legacy confidence ladder reads only
// auto_categorize_source — a tag the strong model never writes — so
// without consulting the verdict every model-coded line falls to
// `!source → uncertain` and manufactures an ask-client card even when
// the model explicitly declined to ask (a self-evident FX fee, a
// service charge, interest earned). Read the model's verdict; do not
// re-derive a competing one. Returns null when no real coding verdict
// exists (pre-#312 / parse-time-only lines) so the legacy ladder still
// governs those.
const CODING_CONFIDENCE_LEVEL = { high: 'confident', medium: 'review', low: 'uncertain' };
const readCodingVerdict = ({ transaction, reviewItem }) => {
  const suggestion =
    reviewItem?.payload?.ai_suggestion ||
    transaction?.payload?.ai_suggestion ||
    null;
  if (!suggestion || typeof suggestion !== 'object') return null;
  // A verdict that names a missing CoA account is a REAL verdict even
  // though it parks in Suspense — the model knows exactly what the
  // line is; the chart just can't hold it. Without this carve-out the
  // deliberate park fell back to the legacy ladder, which re-derived
  // "uncertain → ask the client" for a line whose terminal action is
  // firm-side (create the account), not a client question.
  const missingAccount =
    suggestion.missing_account &&
    typeof suggestion.missing_account === 'object' &&
    suggestion.missing_account.name
      ? suggestion.missing_account
      : null;
  const account = String(suggestion.proposed_account || suggestion.account_code || '').trim();
  if (!missingAccount && (!account || account.toLowerCase() === 'suspense')) return null;
  const confidence = CODING_CONFIDENCE_LEVEL[String(suggestion.confidence || '').toLowerCase()] || 'review';
  const wantsClientInput =
    !missingAccount &&
    (suggestion.evidence_required === true ||
      String(suggestion.ask_client_question || '').trim().length > 0);
  return {
    account,
    confidence,
    wantsClientInput,
    missingAccount,
    reasoning: String(suggestion.reasoning || '').slice(0, 500)
  };
};

export const generateMatchExplanation = ({
  transaction,
  match,
  document,
  reviewItem
} = {}) => {
  const payload = reviewItem?.payload || {};
  const category = payload.category || payload.proposed_account || transaction?.category || null;
  const accountCode = payload.account_code || transaction?.account_code || null;
  const autoSource = payload.auto_categorize_source || '';
  const autoVendor = payload.auto_categorize_vendor || '';
  const ruleId = payload.matched_client_rule_id || null;
  // The firm's own words when they categorized WITH a reason (a feed-chat
  // apply_category) or left a note — echoed on the artifact instead of a
  // generic "Categorized by the firm" (#388 follow-up).
  const reviewerNote = String(payload.reviewer_note || '').trim().slice(0, 300);
  // Read the strong coder's persisted verdict once, up front — the
  // missing-account flag must surface on every branch (matched or not).
  const verdict = readCodingVerdict({ transaction, reviewItem });
  // The firm's accept outranks every ask-client branch below; evidence
  // owed (the #378 pill) is rendered as "documentation to follow", never
  // as a fresh client question.
  const firmDecided = isFirmDecided(reviewItem);
  const evidenceOwed =
    reviewItem?.payload?.ai_suggestion?.evidence_required === true ||
    transaction?.payload?.ai_suggestion?.evidence_required === true;

  // --- Matched transaction (has reconciliation match + document) ---
  if (match && document) {
    const matchReason = match.match_reason || match.payload?.match_reason || {};
    // Prefer the document's own counterparty; when it was extracted without
    // one (sparse payout settlement), the bank line names the same party
    // reliably — fall back to it before the raw filename.
    const vendorName = document.vendor_name
      || document.customer_name
      || cleanBankCounterparty(transaction)
      || document.filename;
    const docType = document.document_type === 'sales_invoice' ? 'invoice'
      : document.document_type === 'supplier_bill' ? 'bill'
      : document.document_type || 'document';
    // The settled amount: the document total when extracted, else the match's
    // settled amount, else the bank line. Currency falls back the same way so
    // we never print a bare number or a "null" currency.
    const matchAmt = Number(match.match_amount);
    const docAmount = formatMoney(
      document.total_amount ?? (Number.isFinite(matchAmt) && matchAmt !== 0 ? matchAmt : null),
      document.currency || transaction?.currency || transaction?.account_currency
    );

    const reasons = [];
    const amountPhrase = buildAmountPhrase(matchReason);
    if (amountPhrase) reasons.push(amountPhrase);
    const vendorPhrase = buildVendorPhrase(matchReason, document);
    if (vendorPhrase) reasons.push(vendorPhrase);
    const datePhrase = buildDatePhrase(matchReason);
    if (datePhrase) reasons.push(datePhrase);
    if (matchReason.hints?.includes('ref_match')) reasons.push('reference number matches');

    const confidence = confidenceLevelForMatch(match, reviewItem);
    const verb = confidence === 'confident' ? 'Matched' : 'Likely match';
    const headline = vendorName
      ? `${verb} to ${vendorName} ${docType}${docAmount ? ` (${docAmount})` : ''}`
      : `${verb} to ${docType}${docAmount ? ` for ${docAmount}` : ''}`;

    const reasonText = reasons.length
      ? reasons.join(', ') + '.'
      : `Based on ${docType} details.`;

    let categoryReason = null;
    if (category && category !== 'Suspense' && category !== 'unknown') {
      if (autoSource === 'client_rule') {
        categoryReason = `Categorized as **${category}** based on a learned rule for ${autoVendor || vendorName}.`;
      } else if (autoSource === 'merchant_lookup') {
        categoryReason = `Categorized as **${category}** — ${autoVendor || vendorName} identified as ${payload.auto_categorize_vendor || 'a known vendor'}.`;
      } else if (autoSource.includes('vendor_signal')) {
        categoryReason = `Categorized as **${category}** based on vendor pattern matching.`;
      } else {
        categoryReason = `Categorized as **${category}**.`;
      }
    }

    return {
      confidence,
      headline,
      explanation: reasonText.charAt(0).toUpperCase() + reasonText.slice(1),
      categoryReason,
      documentFile: document.filename || null,
      documentId: document.id || null,
      documentUrl: document.file_url || null,
      matchId: match.id || null,
      matchScore: matchReason.score || match.match_confidence || null,
      actions: confidence === 'confident' ? ['chat'] : ['chat', 'ask_client'],
      missing_account: verdict?.missingAccount || null,
      // A document-backed match means we have evidence — don't push the
      // firm toward a redundant "ask the client what this was for" card,
      // even when the match is merely "suggested" (review/uncertain
      // confidence). The `actions` array keeps 'ask_client' so the firm
      // can still choose to ask; it's the proactive CARD we suppress.
      proactive_ask_client: (isMeaningfulMatch(match) || firmDecided)
        ? null
        : buildProactiveAskClient({ transaction, confidence })
    };
  }

  // --- Unmatched transaction (auto-categorized only) ---
  // The strong coder's verdict, when present, outranks the legacy
  // source-tag ladder for BOTH confidence and the ask-client card.
  // A firm-decided line is settled — render it confidently, which also
  // drops 'ask_client' from the actions array and suppresses the
  // proactive card below.
  const confidence = firmDecided
    ? 'confident'
    : (verdict ? verdict.confidence : confidenceLevelForUnmatched(reviewItem));

  // A missing-account verdict renders as what it is: a recognized line
  // blocked on a firm-side chart-of-accounts action. The legacy ladder
  // must not re-derive "uncertain → ask the client" here — the client
  // cannot create the account.
  if (verdict?.missingAccount) {
    const missing = verdict.missingAccount;
    const typeLabel = missing.account_type ? ` (${missing.account_type})` : '';
    return {
      confidence,
      headline: `Needs a new account: ${missing.name}${typeLabel}`,
      explanation: `${missing.reason ? `${String(missing.reason).trim()} ` : ''}Parked in Suspense until "${missing.name}" exists in the chart of accounts — a firm-side action, not a client question.`,
      categoryReason: null,
      documentFile: null,
      documentId: null,
      matchId: null,
      matchScore: null,
      actions: ['chat', 'create_account'],
      missing_account: missing,
      proactive_ask_client: null
    };
  }
  // Card follows the model's own ask-or-not decision when a verdict
  // exists; falls back to the confidence-driven card otherwise.
  const unmatchedAskClient = firmDecided
    ? null
    : verdict
      ? (verdict.wantsClientInput ? buildProactiveAskClient({ transaction, confidence }) : null)
      : buildProactiveAskClient({ transaction, confidence });

  // A normal verdict renders ITS OWN narrative — the account and the
  // model's reasoning. #315 routed confidence and the ask-card through
  // the verdict but left the headline on the legacy payload.category,
  // so an applied Sales line (account_code 'Sales', gpt-5.4 verdict on
  // the row) still introduced itself as "income — Categorized based on
  // available signals." The verdict is the decision; the parse-time
  // category is the layer it superseded.
  if (verdict) {
    return {
      confidence,
      headline: verdict.account,
      explanation: verdict.reasoning || 'Coded by the AI review pass.',
      categoryReason: null,
      documentFile: null,
      documentId: null,
      matchId: null,
      matchScore: null,
      actions: confidence === 'confident' ? ['chat'] : ['chat', 'ask_client'],
      missing_account: null,
      proactive_ask_client: unmatchedAskClient
    };
  }

  if (category && category !== 'Suspense' && category !== 'unknown') {
    let headline;
    let explanation;

    if (autoSource === 'client_rule') {
      headline = `${autoVendor || 'Transaction'} → ${category}`;
      explanation = `Auto-categorized by a learned rule${autoVendor ? ` for ${autoVendor}` : ''}.`;
    } else if (autoSource === 'merchant_lookup') {
      headline = `${autoVendor || 'Transaction'} → ${category}`;
      explanation = autoVendor
        ? `${autoVendor} identified as a vendor for this category.`
        : `Merchant identified and mapped to this account.`;
    } else if (autoSource.includes('vendor_signal')) {
      headline = `${autoVendor || 'Transaction'} → ${category}`;
      explanation = `Categorized by vendor pattern recognition${autoVendor ? ` (${autoVendor})` : ''}.`;
    } else if (firmDecided) {
      // The firm coded this line itself (drawer recode or a feed-chat
      // mass command) — say so. When the firm gave a reason, echo their
      // OWN words; surface the evidence-owed state instead of "available
      // signals" (which reads as a guess).
      headline = category;
      if (reviewerNote) {
        explanation = `Categorized by the firm: “${reviewerNote}”`
          + (evidenceOwed ? ' — supporting documentation to follow.' : '');
      } else {
        explanation = evidenceOwed
          ? 'Categorized by the firm — supporting documentation to follow.'
          : 'Categorized by the firm.';
      }
    } else {
      headline = category;
      explanation = 'Categorized based on available signals.';
    }

    return {
      confidence,
      headline,
      explanation,
      categoryReason: null,
      documentFile: null,
      documentId: null,
      matchId: null,
      matchScore: null,
      actions: confidence === 'confident' ? ['chat'] : ['chat', 'ask_client'],
      missing_account: null,
      proactive_ask_client: unmatchedAskClient
    };
  }

  // --- No categorization at all ---
  return {
    confidence: 'uncertain',
    headline: 'Uncategorized transaction',
    explanation: 'No matching vendor pattern or document found. Review the bank description or ask the client.',
    categoryReason: null,
    documentFile: null,
    documentId: null,
    matchId: null,
    matchScore: null,
    actions: firmDecided ? ['chat'] : ['chat', 'ask_client'],
    missing_account: null,
    proactive_ask_client: firmDecided
      ? null
      : buildProactiveAskClient({ transaction, confidence: 'uncertain' })
  };
};
