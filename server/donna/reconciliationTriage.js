import { extractJson } from './extractJson.js';
import { isBankLineOnlyExplained } from './reconciliationLlmCore.js';
import { applyConvergenceStateBestEffort } from './reconcileConvergenceState.js';
import { EVIDENCE_RESOLVABLE_ASK_TYPES } from './reconciliationTwinAging.js';
import { classifyLane } from './lanePolicy.js';
import { evaluatePipelineDecision } from './louisPipeline.js';
import { recordLlmDecision, recordLouisVerdict } from './llmDecisions.js';

const DEFAULT_MODEL = 'claude-opus-4-8';
const MAX_CANDIDATES_PER_CALL = 10;
const TRIAGE_CONFIDENCE_CEILING = 0.85;

const TRIAGE_SYSTEM_PROMPT = `You evaluate low-confidence document-to-transaction match candidates for an AI bookkeeping assistant.

The deterministic scorer found these candidates where amounts match but other evidence is weak — typically missing vendor confirmation, no reference match, or vendor extracted only from the filename. Your job: decide whether each candidate is a genuine match.

For each candidate, evaluate:
1. **Vendor identity** — Does the bank description plausibly refer to the same entity as the document vendor/filename? Consider abbreviations, DBA names, payment processors (e.g. "STRIPE" in bank for a "Stripe Inc" bill).
2. **Date plausibility** — Is the payment date reasonable? Bills are typically paid within terms (Net 30/60). Receipts are same-day or next-day.
3. **Amount significance** — Is the matching amount specific enough? $127.43 is strong evidence; $100.00 could be coincidental.
4. **Context clues** — Do other tokens in the bank description (reference numbers, memo text) corroborate the match?

Rules:
- "match": you are confident this is the same real-world payment
- "no_match": the match is coincidental despite the amount
- "review": you cannot decide — a human should look
- Be conservative: when in doubt, return "review"
- Round-number amounts ($50, $100, $500, $1000) with no vendor evidence → "review" or "no_match"
- A vendor name appearing in truncated/abbreviated form in the bank description IS valid evidence

Return ONLY valid JSON:
{
  "candidates": [
    {
      "index": 1,
      "verdict": "match",
      "confidence": 0.87,
      "reasoning": "Brief explanation"
    }
  ]
}`;

export const buildTriageUserPrompt = ({ candidates, clientProfile }) => {
  const sections = [];

  if (clientProfile) {
    sections.push(
      `Company: ${clientProfile.companyName || clientProfile.company_name || 'Unknown'}\nIndustry: ${clientProfile.industry || 'Unknown'}`
    );
  }

  sections.push('Candidates to evaluate:\n');

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const doc = c.document || {};
    const tx = c.transaction || {};
    const mr = c.match_reason || {};
    const hints = mr.hints || [];

    const vendorLabel = doc.vendor_name || doc.customer_name || 'NULL (not extracted)';
    const summary = doc.parse_summary || {};
    const vendorCandidates = !doc.vendor_name && Array.isArray(summary.vendor_candidates)
      ? summary.vendor_candidates.slice(0, 3)
      : [];
    const candidateLines = vendorCandidates.length
      ? `\n  Vendor candidates: ${vendorCandidates.map((vc) => `${vc.value} (${vc.source}, conf ${vc.confidence})`).join('; ')}`
      : '';

    sections.push(`--- Candidate ${i + 1} ---
Document:
  Filename: ${doc.filename || 'unknown'}
  Vendor: ${vendorLabel}${candidateLines}
  Amount: ${doc.total_amount ?? 'unknown'} ${doc.currency || ''}
  Date: ${doc.document_date || 'unknown'}
  Due date: ${doc.due_date || 'N/A'}
  Type: ${doc.document_type || 'unknown'}
  Reference: ${doc.reference_number || 'N/A'}
  Extraction confidence: ${doc.extraction_confidence ?? 'unknown'}

Transaction:
  Description: ${tx.description || 'unknown'}
  Raw description: ${tx.raw_description || 'N/A'}
  Contact: ${tx.contact || 'N/A'}
  Amount: ${tx.money_out || tx.money_in || 'unknown'} ${tx.currency || ''}
  Date: ${tx.date || tx.transaction_date || 'unknown'}

Deterministic signals:
  Tier: ${mr.confidence_tier || 'unknown'}
  Score: ${mr.score ?? 'unknown'}
  Amount exact: ${mr.amount?.exact ?? 'unknown'}
  Amount delta: ${mr.amount?.delta ?? 'N/A'}
  Date gap (days): ${mr.date?.gap_days ?? 'unknown'}
  Vendor overlap: ${hints.includes('vendor_overlap') ? 'yes' : 'no'}
  Reference match: ${hints.includes('reference_match') ? 'yes' : 'no'}
  Extraction source: ${mr.extraction_source || 'standard'}`);
  }

  return sections.join('\n\n');
};

