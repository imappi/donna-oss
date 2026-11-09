import { readAccountingProfile, AccountingProfileError } from '../../src/lib/accountingProfile.js';
// Canonical-role resolution runner — the first CALLER of the canonical-role
// lane (proposer #1183 → planner → #1184's standing-subject ask writer).
//
// Until this module, all three parts sat on main with zero importers: the lane
// was dark, and the only thing clearing OUTBOUND_AR_NO_SALES_TAX_ACCOUNT was an
// operator running scripts/backfill_gb_sales_tax_roles.js by hand — a firm-side
// manual step in a product whose thesis is that there is no back office
// (CLAUDE.md, two-terminal-states). This runner drives one client's chart to
// the two terminals: every unroled account either gets its role ASSIGNED (the
// model proposed, every deterministic invariant agreed) or becomes an OWNER
// question through the migration-108 ask identity. Nothing rests firm-side.
//
// Trust-the-strong-LLM shape: ONE whole-chart model call proposes
// (canonicalRoleProposer.js); the deterministic Keep layer refuses
// (canonicalRoleResolution.js); refused work is escalated to the owner
// (canonicalRoleAsk.js + the #1184 writer). No name regexes, no arity
// heuristics, no fallback classifier — with no model wired the lane reports
// itself dark rather than guessing.
//
// The chart this runner sees is the union the posting paths care about:
//
//   * ledger_accounts — the store accountForRole (firmDb.js) actually resolves
//     from, so an assignment here is what clears the named 409s;
//   * the xero_accounts mirror — a SYNCED chart's rows that have never been
//     posted through and so have no ledger row yet. An assignment on one of
//     these mints its ledger row through upsertLedgerAccountForJournal (the
//     existing writer, same deterministic id, coalesce-FILL) so the role is
//     real for the posting path, not a note on a mirror.
//
// Config plane: gated by the CANONICAL_ROLE_RESOLUTION flag key with
// envFallback () => false — flag-dark by default, staged per client through
// client_capability_config (the rollout-flags rail; no env pair exists and none
// may be added). Writes happen in ONE transaction owned by this module; the
// model call runs before it opens so a slow call never holds a transaction.
//
// requiredRoles: caller-supplied wins; otherwise DERIVED from the client's
// posting reality (deriveRequiredRolesForClient below — the named follow-up
// from the first-caller session, now built). The old always-[] default was
// the guard against materiality-blind over-asking (forcing
// `liability.sales_tax_payable` onto every GB client would ask non-registered
// owners about a VAT account they do not have). The derivation keeps that
// guard: the VAT requirement keys on the effective-dated registration record
// resolving registered === true — never on unknown — and the AR/revenue
// requirements on OUTBOUND_INVOICING actually acting for an accrual book.

import { clientFlagActs, readClientConfigSnapshot, persistConfigSnapshot } from './clientConfig.js';
import { resolveProvisioningPolicy } from './provisioningPolicyRegistry.js';
import { llmCall } from './llmCall.js';
import { proposeCanonicalRoles } from './canonicalRoleProposer.js';
import { planCanonicalRoleResolution } from './canonicalRoleResolution.js';
import { buildCanonicalRoleAsk } from './canonicalRoleAsk.js';
import { preferredOwnerTemplateLanguage } from './ownerLanguage.js';
import { roleMeta } from './accountRoles.js';

export const CANONICAL_ROLE_RESOLUTION_FLAG_KEY = 'CANONICAL_ROLE_RESOLUTION';

// Output cap, not a target. A large chart returns one proposal object per
// target row; 16384 leaves headroom for a few hundred rows. A truncated reply
// fails the JSON boundary and surfaces as a `refused/invalid_json` receipt —
// visible, never a partial parse.
const COMPOSE_MAX_TOKENS = 16384;

