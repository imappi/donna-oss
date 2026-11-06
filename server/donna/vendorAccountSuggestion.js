// Deterministic vendor → account suggestion. Maps vendor names (from
// matched documents or bank descriptions) to chart-of-accounts entries
// using keyword signals. No LLM call — pure pattern matching so it's
// instant and predictable.
//
// Two-pass approach:
//   1. Filter by expected account_type (fuel → expense, not liability)
//   2. Score by keyword specificity (more keyword hits = better match)

const VENDOR_SIGNALS = [
  { pattern: /chevron|shell\b|exxon|bp\b|mobil|texaco|citgo|valero|arco|sinclair|conoco|marathon|pilot|loves|casey|wawa|racetrac|quiktrip|speedway/i, keywords: ['fuel', 'vehicle', 'gas', 'auto', 'petrol'], accountTypes: ['expense'] },
  { pattern: /progressive|geico|state farm|allstate|liberty mutual|farmers insurance|usaa|nationwide|travelers|hartford/i, keywords: ['insurance'], accountTypes: ['expense'] },
  { pattern: /verizon|vzw|vzwrlss|at&t|att\b|t-?mobile|sprint|comcast|spectrum|xfinity|cox|centurylink|frontier/i, keywords: ['telephone', 'internet', 'telecom', 'utilities'], accountTypes: ['expense'] },
  { pattern: /\b(aps|duke energy|pge|pg&e|edison|electric|power|energy|entergy|xcel|dominion|ameren|austin energy|tucson elec)\b/i, keywords: ['utilities', 'electric'], accountTypes: ['expense'] },
  { pattern: /\b(sw gas|gas corp|natural gas|atmos|centerpoint|nicor|spire|texas gas)\b/i, keywords: ['utilities', 'gas'], accountTypes: ['expense'] },
  { pattern: /\b(water|sewer|wastewater|phx water|austin water|city of.*water)\b/i, keywords: ['utilities', 'water'], accountTypes: ['expense'] },
  { pattern: /intuit|quickbooks|qbo|xero|freshbooks|wave|sage/i, keywords: ['subscriptions', 'software', 'education'], accountTypes: ['expense'] },
  { pattern: /\b(bank fee|service charge|maintenance fee|foreign transaction|monthly fee|overdraft|acct maintenance)\b/i, keywords: ['bank', 'fee', 'card fee'], accountTypes: ['expense'] },
  { pattern: /shopify|square|gosq|stripe|paypal|venmo|payout|deposit|branch deposit/i, keywords: ['sales', 'revenue', 'income', 'retail'], accountTypes: ['revenue'] },
  { pattern: /\b(lease|rent)\b/i, keywords: ['rent', 'lease'], accountTypes: ['expense'] },
  { pattern: /owner.*distribut|owner.*draw/i, keywords: ['owner', 'draw', 'equity'], accountTypes: ['equity'] },
  { pattern: /\b(transfer|xfer|online transfer|xfer to sav)/i, keywords: ['checking', 'savings', 'transfer', 'operating'], accountTypes: ['asset'] },
  { pattern: /\birs\b|usataxpymt|federal\s+tax/i, keywords: ['license', 'federal', 'income'], accountTypes: ['expense'], requiredNameContains: ['tax'], exclusive: true },
  { pattern: /tax\s*(?:payment|pymt)|state tax/i, keywords: ['tax', 'license'], accountTypes: ['expense', 'liability'] },
  { pattern: /amex.*(?:payment|epayment)|visa.*payment|credit card.*payment/i, keywords: ['credit card'], accountTypes: ['liability'] },
  { pattern: /tractor supply|tsc stores/i, keywords: ['equipment', 'hive', 'maintenance', 'supplies'], accountTypes: ['expense', 'cost_of_sales'] },
  { pattern: /dadant|mann\s*lake|mannlake|mannlakeltd/i, keywords: ['bee', 'hive', 'stock', 'supplies', 'equipment'], accountTypes: ['cost_of_sales', 'expense'] },
  { pattern: /farmers?\s*(?:market|mkt)/i, keywords: ['marketing', 'sales', 'market'], accountTypes: ['expense'] },
  { pattern: /office|staples|depot/i, keywords: ['office'], accountTypes: ['expense'] },
  { pattern: /amazon|aws|amzn/i, keywords: ['software', 'supplies', 'office'], accountTypes: ['expense'] },
  { pattern: /interest\s*earned/i, keywords: ['interest', 'income', 'other income'], accountTypes: ['revenue'] },
  { pattern: /doordash|uber\s*eats|grubhub|toast\b/i, keywords: ['sales', 'revenue', 'income'], accountTypes: ['revenue'] },
  { pattern: /gusto|adp|paychex/i, keywords: ['payroll', 'wages', 'salaries'], accountTypes: ['expense'] },
];

const normalizeForMatch = (s) => String(s || '').toLowerCase().trim();

// requiredNameContains is an optional list of substrings the account
// name MUST contain (all of them) to be eligible. Used by high-stakes
// signals like IRS / federal-tax payments where a loose keyword hit
// against the wrong account (e.g. "Property Tax" for an IRS federal
// income tax payment) is worse than not auto-categorising at all.
const scoreAccount = (account, keywords, preferredTypes, requiredNameContains) => {
  const name = normalizeForMatch(account.name || account.account_name);
  const type = normalizeForMatch(account.account_type || account.type);

  if (requiredNameContains?.length) {
    for (const req of requiredNameContains) {
      if (!name.includes(normalizeForMatch(req))) return 0;
    }
  }

  let score = 0;
  for (const kw of keywords) {
    if (name.includes(kw)) score += kw.length;
  }
  if (score === 0) return 0;

  if (preferredTypes?.length && preferredTypes.includes(type)) {
    score += 10;
  }

  return score;
};

export const suggestAccountForVendor = (vendorName, bankDescription, accounts) => {
  if (!accounts?.length) return null;
  const vendor = normalizeForMatch(vendorName);
  const desc = normalizeForMatch(bankDescription);
  const combined = `${vendor} ${desc}`;

  for (const signal of VENDOR_SIGNALS) {
    if (!signal.pattern.test(combined)) continue;

    let bestAccount = null;
    let bestScore = 0;

    for (const account of accounts) {
      const s = scoreAccount(account, signal.keywords, signal.accountTypes, signal.requiredNameContains);
      if (s > bestScore) {
        bestScore = s;
        bestAccount = account;
      }
    }

    if (bestAccount) {
      return { account: bestAccount, confidence: 'high', source: 'vendor_signal' };
    }

    // Exclusive signals (e.g. IRS) refuse to fall through when the
    // descriptor unambiguously matched but no account scored. Falling
    // through would let a lower-priority pattern (state-tax) or the
    // word-overlap fallback pick a marginal account — for IRS that
    // means routing federal-income-tax payments to Sales Tax Payable
    // or Property Tax. Better to leave for manual review.
    if (signal.exclusive) return null;
  }

  const vendorWords = vendor.split(/\s+/).filter((w) => w.length > 3);
  for (const word of vendorWords) {
    const match = accounts.find((a) =>
      normalizeForMatch(a.name || a.account_name).includes(word)
    );
    if (match) return { account: match, confidence: 'medium', source: 'word_overlap' };
  }

  return null;
};