export const parseTriageResponse = (text) => {
  const parsed = extractJson(text);
  if (!parsed?.candidates || !Array.isArray(parsed.candidates)) {
    return [];
  }
  return parsed.candidates.map((c) => ({
    index: Number(c.index) - 1,
    verdict: ['match', 'no_match', 'review'].includes(c.verdict) ? c.verdict : 'review',
    confidence: typeof c.confidence === 'number' ? Math.min(Math.max(c.confidence, 0), 1) : 0.5,
    reasoning: String(c.reasoning || '')
  }));
};

const callTriageLlm = async ({ candidates, clientProfile, apiKey, model = DEFAULT_MODEL }) => {
  const userPrompt = buildTriageUserPrompt({ candidates, clientProfile });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: TRIAGE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  const raw = await response.json();
  if (!response.ok) {
    const msg = raw?.error?.message || 'Anthropic API request failed';
    console.error('[reconciliationTriage] API error', { status: response.status, error: msg });
    return [];
  }

  const text = raw?.content?.[0]?.text || '';
  return parseTriageResponse(text);
};

const extractSignals = (candidate) => {
  const mr = candidate.match_reason || {};
  const hints = mr.hints || [];
  return {
    amount_exact: mr.amount?.exact === true || hints.includes('amount_exact'),
    date_within_window: hints.includes('within_window') ||
      (mr.date?.gap_days != null && mr.date.gap_days <= 30),
    vendor_overlap: hints.includes('vendor_overlap'),
    reference_match: hints.includes('reference_match'),
    date_gap_days: mr.date?.gap_days ?? null,
    extraction_confidence: candidate.document?.extraction_confidence ?? null,
    extraction_source: mr.extraction_source || null,
    tier: mr.confidence_tier || null
  };
};