// The default compose for production callers — the K1-5 pattern: compose is an
// injected dependency, and with nothing injectable the lane is HONESTLY dark
// (`model_dark` receipt), never a fallback heuristic. Returns null without an
// API key so the caller can tell "dark" from "wired". Routed through the
// llmCall envelope (M3): the URL string here is the caller's argument, the
// call itself carries telemetry and a typed execution ref.
export const buildDefaultCanonicalRoleCompose = ({ env = process.env, fetchImpl = fetch, execution = null } = {}) => {
  const apiKey = String(env?.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) return null;
  return async ({ model, prompt }) => {
    const { result } = await llmCall({
      provider: 'anthropic',
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: {
        model,
        max_tokens: COMPOSE_MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }]
      },
      sections: { context: prompt },
      execution: execution || { root: { type: 'canonical_role_resolution', id: 'unattributed' } },
      // The RESPONSE's model id, not the requested one — the model id is part
      // of the receipt, and the two can differ (alias resolution, overrides).
      parseResponse: (payload) => ({
        model: payload?.model || model,
        output: (Array.isArray(payload?.content) ? payload.content : [])
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n')
      }),
      fetchImpl
    });
    return result;
  };
};

// ── requiredRoles from posting reality ───────────────────────────────────────
//
// Which singleton roles does THIS client's posting actually resolve BY ROLE?
// Derived by reading the resolve-by-role call sites, never invented:
//
//   * the outbound AR legs (firmDb postOutboundArJournalWithClient) resolve
//     asset.accounts_receivable + revenue.operating whenever they post at all —
//     which requires OUTBOUND_INVOICING acting AND an accrual basis (a
//     cash-basis book refuses the AR post before any role lookup: income books
//     at settlement). Jurisdiction-free: the writer resolves those two roles
//     for ANY client it posts for.
//   * liability.sales_tax_payable is resolved by the GB tax split and the GB
//     VAT-return surface, both live exactly when the client has an EFFECTIVE
//     VAT registration. The read is tri-state and only `registered === true`
//     requires: unknown must NOT proactively ask a maybe-unregistered owner
//     which account is "the VAT one" — that is the materiality-blind
//     over-asking the old [] default existed to prevent.
//
// FI deliberately derives NOTHING VAT-shaped: Finland ships a statutory chart
// and its control accounts are statutory codes (tilikartta 2939), not role
// lookups — the market-neutral asymmetry accountRoles.js documents.
//
// Pure (no DB, no clock — `onDate` comes in), so the whole derivation is
// seam-testable. Throws only on a missing/unusable onDate for a GB client,
// which is a caller bug, not a data state.
export const deriveRequiredRolesForClient = ({
  jurisdiction = null,
  profile = null,
  snapshot = null,
  env = process.env,
  onDate
} = {}) => {
  const roles = new Set();

  const method = readAccountingProfile(profile || {}).method;
  if (method.status === 'unknown' || method.status === 'conflicting') throw new AccountingProfileError('ACCOUNTING_METHOD_UNRESOLVED', 'Record a consistent cash or accrual method in the client profile before continuing.');
  const basis = method.value || 'accrual';
  const invoicingActs = clientFlagActs({ flagKey: 'OUTBOUND_INVOICING', snapshot, envFallback: () => false, env });
  if (invoicingActs && basis === 'accrual') {
    roles.add('asset.accounts_receivable');
    roles.add('revenue.operating');
  }

  const countryRequirements = resolveProvisioningPolicy(jurisdiction)?.requiredRoles?.({ profile, onDate })
    ?? { roles: [], evidence: {} };
  for (const role of countryRequirements.roles) roles.add(role);

  return {
    roles: [...roles].sort(),
    // Why each requirement did or did not derive — rides the run receipt so a
    // "why was the owner (not) asked about the VAT account" question is
    // answerable from the audit row alone.
    evidence: {
      outbound_invoicing_acts: Boolean(invoicingActs),
      accounting_basis: basis,
      gb_vat_registered: null,
      ...countryRequirements.evidence
    }
  };
};

// Lazy firmDb impls (the outbound/issuance.js resolveImpls idiom) so tests can
// run this module against a fake db client without importing firmDb at all.
const lazyFirmDbImpls = async () => {
  const firmDb = await import('./firmDb.js');
  return {
    mintEvidenceRequest: firmDb.__createClientEvidenceRequestWithClient,
    upsertLedgerAccount: firmDb.upsertLedgerAccountForJournal,
    ledgerRecordId: firmDb.ledgerRecordId,
    normalBalanceForAccountClass: firmDb.__normalBalanceForAccountClass
  };
};

const resolveImpls = async (impls) => {
  if (impls && typeof impls.mintEvidenceRequest === 'function' && typeof impls.ledgerRecordId === 'function') {
    return impls;
  }
  return { ...(await lazyFirmDbImpls()), ...(impls || {}) };
};

