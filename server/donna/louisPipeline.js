import { extractJson } from './extractJson.js';

export const LOUIS_PIPELINE_SYSTEM = `You are Louis, a senior QA reviewer for an AI bookkeeping assistant called Donna.

Your job is to evaluate a pipeline decision — an automated match or categorization that the system is about to apply to a client's books. You are NOT making the decision — you are auditing a decision that was already made.

You evaluate two types of decisions:

## Match decisions (reconciliation)
A bill/receipt/invoice was matched to a bank transaction. Evaluate:
1. **amount_validity** — Is the amount match genuine, or coincidental? Exact matches on round numbers ($100, $500) deserve more scrutiny than precise amounts ($127.43).
2. **vendor_identity** — Does the vendor identity hold up? Consider: document vendor name vs bank description, fuzzy matching quality, whether the match relies on filename extraction.
3. **date_plausibility** — Is the date relationship plausible? Bills are typically paid within terms (Net 30/60). A 6-month gap is suspicious.
4. **red_flags** — Are there red flags? Currency mismatch risk, duplicate payment risk, partial payment without clear evidence, competing candidates.

## Categorization decisions
A transaction was assigned to a ledger account. Evaluate:
1. **account_fit** — Is the account appropriate for this merchant/description? "Office Depot" → "Office Supplies" is good; "Office Depot" → "Vehicle Fuel" is wrong.
2. **type_correctness** — Is the account type correct? An expense should not be coded as revenue, an asset should not be coded as expense unless it's clearly consumable.
3. **policy_sensitivity** — Are there policy-sensitive signals missed? Tax, payroll, director/shareholder transactions, personal/mixed-use, capital vs expense ambiguity.
4. **pattern_stability** — Is this a stable mapping that would hold for future transactions from the same vendor?

## Scoring
Score each applicable dimension 1-5.

## Verdict rules
- If ANY dimension scores 2 or below → verdict is "fail"
- If ALL dimensions score 4 or above → verdict is "pass"
- Otherwise → verdict is "warn"

## Output format
Return ONLY valid JSON:
{
  "verdict": "pass" | "warn" | "fail",
  "scores": { ... },
  "reasoning": "<2-3 sentences explaining your verdict, focusing on the most important issue>"
}`;

export const buildPipelineEvalPrompt = ({
  decision,
  document,
  transaction,
  chartOfAccounts,
  clientProfile
}) => {
  const sections = [];

  sections.push(`## Decision record
- Type: ${decision.decision_type}
- Target: ${decision.target_type} / ${decision.target_id}
- Lane: ${decision.lane}
- Confidence: ${JSON.stringify(decision.confidence)}
- Deterministic signals: ${JSON.stringify(decision.deterministic_signals)}
- LLM reasoning: ${decision.llm_reasoning || 'N/A'}
- Policy blockers: ${(decision.policy_blockers || []).join(', ') || 'none'}`);

  if (document) {
    sections.push(`## Document
- Filename: ${document.filename || document.file_name || 'unknown'}
- Type: ${document.document_type || 'unknown'}
- Vendor: ${document.vendor_name || 'NULL (not extracted)'}
- Amount: ${document.total_amount ?? 'unknown'} ${document.currency || ''}
- Date: ${document.document_date || 'unknown'}
- Due date: ${document.due_date || 'N/A'}
- Reference: ${document.reference_number || 'N/A'}
- Extraction confidence: ${document.extraction_confidence ?? 'unknown'}`);
  }

  if (transaction) {
    sections.push(`## Transaction
- Description: ${transaction.description || 'unknown'}
- Raw description: ${transaction.raw_description || 'N/A'}
- Contact: ${transaction.contact || 'N/A'}
- Amount: ${transaction.money_out || transaction.money_in || 'unknown'} ${transaction.currency || ''}
- Date: ${transaction.date || transaction.transaction_date || 'unknown'}
- Account: ${transaction.account_name || transaction.proposed_account || 'N/A'}
- Account code: ${transaction.account_code || 'N/A'}`);
  }

  if (chartOfAccounts?.length) {
    const relevant = chartOfAccounts.slice(0, 20).map(
      (a) => `  - ${a.code || 'N/A'}: ${a.name} (${a.account_type || a.type || 'unknown'})`
    );
    sections.push(`## Chart of accounts (excerpt)\n${relevant.join('\n')}`);
  }

  if (clientProfile) {
    sections.push(`## Client
- Company: ${clientProfile.companyName || clientProfile.company_name || 'unknown'}
- Industry: ${clientProfile.industry || 'unknown'}`);
  }

  sections.push('Evaluate this pipeline decision. Return your JSON verdict.');

  return sections.join('\n\n');
};

export const evaluatePipelineDecision = async ({
  decision,
  document,
  transaction,
  chartOfAccounts,
  clientProfile,
  apiKey,
  model = 'claude-opus-4-8'
} = {}) => {
  if (!apiKey) return null;
  if (!decision) return null;

  const startedAt = Date.now();
  const userPrompt = buildPipelineEvalPrompt({
    decision,
    document,
    transaction,
    chartOfAccounts,
    clientProfile
  });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 768,
      system: LOUIS_PIPELINE_SYSTEM,
      messages: [
        { role: 'user', content: userPrompt }
      ]
    })
  });

  const raw = await response.json();
  if (!response.ok) {
    const errorMsg = raw?.error?.message || 'Anthropic API request failed.';
    const error = new Error(errorMsg);
    error.statusCode = response.status;
    throw error;
  }

  const modelText = raw?.content?.[0]?.text || '';
  const parsed = extractJson(modelText);

  return {
    verdict: parsed.verdict || 'warn',
    scores: parsed.scores || {},
    reasoning: parsed.reasoning || '',
    model,
    latency_ms: Math.round(Date.now() - startedAt)
  };
};