export const triageReconciliationCandidates = async ({
  candidates = [],
  clientProfile = null,
  chartOfAccounts = null,
  apiKey,
  client,
  firmId,
  clientId
} = {}) => {
  const results = new Map();

  if (!apiKey || !candidates.length) return results;

  const triageable = [];
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i].score < TRIAGE_CONFIDENCE_CEILING) {
      triageable.push({ candidate: candidates[i], originalIndex: i });
    }
  }

  if (!triageable.length) return results;

  const txCandidateCount = new Map();
  for (const c of candidates) {
    const txId = c.transaction?.id;
    if (txId) txCandidateCount.set(txId, (txCandidateCount.get(txId) || 0) + 1);
  }

  for (let batchStart = 0; batchStart < triageable.length; batchStart += MAX_CANDIDATES_PER_CALL) {
    const batch = triageable.slice(batchStart, batchStart + MAX_CANDIDATES_PER_CALL);
    const batchCandidates = batch.map((b) => b.candidate);

    let verdicts;
    try {
      verdicts = await callTriageLlm({ candidates: batchCandidates, clientProfile, apiKey });
    } catch (error) {
      console.error('[reconciliationTriage] LLM call failed, skipping batch', {
        error: error?.message || String(error)
      });
      continue;
    }

    if (!verdicts.length) continue;

    const verdictByIndex = new Map();
    for (const v of verdicts) {
      verdictByIndex.set(v.index, v);
    }

    for (let i = 0; i < batch.length; i++) {
      const { candidate, originalIndex } = batch[i];
      const verdict = verdictByIndex.get(i) || {
        verdict: 'review',
        confidence: candidate.score,
        reasoning: 'No LLM response for this candidate'
      };

      const deterministicSignals = extractSignals(candidate);
      const hasCompeting = (txCandidateCount.get(candidate.transaction?.id) || 0) > 1;

      const signals = {
        amount_exact: deterministicSignals.amount_exact,
        date_within_window: deterministicSignals.date_within_window,
        vendor_overlap: verdict.verdict === 'match'
      };

      const upgradedScore = verdict.verdict === 'match'
        ? Math.max(verdict.confidence, candidate.score)
        : candidate.score;

      const laneResult = classifyLane({
        decisionType: 'match',
        confidence: { score: upgradedScore },
        signals,
        hasCompetingCandidates: hasCompeting,
        extractionConfidence: deterministicSignals.extraction_confidence,
        extractionSource: deterministicSignals.extraction_source
      });

      let finalState;
      if (verdict.verdict === 'no_match') {
        finalState = 'blocked';
      } else if (laneResult.lane === 'red') {
        finalState = 'blocked';
      } else if (verdict.verdict === 'match' && laneResult.lane === 'green') {
        finalState = 'auto_matched';
      } else {
        finalState = 'suggested';
      }

      let louisResult = null;
      if (finalState === 'auto_matched' && apiKey) {
        try {
          louisResult = await evaluatePipelineDecision({
            decision: {
              decision_type: 'match',
              target_type: 'reconciliation_match',
              target_id: candidate.matchId || `pending-${originalIndex}`,
              lane: 'green',
              confidence: { score: upgradedScore },
              llm_reasoning: verdict.reasoning,
              deterministic_signals: deterministicSignals
            },
            document: candidate.document,
            transaction: candidate.transaction,
            chartOfAccounts,
            clientProfile,
            apiKey
          });

          if (louisResult?.verdict === 'fail') {
            finalState = 'suggested';
          }
        } catch (error) {
          console.error('[reconciliationTriage] Louis QA failed, demoting to suggested', {
            error: error?.message || String(error)
          });
          finalState = 'suggested';
        }
      }

      let decisionId = null;
      if (client) {
        try {
          decisionId = await recordLlmDecision({
            client,
            firmId,
            clientId,
            decisionType: 'match',
            targetType: 'reconciliation_match',
            targetId: candidate.matchId || `pending-${originalIndex}`,
            modelName: DEFAULT_MODEL,
            deterministicSignals,
            confidence: { score: upgradedScore, label: verdict.verdict },
            lane: laneResult.lane,
            policyBlockers: laneResult.blockers,
            llmReasoning: verdict.reasoning,
            finalState
          });

          if (louisResult && decisionId) {
            await recordLouisVerdict({ client, decisionId, verdict: louisResult });
          }
        } catch (error) {
          console.error('[reconciliationTriage] decision logging failed', {
            error: error?.message || String(error)
          });
        }
      }

      results.set(originalIndex, {
        verdict: verdict.verdict,
        confidence: verdict.confidence,
        reasoning: verdict.reasoning,
        lane: laneResult.lane,
        laneBlockers: laneResult.blockers,
        louisVerdict: louisResult?.verdict || null,
        finalState,
        upgradedScore,
        decisionId
      });
    }
  }

  return results;
};

// Launch-hardening kill switch (DEFAULT-ON) for the auto-resolve below. The
// behaviour ships ON; set RECONCILE_ASK_AUTORESOLVE_DISABLED=true to turn it off
// per-deploy (reversible on the Honeybee canary) WITHOUT reverting the supersede
// (fix #2) that shares this cascade. Mirrors the repo's default-on idiom
// (OPENAI_VISION_CACHE_DISABLED). Read on every cascade — cheap, no DB hit.
const askAutoResolveOnMatchDisabled = (env = process.env) =>
  String(env?.RECONCILE_ASK_AUTORESOLVE_DISABLED || '').trim().toLowerCase() === 'true';