const softEmpty = (error) => {
  if (error?.code === '42P01' || error?.code === '42703') return { rows: [] };
  throw error;
};

// The chart as the planner/proposer contract wants it. xero-mirror rows carry
// the DETERMINISTIC would-be ledger id (the same `code || xero_account_id ||
// name` derivation upsertLedgerAccountForJournal uses), so an assignment on one
// lands on exactly the row a later posting upsert would land on — one identity,
// no duplicate mint.
const loadChartForRoleResolution = async ({ client, firmId, clientId, io }) => {
  const ledgerRes = await client.query(
    `select id, code, name, account_type, normal_balance, currency, tax_type, canonical_role
       from ledger_accounts
      where firm_id = $1 and client_id = $2 and status = 'active'
      order by code nulls last, name`,
    [firmId, clientId]
  ).catch(softEmpty);
  const accounts = (ledgerRes.rows || []).map((row) => ({
    id: row.id,
    code: row.code ?? null,
    name: row.name ?? null,
    account_type: row.account_type ?? null,
    normal_balance: row.normal_balance ?? null,
    tax_type: row.tax_type ?? null,
    canonical_role: row.canonical_role ?? null,
    source: 'ledger'
  }));
  const seenIds = new Set(accounts.map((account) => String(account.id)));

  const xeroRes = await client.query(
    `select xero_account_id, code, name, type, class, status, tax_type
       from xero_accounts
      where firm_id = $1 and client_id = $2
      order by code nulls last, name`,
    [firmId, clientId]
  ).catch(softEmpty);
  for (const row of xeroRes.rows || []) {
    const status = String(row.status || '').trim().toUpperCase();
    if (status && status !== 'ACTIVE') continue;
    // Xero's `class` IS the statement class (ASSET/LIABILITY/EQUITY/REVENUE/
    // EXPENSE); `type` is finer and includes vocabulary the house classifiers
    // do not fold (CURRLIAB). BANK is the one fine type that matters (asset.cash
    // convention), so it wins over the class.
    const houseType = String(row.type || '').trim().toUpperCase() === 'BANK'
      ? 'bank'
      : (String(row.class || '').trim().toLowerCase() || 'unknown');
    const wouldBeId = io.ledgerRecordId('account', firmId, clientId, row.code || row.xero_account_id || row.name);
    if (seenIds.has(String(wouldBeId))) continue;
    seenIds.add(String(wouldBeId));
    accounts.push({
      id: wouldBeId,
      code: row.code ?? null,
      name: row.name ?? null,
      account_type: houseType,
      normal_balance: null,
      tax_type: row.tax_type ?? null,
      canonical_role: null,
      source: 'xero_mirror',
      xero_account_id: row.xero_account_id ?? null
    });
  }
  return accounts;
};

const isUnroled = (account) => !String(account?.canonical_role || '').trim();

/**
 * Run canonical-role resolution for one client, dbClient-injectable (house
 * `__…WithClient` idiom). Owns its own write transaction (`begin` after the
 * model call, `commit`/`rollback` around all writes) — do NOT call it from
 * inside an open transaction.
 *
 * Returns a receipt; statuses: `refused` (bad target), `flag_dark` (config
 * plane says no), `nothing_to_resolve`, `model_dark` (no compose wired),
 * `model_error`, `completed`. A completed receipt carries the proposer receipt
 * (model_requested/model_used/proposals_dropped — the model-id rail), the
 * planner receipt, and per-write counts.
 */
