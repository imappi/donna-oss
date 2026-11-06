import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { canonicalMerchantPattern } from './transactionIntel.js';

const DEFAULT_MODEL = 'claude-opus-4-8';
const MAX_MERCHANTS_PER_CALL = 20;

let dotEnvCache = null;

const readDotEnv = () => {
  if (dotEnvCache) return dotEnvCache;
  const vars = {};
  try {
    const envPath = resolvePath(process.cwd(), '.env');
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const match = line.match(/^(\w+)=(.*)$/);
        if (match) vars[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
      }
    }
  } catch {
    // Best-effort dotenv fallback.
  }
  dotEnvCache = vars;
  return vars;
};

const getAnthropicConfig = () => {
  const dotEnv = readDotEnv();
  return {
    apiKey: process.env.ANTHROPIC_API_KEY || dotEnv.ANTHROPIC_API_KEY || '',
    model: process.env.MERCHANT_LOOKUP_MODEL || dotEnv.MERCHANT_LOOKUP_MODEL || DEFAULT_MODEL
  };
};

export const isMerchantLookupEnabled = () => {
  const dotEnv = readDotEnv();
  const flag = process.env.MERCHANT_LOOKUP_ENABLED || dotEnv.MERCHANT_LOOKUP_ENABLED || '';
  return flag === 'true' || flag === '1';
};

const SYSTEM_PROMPT = `You identify merchants from bank transaction descriptions and map them to chart-of-accounts entries.

You receive:
- A company name (the bank account holder — NOT the merchant)
- Their chart of accounts (the set of GL accounts they use)
- Bank transaction descriptions to identify

For each description, figure out what company/merchant it refers to, what that company sells or provides, and which chart-of-accounts entry is the best match.

Rules:
- The "merchant" is the counterparty — who the money went TO (for debits) or came FROM (for credits).
- Match to the MOST SPECIFIC account in the CoA. "Vehicle Fuel" is better than "Operating Expenses" for a gas station.
- If no CoA account is a reasonable match, use the code and name of their closest general/suspense account.
- Bank descriptions are often garbled, truncated, or abbreviated. Use your knowledge of real companies to decode them.
- The currency field is the persisted transaction denomination. "unknown" means unresolved. Currency evidence is provenance only: do not replace an unknown currency with a candidate, filename hint, book currency, company location or merchant location, and do not infer jurisdiction from currency.
- confidence should be "high" if you're sure about both merchant identity AND account, "medium" if the merchant is clear but account is a judgment call, "low" if the description is too garbled to identify.
- Skip descriptions you cannot identify at all — omit them from the response.

Respond with ONLY a JSON object. No markdown, no explanation.`;

const buildUserPrompt = ({ clientName, accounts, merchants }) => {
  const coaLines = accounts
    .map((a) => `  ${a.code || '—'} | ${a.name} (${a.account_type || 'unknown'})`)
    .join('\n');

  const merchantLines = merchants
    .map((m, i) => `${i + 1}. "${m.bankDescription}" (${m.direction}, amount: ${m.amount}, currency: ${m.currency || 'unknown'})${
      m.currencyResolution ? `\n   Currency evidence (provenance only): ${JSON.stringify(m.currencyResolution)}` : ''
    }`)
    .join('\n');

  return `Company: ${clientName || 'Unknown'}

Chart of Accounts:
${coaLines}

Bank descriptions to identify:
${merchantLines}

Return a JSON object with this exact shape:
{
  "merchants": [
    {
      "index": 1,
      "merchant_name": "Company Name",
      "merchant_category": "what they sell/provide",
      "suggested_account_code": "5000",
      "suggested_account_name": "Account Name",
      "confidence": "high",
      "reasoning": "brief explanation"
    }
  ]
}`;
};

const extractJsonFromText = (text = '') => {
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* fall through */ }
    }
    return null;
  }
};

export const lookupMerchants = async ({ merchants, accounts, clientName }) => {
  if (!merchants?.length || !accounts?.length) return [];

  const config = getAnthropicConfig();
  if (!config.apiKey) return [];

  const batch = merchants.slice(0, MAX_MERCHANTS_PER_CALL);
  const userPrompt = buildUserPrompt({ clientName, accounts, merchants: batch });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error('[merchantLookup] API error', { status: response.status, error: err?.error?.message });
      return [];
    }

    const raw = await response.json();
    const text = raw?.content?.[0]?.text || '';
    const parsed = extractJsonFromText(text);

    if (!parsed?.merchants || !Array.isArray(parsed.merchants)) {
      console.error('[merchantLookup] unexpected response shape', { text: text.slice(0, 200) });
      return [];
    }

    return parsed.merchants
      .filter((m) => m.merchant_name && m.suggested_account_code && m.confidence !== 'low')
      .map((m) => {
        const idx = Number(m.index) - 1;
        const source = batch[idx];
        if (!source) return null;
        return {
          canonicalPattern: source.canonicalPattern,
          bankDescription: source.bankDescription,
          merchantName: m.merchant_name,
          merchantCategory: m.merchant_category || '',
          accountCode: String(m.suggested_account_code),
          accountName: m.suggested_account_name || '',
          confidence: m.confidence === 'high' ? 0.88 : 0.75,
          confidenceLabel: m.confidence || 'medium',
          reasoning: m.reasoning || ''
        };
      })
      .filter(Boolean);
  } catch (error) {
    console.error('[merchantLookup] request failed', { error: error?.message || String(error) });
    return [];
  }
};

export const deduplicateMerchants = (rows) => {
  const seen = new Map();
  for (const row of rows) {
    const desc = row.description || row.raw_description || '';
    const pattern = canonicalMerchantPattern(desc);
    if (!pattern || pattern.length < 3) continue;
    if (seen.has(pattern)) continue;
    seen.set(pattern, {
      canonicalPattern: pattern,
      bankDescription: desc,
      direction: Number(row.money_in || 0) > 0 ? 'credit' : 'debit',
      amount: Number(row.money_out || row.money_in || 0).toFixed(2),
      currency: row.currency || null,
      currencyResolution: row.transaction_payload?.currency_resolution ?? row.currency_resolution ?? null,
      reviewId: row.review_id,
      transactionId: row.transaction_id
    });
  }
  return [...seen.values()];
};