// When a document AUTO-matches a bank line, the open owner asks on that line
// are re-evaluated against what the match actually PROVED (RT-11 / D3, audit
// F-17 — the law is EVIDENCE_RESOLVABLE_ASK_TYPES in reconciliationTwinAging.js):
//   - an ask for the DOCUMENT or a STATEMENT is answered by the document
//     itself — resolve it so we stop nagging the client for evidence they
//     already supplied (the "#3 nagging after upload" gap; the Chevron line
//     carried an open ask while its receipt sat unmatched);
//   - every OTHER ask (business_purpose, owner_fact, …) asked for a FACT the
//     document cannot prove — an amount match proves the charge exists, not
//     what it was for (round-4 §B: the Union Coop / Amazon "wholly for the café
//     rather than personal?" asks were closed by a receipt and posted). It stays
//     OPEN; the match is recorded on it (request_payload.matched_document_id …)
//     so the drafter can shorten the question to "we have the receipt — was it
//     business?", and each recording is receipted once per (ask, match).
// Runs only inside cascadeAutoMatch, which is invoked solely on an auto_matched
// result, so a merely-suggested match never silences a client question. Atomic
// with the match; idempotent — only flips ACTIVE ('open','replied') rows.
const resolveOpenEvidenceRequestsForMatchedLine = async (
  client,
  { firmId, clientId = null, bankTransactionId, matchId, matchedObjectType = null, documentId }
) => {
  if (!firmId || !bankTransactionId) return;
  const resolvableTypes = [...EVIDENCE_RESOLVABLE_ASK_TYPES];
  const resolved = await client.query(
    `update client_evidence_requests
        set status = 'resolved',
            resolved_at = now(),
            resolved_by = 'system',
            response_payload = coalesce(response_payload, '{}'::jsonb) || $3::jsonb,
            updated_at = now()
      where firm_id = $1
        and transaction_id = $2
        and status in ('draft', 'open', 'replied')
        and evidence_type = any($4::text[])
      returning id`,
    [
      firmId,
      bankTransactionId,
      JSON.stringify({
        auto_resolved_by_match: true,
        reconciliation_match_id: matchId,
        document_ids: documentId ? [documentId] : [],
        resolved_review_state: 'resolved'
      }),
      resolvableTypes
    ]
  );
  const resolvedIds = (resolved.rows || []).map((r) => r.id);
  // D3 — the asks the document cannot answer stay open, with the match on them.
  const retained = await client.query(
    `update client_evidence_requests
        set request_payload = coalesce(request_payload, '{}'::jsonb) || $3::jsonb,
            updated_at = now()
      where firm_id = $1
        and transaction_id = $2
        and status in ('draft', 'open', 'replied')
        and not (evidence_type = any($4::text[]))
        and coalesce(request_payload->>'matched_reconciliation_match_id', '') <> $5
      returning id, evidence_type`,
    [
      firmId,
      bankTransactionId,
      JSON.stringify({
        matched_document_id: documentId || null,
        matched_reconciliation_match_id: matchId || null,
        matched_object_type: matchedObjectType || null,
        match_recorded_at: new Date().toISOString()
      }),
      resolvableTypes,
      String(matchId || '')
    ]
  );
  const retainedRows = retained.rows || [];
  if (!resolvedIds.length && !retainedRows.length) return;
  if (resolvedIds.length) {
    // RT-26 (3): a coded line whose document ask this match just answered
    // RETURNS TO THE CODER on the next coding-convergence tick — RT-16's
    // release (codingConvergence RELEASE_SETTLED_WAITING_SQL: asked → proposed,
    // receipted `transaction_review.waiting_released_after_settle`) — and the
    // auto-post gate then posts it on the matched evidence. Nothing is
    // duplicated here; a retained D3 ask (business_purpose) keeps the line on
    // the owner and the release leaves it alone.
    // Keep the tx payload's embedded evidence_request copy consistent (the table
    // row is authoritative for the asks surface + the re-send producer, but a
    // stale payload copy confuses other readers) — only when the copy IS one of
    // the resolved asks (by id, or by kind when it carries no id); a copy of a
    // still-open purpose ask keeps saying open. Guarded on the parent existing.
    await client.query(
      `update transactions
          set payload = jsonb_set(coalesce(payload, '{}'::jsonb), '{evidence_request,status}', '"resolved"'),
              updated_at = now()
        where id = $1 and firm_id = $2
          and payload->'evidence_request'->>'status' in ('open', 'replied')
          and (
            payload->'evidence_request'->>'id' = any($3::text[])
            or (
              coalesce(payload->'evidence_request'->>'id', '') = ''
              and coalesce(payload->'evidence_request'->>'evidence_type', 'supporting_document') = any($4::text[])
            )
          )`,
      [bankTransactionId, firmId, resolvedIds, resolvableTypes]
    );
    try {
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', 'client_evidence_request.auto_resolved_by_match', 'reconciliation_match', $3, $4::jsonb)`,
        [
          firmId,
          clientId,
          matchId,
          JSON.stringify({
            match_id: matchId,
            bank_transaction_id: bankTransactionId,
            matched_object_id: documentId,
            resolved_request_ids: resolvedIds,
            retained_request_ids: retainedRows.map((r) => r.id),
            resolvable_evidence_types: resolvableTypes
          })
        ]
      );
    } catch (error) {
      console.warn('[reconciliationTriage] evidence auto-resolve audit write failed', {
        match_id: matchId,
        error: error?.message || String(error)
      });
    }
  }
  for (const row of retainedRows) {
    try {
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', 'client_evidence_request.match_recorded', 'client_evidence_request', $3, $4::jsonb)`,
        [
          firmId,
          clientId,
          row.id,
          JSON.stringify({
            match_id: matchId,
            bank_transaction_id: bankTransactionId,
            matched_document_id: documentId || null,
            matched_object_type: matchedObjectType || null,
            evidence_type: row.evidence_type,
            kept_open_because: 'a document match does not prove the fact this ask needs'
          })
        ]
      );
    } catch (error) {
      console.warn('[reconciliationTriage] match-recorded audit write failed', {
        match_id: matchId,
        request_id: row.id,
        error: error?.message || String(error)
      });
    }
  }
};