export const __runCanonicalRoleResolutionWithClient = async ({
  client,
  firmId,
  clientId,
  compose = undefined,
  env = process.env,
  actorId = 'system',
  // undefined ⇒ derive from posting reality; an explicit array (even []) is a
  // caller that knows better and wins.
  requiredRoles = undefined,
  confidenceFloor = undefined,
  impls = null,
  triggeredBy = null,
  now = undefined
} = {}) => {
  if (!client || !firmId || !clientId) {
    return { status: 'refused', reason: 'missing_target', client_id: clientId ?? null };
  }
  const io = await resolveImpls(impls);

  const clientRes = await client.query(
    `select id, company_name, jurisdiction, entity_type, status, profile
       from clients
      where firm_id = $1 and id = $2
      limit 1`,
    [firmId, clientId]
  );
  const clientRow = clientRes.rows?.[0] || null;
  if (!clientRow || clientRow.status === 'deleted') {
    return { status: 'refused', reason: 'client_not_found', client_id: clientId };
  }

  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  const flagRow = snapshot && typeof snapshot === 'object' ? snapshot[CANONICAL_ROLE_RESOLUTION_FLAG_KEY] : null;
  const flag = {
    key: CANONICAL_ROLE_RESOLUTION_FLAG_KEY,
    stage: flagRow?.stage ?? null,
    source: flagRow?.source ?? 'unset'
  };
  const acts = clientFlagActs({
    flagKey: CANONICAL_ROLE_RESOLUTION_FLAG_KEY,
    snapshot,
    envFallback: () => false,
    env
  });
  if (!acts) {
    return { status: 'flag_dark', client_id: clientId, flag };
  }

  const accounts = await loadChartForRoleResolution({ client, firmId, clientId, io });
  const unroled = accounts.filter(isUnroled);
  if (!unroled.length) {
    return {
      status: 'nothing_to_resolve',
      client_id: clientId,
      flag,
      accounts_considered: accounts.length
    };
  }

  const composeFn = compose === undefined
    ? buildDefaultCanonicalRoleCompose({
        env,
        execution: { root: { type: 'canonical_role_resolution', id: clientId } }
      })
    : compose;
  if (typeof composeFn !== 'function') {
    return {
      status: 'model_dark',
      reason: 'compose_unavailable',
      client_id: clientId,
      flag,
      accounts_considered: accounts.length,
      unroled_targets: unroled.length
    };
  }

  const jurisdiction = String(clientRow.jurisdiction || '').trim().toUpperCase() || null;
  let proposed;
  try {
    proposed = await proposeCanonicalRoles({
      accounts,
      jurisdiction,
      pack: null,
      clientIdentity: {
        company_name: clientRow.company_name || null,
        jurisdiction,
        entity_type: clientRow.entity_type || null
      },
      env,
      compose: composeFn
    });
  } catch (error) {
    return {
      status: 'model_error',
      reason: error?.code || error?.message || 'unknown',
      client_id: clientId,
      flag,
      accounts_considered: accounts.length,
      unroled_targets: unroled.length
    };
  }

  const callerSuppliedRequiredRoles = Array.isArray(requiredRoles);
  const derivedRequirements = callerSuppliedRequiredRoles
    ? null
    : deriveRequiredRolesForClient({
        jurisdiction,
        profile: clientRow.profile && typeof clientRow.profile === 'object' ? clientRow.profile : null,
        snapshot,
        env,
        onDate: now || new Date().toISOString()
      });
  const effectiveRequiredRoles = callerSuppliedRequiredRoles ? requiredRoles : derivedRequirements.roles;

  const plan = planCanonicalRoleResolution({
    accounts,
    proposals: proposed.proposals,
    requiredRoles: effectiveRequiredRoles,
    ...(confidenceFloor != null ? { confidenceFloor } : {})
  });

  const byId = new Map(accounts.map((account) => [String(account.id), account]));
  const applied = [];
  const stale = [];
  const askReceipts = [];
  let asksUnexpressed = 0;

  await client.query('begin');
  try {
    for (const assignment of plan.assignments) {
      const account = byId.get(String(assignment.account_id));
      if (!account) {
        stale.push({ ...assignment, skip: 'account_missing' });
        continue;
      }
      if (account.source === 'xero_mirror') {
        // Mint the ledger row through the existing writer: same deterministic
        // id, coalesce-FILL (a concurrent settle wins, we read back and report).
        await io.upsertLedgerAccount({
          client,
          firmId,
          clientId,
          account: {
            code: account.code,
            name: account.name,
            type: account.account_type,
            normal_balance: roleMeta(assignment.role)?.normal_balance
              || io.normalBalanceForAccountClass(account.account_type),
            xero_account_id: account.xero_account_id || null,
            tax_type: account.tax_type || null,
            canonical_role: assignment.role
          },
          currency: ''
        });
        const check = await client.query(
          `select canonical_role from ledger_accounts
            where firm_id = $1 and client_id = $2 and id = $3
            limit 1`,
          [firmId, clientId, account.id]
        );
        if (check.rows?.[0]?.canonical_role === assignment.role) {
          applied.push({ ...assignment, account_source: account.source });
        } else {
          stale.push({ ...assignment, skip: 'role_settled_since_read' });
        }
      } else {
        // Compare-and-swap against null — the backfill scripts' rule: a role is
        // FILLED, never overwritten. rowCount 0 means someone settled it since
        // the chart read; report, do not force.
        const updated = await client.query(
          `update ledger_accounts
              set canonical_role = $4, updated_at = now()
            where firm_id = $1 and client_id = $2 and id = $3 and canonical_role is null`,
          [firmId, clientId, account.id, assignment.role]
        );
        if (updated.rowCount === 1) {
          applied.push({ ...assignment, account_source: account.source });
        } else {
          stale.push({ ...assignment, skip: 'role_settled_since_read' });
        }
      }
    }

    for (const assignment of applied) {
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', $3, 'ledger.account.role_assigned', 'ledger_account', $4, $5::jsonb)`,
        [
          firmId,
          clientId,
          actorId,
          assignment.account_id,
          JSON.stringify({
            canonical_role: assignment.role,
            confidence: assignment.confidence ?? null,
            rationale: assignment.rationale ?? null,
            code: assignment.code ?? null,
            name: assignment.name ?? null,
            account_source: assignment.account_source,
            model: proposed.receipt?.model_used || null,
            source: 'canonical_role_resolution'
          })
        ]
      );
    }

    // The owner's language, from the client row already read (the profile, with
    // the client's jurisdiction where the profile does not carry one).
    const ownerLanguage = preferredOwnerTemplateLanguage({
      ...(clientRow.profile && typeof clientRow.profile === 'object' ? clientRow.profile : {}),
      jurisdiction: clientRow.profile?.jurisdiction || clientRow.jurisdiction
    });
    for (const ask of plan.asks) {
      const built = buildCanonicalRoleAsk({ ask, language: ownerLanguage });
      // buildCanonicalRoleAsk fails closed on a refusal it has no wording for;
      // count it so the receipt shows the planner asked for something this
      // module could not express (a growth seam, not a silent drop).
      if (!built) {
        asksUnexpressed += 1;
        continue;
      }
      const request = await io.mintEvidenceRequest({
        client,
        firmId,
        clientId,
        accountRole: ask.role,
        question: built.question,
        evidenceType: built.evidence_type,
        actorId,
        requestContext: built.request_payload,
        markTransactionNeedsClient: false
      });
      askReceipts.push({
        request_id: request?.id ?? null,
        role: ask.role,
        refusal: ask.refusal
      });
    }

    const configSnapshotId = await persistConfigSnapshot(client, { firmId, clientId, snapshot });
    const receipt = {
      status: 'completed',
      client_id: clientId,
      flag,
      jurisdiction,
      accounts_considered: accounts.length,
      unroled_targets: unroled.length,
      required_roles: effectiveRequiredRoles,
      required_roles_source: callerSuppliedRequiredRoles ? 'caller' : 'derived',
      ...(derivedRequirements ? { required_roles_evidence: derivedRequirements.evidence } : {}),
      proposer: proposed.receipt,
      plan: plan.receipt,
      assignments_applied: applied.length,
      assignments_stale: stale.length,
      asks_minted: askReceipts.length,
      asks: askReceipts,
      asks_unexpressed: asksUnexpressed,
      // The named deferral lane (planner option B, Kari 2026-08-01): refused
      // non-required proposals resting on the NEXT SWEEP, listed per account so
      // the persisted run receipt shows who deferred and why — never only a
      // count, never invisible.
      deferred_to_next_sweep: plan.deferred ?? [],
      config_snapshot_id: configSnapshotId
    };
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', $3, 'canonical_role.resolution_run', 'client', $4, $5::jsonb)`,
      [
        firmId,
        clientId,
        actorId,
        clientId,
        JSON.stringify({ ...receipt, triggered_by: triggeredBy })
      ]
    );
    await client.query('commit');
    return receipt;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
};