export const cascadeAutoMatch = async ({
  client,
  firmId,
  clientId = null,
  matchId,
  bankTransactionId,
  matchedObjectType,
  documentId
}) => {
  // RT-13 — the cascade changes three of the convergence projection's inputs
  // at once (the line's reconciliation_status, its asks, its bank_line rows),
  // so it re-derives the line's and the document's persisted verdict in the
  // SAME transaction before it returns — the writer-side invariant audit
  // F-08 asked for, explicit here rather than left to the commit-time settle.
  const settleCascadeConvergence = () => applyConvergenceStateBestEffort(client, {
    firmId,
    transactionId: bankTransactionId,
    documentId: matchedObjectType === 'bank_line' ? null : documentId
  }, { logTag: 'reconciliationTriage' });
  // A confident document match answers any open client ask on this line —
  // resolve it before the status cascade so we stop nagging after upload.
  // Default-ON; reversible via RECONCILE_ASK_AUTORESOLVE_DISABLED (launch kill
  // switch). Only this resolve is gated — the supersede cascade below is not.
  if (!askAutoResolveOnMatchDisabled()) {
    await resolveOpenEvidenceRequestsForMatchedLine(client, {
      firmId,
      clientId,
      bankTransactionId,
      matchId,
      matchedObjectType,
      documentId
    });
  }

  // Document evidence outranks a bank-line-only explanation (the Exxon
  // 25-07-29 class — see CANDIDATE_TX_STATUS_SQL in
  // reconciliationLlmCore.js). When the line was explained from the
  // bank line alone (low-materiality rule / bank-line classifier), a
  // document match SUPERSEDES that explanation instead of no-op'ing
  // against the already-explained guard. Anything else that is already
  // resolved — doc-matched, human-explained, reconciled, posted — is
  // still never overwritten.
  const txResult = await client.query(
    `select reconciliation_status,
            payload->>'support_status' as support_status,
            payload->>'bank_line_auto_explained' as bank_line_auto_explained,
            payload->>'bank_line_disposition_explained' as bank_line_disposition_explained,
            payload->>'ai_suggestion_status' as ai_suggestion_status,
            coalesce(payload->>'reconciliation_match_type', 'bank_line') as prior_match_type
       from transactions
      where id = $1 and firm_id = $2`,
    [bankTransactionId, firmId]
  );
  const tx = (txResult.rows || [])[0] || null;
  // Shared predicate — recognises every machine auto-explanation provenance
  // (bank-line classifier/disposition, client rule, coding auto-apply), so the
  // supersede path fires for ALL of them, not just the two markers this check
  // used to hard-code (the drift that no-op'd the Chevron cascade). The
  // bank-line match_type guard stays: a doc-matched line is never superseded.
  const bankLineOnlyExplained = Boolean(tx) &&
    tx.reconciliation_status === 'explained' &&
    tx.prior_match_type === 'bank_line' &&
    isBankLineOnlyExplained(tx);

  if (!bankLineOnlyExplained) {
    await client.query(
      `update transactions
          set reconciliation_status = 'explained',
              payload = coalesce(payload, '{}'::jsonb) || $3::jsonb,
              updated_at = now()
        where id = $1 and firm_id = $2
          and reconciliation_status is distinct from 'reconciled'
          and reconciliation_status is distinct from 'posted'
          and reconciliation_status is distinct from 'auto_reconciled'
          and reconciliation_status is distinct from 'explained'`,
      [
        bankTransactionId,
        firmId,
        JSON.stringify({
          reconciliation_status: 'explained',
          reconciliation_match_id: matchId,
          reconciliation_match_type: matchedObjectType,
          reconciliation_match_object_id: documentId,
          auto_explained: true,
          auto_explain_source: 'llm_triage'
        })
      ]
    );
    await settleCascadeConvergence();
    return;
  }

  // Supersede path. The NOT EXISTS guard honours a firm-CONFIRMED
  // bank-line explanation (a firm decision outranks the matcher, same
  // as SUPPRESSION_STATUSES); system-made rows do not block.
  const superseded = await client.query(
    `update transactions
        set reconciliation_status = 'explained',
            payload = coalesce(payload, '{}'::jsonb) || $3::jsonb,
            updated_at = now()
      where id = $1 and firm_id = $2
        and reconciliation_status = 'explained'
        and coalesce(payload->>'reconciliation_match_type', 'bank_line') = 'bank_line'
        and not exists (
          select 1 from reconciliation_matches rm
           where rm.bank_transaction_id = transactions.id
             and rm.matched_object_type = 'bank_line'
             and rm.status = 'confirmed'
        )
      returning id`,
    [
      bankTransactionId,
      firmId,
      JSON.stringify({
        reconciliation_status: 'explained',
        reconciliation_match_id: matchId,
        reconciliation_match_type: matchedObjectType,
        reconciliation_match_object_id: documentId,
        auto_explained: true,
        auto_explain_source: 'document_match_supersede',
        support_status: 'explained',
        bank_line_auto_explained: false,
        superseded_weak_explanation: true
      })
    ]
  );
  if (!(superseded.rows || []).length) {
    await settleCascadeConvergence();
    return;
  }

  // Retire a lingering self-ref bank_line auto-explain row so the line
  // doesn't carry two live explanations. Rejected (not deleted) keeps
  // the trail, and bankLineAutoExplain treats a rejected bank_line row
  // as a prior rejection — it won't re-claim the line.
  await client.query(
    `update reconciliation_matches
        set status = 'rejected',
            payload = coalesce(payload, '{}'::jsonb) || $3::jsonb,
            updated_at = now()
      where firm_id = $1
        and bank_transaction_id = $2
        and matched_object_type = 'bank_line'
        and matched_object_id = $2
        and status in ('suggested', 'auto_matched')`,
    [
      firmId,
      bankTransactionId,
      JSON.stringify({
        superseded_by_match_id: matchId,
        superseded_by_object_type: matchedObjectType,
        superseded_reason: 'document_match_supersede'
      })
    ]
  );

  try {
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', 'reconciliation.bank_line_explain.superseded', 'reconciliation_match', $3, $4::jsonb)`,
      [
        firmId,
        clientId,
        matchId,
        JSON.stringify({
          match_id: matchId,
          bank_transaction_id: bankTransactionId,
          matched_object_type: matchedObjectType,
          matched_object_id: documentId,
          prior_support_status: tx.support_status || null,
          prior_explained_by_bank_line: tx.bank_line_auto_explained === 'true'
        })
      ]
    );
  } catch (error) {
    console.warn('[reconciliationTriage] supersede audit write failed', {
      match_id: matchId,
      error: error?.message || String(error)
    });
  }
  await settleCascadeConvergence();
};