// ── The sweep caller (the Donna-ledger gap) ──────────────────────────────────
//
// The sync route covers charts that arrive by sync event. A client on Donna's
// own ledger ('none' accounting system) has no sync event: its chart grows at
// posting time, when a verdict mints an account through
// upsertLedgerAccountForJournal, and a minted row is born with canonical_role
// null. Without a caller those accounts rest unroled indefinitely — the
// firm-side limbo this lane exists to drain.
//
// Hooking the mint site itself was considered and rejected: the mint runs
// inside posting transactions (a strong-model call cannot run there), and
// threading a post-commit trigger through every posting writer is the
// tool-soup coupling the runtime doctrine warns against. A bounded daily sweep
// is the boring shape: find clients with unroled active accounts, run the
// standard resolution per client, cap the clients per run. It also catches any
// other path that leaves a row unroled, not just verdict mints.
//
// Safe by construction: each client's run self-gates on the
// CANONICAL_ROLE_RESOLUTION config-plane flag (flag_dark, no model call) and
// reports model_dark without a wired compose — the sweep is a no-op until a
// client is staged. Idempotent: assignments CAS against null, and a re-minted
// ask collapses into the open standing-subject row (the migration-108 anchor),
// with no channel delivery from this path. The known cost of that simplicity:
// a client whose unroled accounts are all waiting on an open owner ask spends
// one model call per sweep re-confirming the same plan. Acceptable at canary
// scale; tighten with a chart-changed-since-ask check if it ever bites.
export const runCanonicalRoleResolutionSweep = async ({
  firmId = undefined,
  limit = 5,
  env = process.env,
  actorId = 'system',
  now = undefined,
  deps = {}
} = {}) => {
  const io = { ...deps };
  if (!io.withFirmDbClient || !io.resolveFirmId) {
    const firmDb = await import('./firmDb.js');
    io.withFirmDbClient = io.withFirmDbClient || firmDb.withFirmDbClient;
    io.resolveFirmId = io.resolveFirmId || firmDb.resolveConfiguredDefaultFirmId;
  }
  io.runForClient = io.runForClient || runCanonicalRoleResolutionForClient;

  const resolvedFirmId = firmId || io.resolveFirmId(env);
  const cap = Math.max(1, Number(limit) || 1);
  const candidateRes = await io.withFirmDbClient((client) => client.query(
    `select la.client_id, count(*)::int as unroled_accounts
       from ledger_accounts la
       join clients c on c.firm_id = la.firm_id and c.id = la.client_id
      where la.firm_id = $1
        and la.status = 'active'
        and la.canonical_role is null
        and coalesce(c.status, '') <> 'deleted'
      group by la.client_id
      order by la.client_id
      limit $2`,
    [resolvedFirmId, cap]
  ).catch(softEmpty));
  const candidates = (candidateRes.rows || []).slice(0, cap);

  const clients = [];
  const tally = {};
  for (const candidate of candidates) {
    let receipt;
    try {
      receipt = await io.runForClient({
        firmId: resolvedFirmId,
        clientId: candidate.client_id,
        env,
        actorId,
        now,
        triggeredBy: 'canonical_role_resolution_sweep'
      });
    } catch (error) {
      // Fail-soft per client — one broken chart must not stop the rest of the
      // sweep, and the error is a named receipt entry, never a silent drop.
      receipt = { status: 'error', reason: error?.code || error?.message || 'unknown' };
    }
    const status = receipt?.status || 'unknown';
    tally[status] = (tally[status] || 0) + 1;
    clients.push({
      client_id: candidate.client_id,
      unroled_accounts: candidate.unroled_accounts,
      status,
      ...(receipt?.reason ? { reason: receipt.reason } : {}),
      ...(receipt?.assignments_applied != null ? { assignments_applied: receipt.assignments_applied } : {}),
      ...(receipt?.asks_minted != null ? { asks_minted: receipt.asks_minted } : {})
    });
  }

  return {
    firm_id: resolvedFirmId,
    considered: candidates.length,
    limit: cap,
    clients,
    tally
  };
};

// Production entry point: one pooled connection, defaults threaded from firmDb.
export const runCanonicalRoleResolutionForClient = async ({
  firmId = undefined,
  clientId,
  compose = undefined,
  env = process.env,
  actorId = 'system',
  requiredRoles = undefined,
  confidenceFloor = undefined,
  impls = null,
  triggeredBy = null,
  now = undefined
} = {}) => {
  const firmDb = await import('./firmDb.js');
  return firmDb.withFirmDbClient(async (client) =>
    __runCanonicalRoleResolutionWithClient({
      client,
      firmId: firmId || firmDb.resolveConfiguredDefaultFirmId(env),
      clientId,
      compose,
      env,
      actorId,
      requiredRoles,
      confidenceFloor,
      impls,
      triggeredBy,
      now
    }));
};
