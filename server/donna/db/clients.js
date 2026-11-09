// server/donna/db/clients.js — plane S — firm and legal-entity identity (the live default-firm binding), client lifecycle (create / profile / jurisdiction / delete), the EAW isolated-firm lifecycle and its read-only observers.
//
// RT-17 (2026-09-02): extracted from server/donna/firmDb.js as a pure move.
// Public symbols retain their import paths through firmDb.js. Wave 6 moves
// country operations behind named registries; shared writers retain persistence.

import { readAccountingProfile, normalizeAccountingProfilePatch, hasAccountingProfilePatch, AccountingProfileError, ACCOUNTING_PROFILE_KEYS } from '../../../src/lib/accountingProfile.js';

import { resolveClientLifecycle, resolveClientLifecycleAxis, assertFinnishProfileIntakeMutableWithClient } from '../clientLifecycleRegistry.js';

// `dismissFirmFact` (G2 PR-14): the reverse executor's memory leg routes a minted
// fact to the SAME governed tombstone writer the forget_fact verb uses (INV-1).
import { purgeFirmFactsForDeletedClient } from '../firmFacts.js';
import { recordAuthorityPlaneWipeReceipt, snapshotAuthorityPlaneForClient } from '../authorityPlaneReceipt.js';
import { resolveAssistantName } from '../assistantIdentity.js';
import { readClientConfigSnapshot, setClientFlagStage } from '../clientConfig.js';
import { isDesktopHostEnv, seedDesktopClientPlaneRowsWithClient } from '../desktop/hostPlaneSeed.js';
import { seedNewClientReadinessEnrollmentWithClient } from '../runtimeReadinessEnrollment.js';
import { seedHostedFirmClientWithClient, readNativeProcessingSelectionWithClient, validateNativeProcessingFacts, nativeIntakeFailure } from '../hostedFirmIntake.js';
import { SG_NATIVE_PROCESSING_REVIEW_FLAG } from '../cloudPilotConfig.js';
import { resolveClientCreateFirmId } from '../desktop/firstRunFirmMint.js';
import { canonicalizeClientProfileLegalForm } from '../clientLegalForm.js';
import { normalizeJurisdictionKey } from '../taxCodeJurisdiction.js';
// gap 7 — the country-pack chart-of-accounts leg: jurisdiction resolves to an
// AUTHORED pack id, and the pack's palette becomes the client's fallback
// coding menu when JURISDICTION_ACCOUNT_PALETTE acts.
import { accountingSystemAvailability } from '../outbound/packs.js';
import { isAuthority } from '../loopExecutionPolicy.js';
import { purgeLoopsShadowForDeletedClient } from '../caseManager.js';
import { purgeLocalJobsForDeletedClient } from '../desktop/localJobQueue.js';
import { purgeMemoriesForDeletedLegalEntity } from '../memoriesDb.js';
import { purgeConvergenceMetricSnapshotsForDeletedClient } from '../convergenceMetricSnapshots.js';
import { ANSWERED_PROCESSING_ASK_STATUSES, hasAnsweredOwnerAskInRequests, hasAnsweredSeatAskInRequests, hasOpenAgentAskInRequests, hasOpenOwnerAskInRequests, hasOpenSeatAskInRequests, OPEN_OWNER_ASK_STATUSES } from '../reconcileConvergenceState.js';
import { CLOSED_PERIOD_STATUSES } from '../ledgerReadModel.js';
import { archiveLlmDecisionsForDeletedClient } from '../llmDecisionRetention.js';

import { getFirmDatabaseUrl, isLocalDatabaseUrl, isProductionRuntime, queryFirmDb, withFirmDbClient } from './pool.js';
import { resolveClientCodingPolicy, withClientCodingPolicy } from './coding.js';
import { seedPackPaletteChartWithClient } from './ledger.js';
import { nativeChartDigest, nativeChartFailure, readNativeChartLineage, validateNativeBirthInput, nativeRegistrationPolicyForLineage, readNativeRegistrationEvidence } from '../nativeChartLineage.js';
import { __heldFiscalYearsForRetention } from './close.js';
import { clearXeroMirrorForClientBestEffort, revokeXeroGrantsForClientBestEffort } from './xero.js';
import { getFirmSnapshotFromDb } from './snapshot.js';

// The shared demo tenant. A local-dev / seed convenience — and the value every
// `firmId = DEFAULT_FIRM_ID` signature falls back to when a caller names no firm.
// It is NOT a safe home for real client books in production; see
// assertFirmScopeAllowed below for the guard that enforces that.
const DEMO_FIRM_ID = 'donna-demo-firm';

// The firm a request is scoped to when the caller names none. Configurable via
// DONNA_DEFAULT_FIRM_ID so a real deployment scopes unattributed data to its own
// firm instead of the shared demo tenant. Pure + env-injectable for unit tests.
export const resolveConfiguredDefaultFirmId = (env = process.env) =>
  String(env.DONNA_DEFAULT_FIRM_ID || '').trim() || DEMO_FIRM_ID;

// Resolved once at module load. Never throws here — the production hard-fail for
// an unconfigured demo default lives in assertFirmScopeAllowed (per-request, so
// the server still boots and serves health checks even when nothing is set yet).
let DEFAULT_FIRM_ID = resolveConfiguredDefaultFirmId();

// Gate 3 — on the desktop host "the firm" is the SOLE firms row, but this
// module bakes its default at load, before the appliance's firm can be
// known (on a virgin boot, before it even EXISTS — the first-run mint
// creates it mid-session). This guarded setter re-points the live binding;
// every importer and every `firmId = DEFAULT_FIRM_ID` param default reads
// the updated value at call time (ES live bindings). Desktop host ONLY,
// and an explicitly configured env default always wins — cloud semantics
// stay frozen at load. Loud, never silent. Two callers: the runtime-server
// boot (sole-firm query) and the first-run mint route.
export const adoptResolvedDefaultFirmId = (firmId, { reason = 'desktop_sole_firm', logger = console } = {}) => {
  const next = String(firmId || '').trim();
  if (!next || next === DEFAULT_FIRM_ID) return DEFAULT_FIRM_ID;
  if (!isDesktopHostEnv()) return DEFAULT_FIRM_ID;
  if (String(process.env.DONNA_DEFAULT_FIRM_ID || '').trim()) return DEFAULT_FIRM_ID;
  logger.log?.(`[firmDb] default firm re-pointed to ${next} (${reason})`);
  DEFAULT_FIRM_ID = next;
  return DEFAULT_FIRM_ID;
};

// RT-03 (audit F-03): the ONE read of the default firm for request-scoped
// code (server/donna/requestFirm.js). An explicitly configured
// DONNA_DEFAULT_FIRM_ID always wins — the same rule adoptResolvedDefaultFirmId
// enforces — otherwise the LIVE binding above: the value the desktop boot
// re-pointed to the sole minted firm, which resolveConfiguredDefaultFirmId()
// (env-only, demo when unset) never sees. Routes resolve "which firm" from
// the request, else from this — never from the env resolver, never a literal.
export const getDefaultFirmId = () =>
  String(process.env.DONNA_DEFAULT_FIRM_ID || '').trim() || DEFAULT_FIRM_ID;

// Gate 3 half-fix for the silent demo-firm fallback: when a client-create
// names no firm and none is configured, resolve to the SOLE existing firm
// (the appliance's normal state — and the honest answer on any single-firm
// deployment) before falling back to the legacy demo id. Decision logic is
// pure in firstRunFirmMint.resolveClientCreateFirmId; this is its DB wrapper.
export const resolveClientCreateFirmIdInDb = async ({ requestedFirmId = null } = {}) => {
  const configured = String(process.env.DONNA_DEFAULT_FIRM_ID || '').trim() || null;
  let firmRows = [];
  if (!requestedFirmId && !configured) {
    const res = await queryFirmDb('select id from firms limit 2');
    firmRows = res.rows || [];
  }
  return resolveClientCreateFirmId({ requestedFirmId, configuredFirmId: configured, firmRows }) || DEFAULT_FIRM_ID;
};

// ─── Firm-scope isolation: never silently land real data in the demo firm ────
//
// DEMO_FIRM_ID is the fallback every `firmId = DEFAULT_FIRM_ID` signature lands
// on when a caller names no firm. In a real hosted deployment that fallback is a
// data-isolation hazard: a request with no firm_id (connect, upload, write-back)
// silently scopes real client books to the shared demo tenant — exactly how
// the pilot client's books ended up under donna-demo-firm (§E.4). These pure helpers make
// that fail loud in production while staying the normal default in dev/test.

// True when scoping a request to `firmId` is acceptable. A real, explicitly named
// firm is always fine. The demo firm is fine in dev/preview; in production it is
// refused unless an operator explicitly opts in for an intentional demo deploy
// (DONNA_ALLOW_DEMO_FIRM=true). An empty/missing firmId is treated as the demo
// fallback — refused in production for the same reason.
export const isDemoFirmScopeAllowed = (firmId, env = process.env) => {
  if (firmId && firmId !== DEMO_FIRM_ID) return true;
  if (!isProductionRuntime(env)) return true;
  return env.DONNA_ALLOW_DEMO_FIRM === 'true';
};

// Raised when a request resolves to the demo firm in a context that must not
// silently absorb real client data (production). The api.js top-level handler
// surfaces statusCode / code verbatim.
export class FirmScopeError extends Error {
  constructor(firmId) {
    super(
      `Refusing to scope this request to the shared demo firm "${firmId}" in production. ` +
      'Set DONNA_DEFAULT_FIRM_ID to the real firm this deployment serves, pass an explicit firm_id, ' +
      'or set DONNA_ALLOW_DEMO_FIRM=true for an intentional demo deployment.'
    );
    this.name = 'FirmScopeError';
    this.statusCode = 409;
    this.code = 'FIRM_SCOPE_DEMO_BLOCKED';
  }
}

// Throw FirmScopeError when the resolved firm scope is the demo tenant in a
// context that must not silently absorb real client data. Returns firmId
// unchanged when allowed, so callers can guard inline.
export const assertFirmScopeAllowed = (firmId, env = process.env) => {
  if (!isDemoFirmScopeAllowed(firmId, env)) throw new FirmScopeError(firmId);
  return firmId;
};

// Phase 3a — collapse the loaded xero_connections rows into one
// connection summary per client for the snapshot join. Connection STATUS
// is never cached on clients.profile; this derives it at read time so the
// operator card + portal connector tile render live state. Prefers a
// 'connected' row over any other status so a stale errored / disconnected
// row doesn't mask a live connection. Rows arrive ordered connected_at
// desc, so the first seen for a client is also the most recent — that's
// the fallback when no row is connected. Returns a Map keyed by client_id.
export const deriveAccountingConnectionByClient = (connectionRows = []) => {
  const byClient = new Map();
  for (const row of connectionRows) {
    if (!row || !row.client_id) continue;
    const candidate = {
      status: row.status,
      connection_id: row.id,
      // Xero rows carry tenant_name; QBO rows carry company_name. Both feed
      // the same connection-detail line, so collapse them here.
      tenant_name: row.tenant_name || row.company_name || row.organization_name || null,
      last_synced_at: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
      last_error: row.last_error || null
    };
    const existing = byClient.get(row.client_id);
    if (!existing || (existing.status !== 'connected' && candidate.status === 'connected')) {
      byClient.set(row.client_id, candidate);
    }
  }
  return byClient;
};

// Reads a single client's chosen accounting_system (the operator axis) for
// the route layer to dispatch to the right accountingSystems adapter.
// Returns the lowercased value ('xero' | 'qbo' | 'procountor' | 'none') or
// null when unset/missing — which should no longer occur in real data
// (migration 120 backfilled, createClientInDb stamps at birth). A null
// result resolves to 'none' at the registry: fail-closed, no external write.
export const getClientAccountingSystemFromDb = async ({ firmId = DEFAULT_FIRM_ID, clientId } = {}) => {
  if (!clientId) return null;
  const result = await queryFirmDb(
    `select lower(profile->>'accounting_system') as accounting_system
       from clients
      where firm_id = $1 and id = $2`,
    [firmId, clientId]
  );
  return result.rows[0]?.accounting_system || null;
};

// Same read on an already-open client, for callers inside a transaction
// (prepareLedgerTransactionPosting must not grab a second pool connection
// mid-posting).
export const getClientAccountingSystemWithClient = async ({ client, firmId, clientId }) => {
  if (!clientId) return null;
  const result = await client.query(
    `select lower(profile->>'accounting_system') as accounting_system
       from clients
      where firm_id = $1 and id = $2`,
    [firmId, clientId]
  );
  return result.rows[0]?.accounting_system || null;
};

// Read persisted country for connector treatment translation. Missing context
// selects no translator; exact supplied/synced connector codes remain data.
export const getClientJurisdictionForEnrichment = async ({ client, firmId, clientId }) => {
  if (!clientId) return null;
  const result = await client.query(
    'select jurisdiction, profile from clients where firm_id = $1 and id = $2',
    [firmId, clientId]
  ).catch((error) => {
    if (error?.code === '42P01' || error?.code === '42703') return { rows: [] };
    throw error;
  });
  const row = result.rows[0];
  if (!row) return null;
  const jurisdiction = normalizeJurisdictionKey(row.jurisdiction);
  if (!jurisdiction) return null;
  const profileCountry = row.profile?.jurisdiction;
  if (profileCountry != null && String(profileCountry).trim() && normalizeJurisdictionKey(profileCountry) !== jurisdiction) return null;
  return jurisdiction;
};

// Whose business a chat surface is judging FOR — name, jurisdiction,
// entity type, tax profile, accounting currency: the same identity
// facts the batch coder's clientInputFor carries. Without them the
// transaction chat judged tax treatment with no idea which regime
// applies (the GST flip-flop class). Returns null when the client is
// unknown; callers degrade to client-unknown, never to a dead chat.
export const getClientChatProfileFromDb = async ({ firmId = DEFAULT_FIRM_ID, clientId } = {}) => {
  if (!clientId) return null;
  const codingPolicy = await resolveClientCodingPolicy({ firmId, clientId });
  const result = await queryFirmDb(
    'select company_name, jurisdiction, profile from clients where firm_id = $1 and id = $2',
    [firmId, clientId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const profile = row.profile || {};
  const chatProfile = {
    name: profile.companyName || row.company_name || '',
    jurisdiction: row.jurisdiction || '',
    entity_type: profile.entityType || '',
    accounting_currency:
      profile.accountingCurrency || profile.baseCurrency || profile.defaultCurrency || '',
    tax_profile: profile.taxProfile || null,
    // Identity key for Layer-2 facts (firmFacts.js) — survives client
    // recreates, unlike the clients.id row id.
    registration_number: String(profile.uen || '').trim() || null,
    // Where the books live ('xero' | 'qbo' | 'none'). Without it the
    // chat told a Donna-ledger-only client to create accounts "in
    // Xero" — a system the client never connected.
    accounting_system: String(profile.accounting_system || '').toLowerCase() || null,
    // D-PA-3 (design-donna-personal-agent.md §5): the owner's chosen
    // display name for their assistant. Sanitized + 'Donna' fallback so
    // every consumer can render it directly.
    assistant_name: resolveAssistantName(profile),
    // The client's OWN bank accounts (statement-derived) — the chat's
    // internal-transfer anchor, same fact the coder gets (the tx-12/tx-13
    // class: a transfer to the client's own checking proposed as an expense).
    known_bank_accounts: await getClientOwnBankAccountsFromDb({ firmId, clientId })
  };
  // FI-3 slice W (F-FI3-2, + gb/au/us 2026-07-23): route the transaction chat's
  // tax-treatment menu to the client's jurisdiction vocabulary — the SAME marker
  // the batch coder gets (the three coder clientProfile sites). Without it the
  // chat kept proposing SG GST options to a routed client.
  // taxTreatmentOptionsForClient reads this in buildTransactionChatContext.
  withClientCodingPolicy(chatProfile, codingPolicy);
  return chatProfile;
};

// The client's OWN bank-account identities — the registry truth that lets the
// coder tell an internal transfer ("ONLINE TRANSFER TO CHECKING 1587782") from
// a payment to a third party. Read from the parsed statements'
// payload.statement_summary (account_number / bank_name / iban — the same
// header identity the account fingerprint and the jurisdiction detector
// consume; both extraction paths normalize to it). Soft-fails to [] — a
// missing roster degrades the coder to its ask-the-client posture, never a
// dead call. Bounded: a client has a handful of accounts, not hundreds.
export const loadClientOwnBankAccounts = async (client, { firmId = DEFAULT_FIRM_ID, clientId } = {}) => {
  if (!client || !clientId) return [];
  try {
    const result = await client.query(
      `select distinct
              d.payload->'statement_summary'->>'bank_name' as bank_name,
              d.payload->'statement_summary'->>'account_number' as account_number,
              d.payload->'statement_summary'->>'iban' as iban
         from documents d
        where d.firm_id = $1 and d.client_id = $2
          and d.document_type in ('bank_statement', 'payment_account_statement')
          and d.payload ? 'statement_summary'
        limit 24`,
      [firmId, clientId]
    );
    return result.rows.filter((row) => row.account_number || row.iban).slice(0, 12);
  } catch (error) {
    console.warn('[firmDb] own-bank-accounts lookup failed', error?.message || error);
    return [];
  }
};

export const getClientOwnBankAccountsFromDb = async ({ firmId = DEFAULT_FIRM_ID, clientId } = {}) =>
  withFirmDbClient((client) => loadClientOwnBankAccounts(client, { firmId, clientId }));

// Pure: derive the load-bearing identity COLUMNS from an intake profile.
// `clients.legal_names` feeds the firm anchor (getClientIdentityInDb →
// every extractor + matcher prompt) and `clients.jurisdiction` feeds the
// extractor date-format hint (getClientJurisdictionInDb) — neither reads
// the profile JSONB, so a create path that only writes the blob produces
// a venture the pipeline can't anchor on.
export const deriveClientIdentityColumns = (profile = {}) => {
  const names = [];
  const push = (value) => {
    const name = value == null ? '' : String(value).trim();
    if (name && !names.some((existing) => existing.toLowerCase() === name.toLowerCase())) {
      names.push(name);
    }
  };
  push(profile.companyName || profile.name);
  push(profile.legalName);
  for (const name of Array.isArray(profile.legalNames) ? profile.legalNames : []) push(name);

  const rawJurisdiction = profile.jurisdiction == null ? '' : String(profile.jurisdiction).trim();
  const jurisdiction = /^[A-Za-z]{2}$/.test(rawJurisdiction) ? rawJurisdiction.toUpperCase() : null;

  return { legalNames: names, jurisdiction };
};

// The accounting_system a client is born with (or keeps) across the
// createClientInDb upsert. Pure, exported for unit tests. Returns a patch
// to merge into the profile about to be written, or null when the incoming
// profile already carries an explicit value (honoured verbatim).
//
//   - incoming has a non-blank accounting_system → null (caller's choice
//     stands, same as before this helper existed).
//   - stored row has one → carry the stored value AND its provenance keys
//     forward. The upsert writes `profile = excluded.profile` wholesale, so
//     a re-provision that didn't restate the axis used to silently strip an
//     operator's stamp back to unset — and unset used to mean "route to
//     Xero" (the retired legacy fallback).
//   - neither → born 'none' (the Donna-native ledger), provenance
//     'system:create_default' so a birth stamp stays distinguishable from
//     an operator's explicit pick and from migration 120's backfill.
//     Connecting Xero/QBO later re-stamps through the governed profile
//     update, exactly as honeybee was stamped on the appliance.
export const resolveCreateAccountingSystemPatch = ({ incoming = {}, stored = null, now = new Date() } = {}) => {
  const incomingValue = typeof incoming?.accounting_system === 'string'
    ? incoming.accounting_system.trim()
    : '';
  if (incomingValue) return null;
  const storedValue = typeof stored?.accounting_system === 'string'
    ? stored.accounting_system.trim()
    : '';
  if (storedValue) {
    const patch = { accounting_system: storedValue };
    if (stored.accounting_system_set_by != null) patch.accounting_system_set_by = stored.accounting_system_set_by;
    if (stored.accounting_system_set_at != null) patch.accounting_system_set_at = stored.accounting_system_set_at;
    return patch;
  }
  const iso = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  return {
    accounting_system: 'none',
    accounting_system_set_by: 'system:create_default',
    accounting_system_set_at: iso
  };
};

// BF-3 — clients.id is a legacy global primary key even though every client
// belongs to one firm. A document-derived id can therefore collide across two
// firms. That collision is a refusal, never authority to move the existing row
// (or any of its client-scoped ownership) into the requesting firm.
//
// Keep the receipt deliberately tenant-safe: it identifies the rejected input
// and requested scope, but does not disclose the other firm's id.
export class ClientIdFirmConflictError extends Error {
  constructor({ clientId, requestedFirmId } = {}) {
    super(`Client id "${clientId}" is already assigned outside this firm; no client was created.`);
    this.name = 'ClientIdFirmConflictError';
    this.statusCode = 409;
    this.code = 'CLIENT_ID_FIRM_CONFLICT';
    this.details = {
      client_id: clientId,
      requested_firm_id: requestedFirmId,
      correction: 'choose_firm_scoped_client_id'
    };
  }
}

const assertClientIdBelongsToFirm = (row, { clientId, firmId } = {}) => {
  if (row && row.firm_id !== firmId) {
    throw new ClientIdFirmConflictError({ clientId, requestedFirmId: firmId });
  }
};

const cleanClientCreationReceiptValue = (value) => {
  const cleaned = String(value || '').trim();
  return cleaned || null;
};

// BF-4 — the create writer is also the audit boundary. HTTP surfaces supply
// the authenticated principal that initiated the operation; internal callers
// which have no human principal retain an explicit system receipt. Keeping the
// system executor in metadata means a human-triggered create never has to
// sacrifice either side of the truth: WHO authorized it and WHAT executed it.
export const buildClientCreationAuditContext = (input = null) => {
  if (input == null) {
    return {
      actorType: 'system',
      actorId: 'system',
      authorityBasis: {
        source: 'internal_client_create',
        principal_type: 'system',
        principal_id: 'system'
      }
    };
  }

  const {
    principalType = null,
    principalId = null,
    authoritySource = null
  } = input;
  const actorType = cleanClientCreationReceiptValue(principalType);
  const actorId = cleanClientCreationReceiptValue(principalId);
  const source = cleanClientCreationReceiptValue(authoritySource);

  if (
    !actorType ||
    !actorId ||
    !source ||
    actorType.toLowerCase() === 'system' ||
    actorId.toLowerCase() === 'system'
  ) {
    const error = new Error('Authenticated client creation requires a real initiating principal and authority source.');
    error.statusCode = 401;
    error.code = 'CLIENT_CREATION_PRINCIPAL_REQUIRED';
    throw error;
  }

  return {
    actorType,
    actorId,
    authorityBasis: {
      source,
      principal_type: actorType,
      principal_id: actorId
    }
  };
};

export const createClientInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  profile,
  queue = [],
  creationPrincipal = null,
  // Internal contract only; public intake supplies facts, never this identifier.
  birthContract = null,
  processingReviewFacts = null,
  dbClient = null
} = {}) => {
  if (!profile?.id) {
    const error = new Error('Client profile id is required.');
    error.statusCode = 400;
    throw error;
  }

  const creationAudit = buildClientCreationAuditContext(creationPrincipal);

  // Phase 1.5 — new clients start with an EXPLICIT empty services_engaged
  // so the portal renders the "not scoped yet" placeholder (and the firm
  // card a warning) instead of silently showing every tile. The cohort
  // split keys on absent-key (legacy → all tiles) vs explicit-[] (new →
  // unscoped); stamping [] here is what puts a fresh client in the latter.
  // An incoming profile that already carries services_engaged is honoured.
  // BF-2 — every creation surface converges here. Canonicalize the bounded,
  // jurisdiction-specific legal-form vocabulary BEFORE opening the write
  // transaction. A supported intake alias becomes the exact value runtime
  // resolvers consume; an ambiguous/unsupported value returns a typed 422 with
  // the correction choices and cannot leave a client row behind.
  const legalFormIdentity = canonicalizeClientProfileLegalForm(profile);
  const profileToWrite = {
    ...normalizeAccountingProfilePatch(legalFormIdentity.profile),
    services_engaged: Array.isArray(profile.services_engaged) ? profile.services_engaged : []
  };

  const identityColumns = deriveClientIdentityColumns(profileToWrite);

  // Reported to the caller: the provisioning scope decision (a client born in
  // this call proves birth residue; a pre-existing one must not) needs the
  // same authoritative created-vs-updated signal this upsert already locks on.
  let createdNewClient = false;
  let hostedBirthReceipt = null;
  let nativeBirthReference = null;
  let consumedNativeSelection = null;

  const run = async (client) => {
    await client.query('begin');
    try {
      const incomingEntityType = legalFormIdentity.canonical;
      // BF-3 — lock by the GLOBAL key, not (firm_id, id). The old scoped read
      // hid a row owned by another firm and the upsert below then reassigned it.
      // An existing collision is refused before the first mutation in this
      // transaction. The guarded upsert separately closes the missing-row race.
      const existingRow = await client.query(
        `select entity_type,
                firm_id, profile,
                profile->>'accounting_system' as accounting_system,
                profile->>'accounting_system_set_by' as accounting_system_set_by,
                profile->>'accounting_system_set_at' as accounting_system_set_at
           from clients where id = $1 limit 1 for update`,
        [profile.id]
      );
      const isNewClient = existingRow.rows.length === 0;
      createdNewClient = isNewClient;
      assertClientIdBelongsToFirm(existingRow.rows[0] || null, {
        clientId: profile.id,
        firmId
      });
      // Retained native identity wins over current selector/profile input on
      // EVERY retry. A generic upsert must never rewrite its birth or GST facts.
      const lineage = !isNewClient
        ? await readNativeChartLineage({ query: client.query.bind(client), firmId, clientId: profile.id, lock: true }) : null;
      if (lineage) {
        const metadata = lineage.receipt.metadata;
        if (birthContract && (birthContract.id !== metadata.birth_contract
          || birthContract.bookkeeping_start_date !== metadata.bookkeeping_start_date
          || nativeChartDigest(birthContract.registration_observation) !== metadata.registration_digest)) nativeChartFailure('retry_contract_mismatch');
        const retryContract = birthContract || { id: metadata.birth_contract,
          bookkeeping_start_date: metadata.bookkeeping_start_date,
          registration_observation: { revision: 'profile.gst_registration.observation.v1', record: profileToWrite.gst_registration ?? null } };
        validateNativeBirthInput(retryContract, { jurisdiction: identityColumns.jurisdiction,
          entity_type: incomingEntityType, profile: profileToWrite }, creationAudit);
        if (processingReviewFacts) {
          validateNativeProcessingFacts(processingReviewFacts, profileToWrite);
          if (processingReviewFacts.bookkeeping_start_date !== metadata.bookkeeping_start_date) nativeChartFailure('retry_contract_mismatch');
        }
        await readNativeRegistrationEvidence({ query: client.query.bind(client), firmId, clientId: profile.id,
          lineage, profile: existingRow.rows[0].profile, lock: true });
        const member = (await client.query("select id from firm_members where firm_id=$1 and id=$2 and status='active' for share",
          [firmId, creationAudit.actorId])).rows[0];
        if (!member) nativeChartFailure('active_member_required');
        // Idempotent retry cannot patch the book, queue, birth or creator.
        await client.query('commit');
        return;
      }
      if (birthContract && !isNewClient) nativeChartFailure('existing_client_not_native');
      if (!birthContract && (processingReviewFacts || (identityColumns.jurisdiction?.toUpperCase() === 'SG'
        && creationAudit.authorityBasis?.source === 'authenticated_firm_create_route'))) {
        const selection = await readNativeProcessingSelectionWithClient(client, { firmId, lock: true });
        if (processingReviewFacts && (!selection.available || processingReviewFacts.selection_id !== selection.selection_id)) {
          nativeIntakeFailure('SG_NATIVE_INTAKE_SELECTION_CHANGED', 'Document processing and review availability changed. Reload the intake before creating this workspace.');
        }
        if (selection.available) {
          if (!isNewClient) nativeIntakeFailure('SG_NATIVE_INTAKE_EXISTING_BOOK', 'This existing workspace cannot be converted by intake. Its book remains unchanged.');
          validateNativeProcessingFacts(processingReviewFacts, profileToWrite);
          if (profileToWrite.gst_registration != null) nativeIntakeFailure('SG_NATIVE_INTAKE_GST_UNVERIFIED', 'A Bizfile does not establish GST registration. Record supported registration evidence after creation.');
          const member = (await client.query("select id from firm_members where firm_id=$1 and id=$2 and status='active' for share",
            [firmId, creationAudit.actorId])).rows[0];
          if (!member) nativeChartFailure('active_member_required');
          birthContract = { id: 'sg_pte_native.v1', bookkeeping_start_date: processingReviewFacts.bookkeeping_start_date,
            registration_observation: { revision: 'profile.gst_registration.observation.v1', record: null } };
          consumedNativeSelection = { firm_id: firmId, selector: selection.receipt };
        }
      }
      const storedEntityType = existingRow.rows[0]?.entity_type ?? null;
      // Born 'none' / carry the stored stamp — see resolveCreateAccountingSystemPatch.
      const accountingSystemPatch = resolveCreateAccountingSystemPatch({
        incoming: profileToWrite,
        stored: existingRow.rows[0] || null
      });
      const storedAccounting = Object.fromEntries(ACCOUNTING_PROFILE_KEYS
        .filter((key) => Object.prototype.hasOwnProperty.call(existingRow.rows[0]?.profile || {}, key))
        .map((key) => [key, existingRow.rows[0].profile[key]]));
      const profileForInsert = {
        ...storedAccounting,
        ...normalizeAccountingProfilePatch(profileToWrite, storedAccounting),
        ...(accountingSystemPatch || {})
      };
      if (birthContract) {
        if (isDesktopHostEnv()) nativeChartFailure('hosted_processing_birth_required');
        validateNativeBirthInput(birthContract, { jurisdiction: identityColumns.jurisdiction,
          entity_type: incomingEntityType, profile: profileToWrite }, creationAudit);
      }
      const clientLifecycle = resolveClientLifecycle(identityColumns.jurisdiction);
      await clientLifecycle?.beforeIdentityWrite?.({ client, firmId, clientId: profile.id, storedEntityType, incomingEntityType });

      let clientUpsert;
      try {
        clientUpsert = await client.query(
          `insert into clients (
          id, firm_id, company_name, uen, entity_type, incorporation_date, stage, next_deadline, status, profile,
          legal_names, jurisdiction
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9::jsonb, $10::text[], $11)
        on conflict (id) do update set
          company_name = excluded.company_name,
          uen = excluded.uen,
          entity_type = excluded.entity_type,
          incorporation_date = excluded.incorporation_date,
          stage = excluded.stage,
          next_deadline = excluded.next_deadline,
          status = 'active',
          profile = excluded.profile,
          legal_names = excluded.legal_names,
          jurisdiction = excluded.jurisdiction,
          updated_at = now()
        where clients.firm_id = excluded.firm_id and not $12::boolean
        returning id, firm_id`,
          [
            profile.id,
            firmId,
            profileToWrite.companyName || profileToWrite.name || profile.id,
            profileToWrite.uen || null,
            incomingEntityType,
            profileToWrite.incorporationDate || null,
            profileToWrite.stage || null,
            profileToWrite.nextDeadline || null,
            JSON.stringify(profileForInsert),
            identityColumns.legalNames,
            identityColumns.jurisdiction,
            Boolean(birthContract)
          ]
        );
      } catch (error) {
        // ON CONFLICT (id) arbitrates only the primary key. Two creates of the
        // same (firm_id, id) can both pass its pre-check; the later index insert
        // then waits for the winner and, once it commits, fails on the second
        // unique index instead of reaching the zero-row branch below. For a
        // native birth that is the same competing birth (the transaction is
        // aborted and rolls back). Any other error is rethrown unchanged.
        if (birthContract && error?.code === '23505' && error.table === 'clients'
          && error.constraint === 'clients_firm_id_id_key') nativeChartFailure('competing_birth');
        throw error;
      }
      // Two firms can both observe a missing id before either insert commits.
      // PostgreSQL serializes them at ON CONFLICT; the losing firm reaches the
      // false WHERE predicate and returns zero rows. Refuse and roll back every
      // later side effect instead of turning that race into a transfer.
      if (clientUpsert.rowCount === 0) {
        if (birthContract) nativeChartFailure('competing_birth');
        throw new ClientIdFirmConflictError({ clientId: profile.id, requestedFirmId: firmId });
      }

      await clientLifecycle?.afterIdentityWrite?.({ client, firmId, clientId: profile.id, storedEntityType, incomingEntityType });

      for (const item of queue) {
        if (!item?.id) continue;
        // A queue item belongs to the client being written, never to another
        // client (the item body is caller-supplied). The primary key is global,
        // so the upsert is fenced to the requesting firm exactly like the
        // clients upsert above (BF-3): a row that matches by id but belongs to
        // another firm updates nothing and the request is refused.
        if (item.client_id && item.client_id !== profile.id) {
          const error = new Error(`Queue item "${item.id}" names a client other than the one being written.`);
          error.statusCode = 409;
          error.code = 'QUEUE_ITEM_CLIENT_MISMATCH';
          error.details = { queue_item_id: item.id, client_id: profile.id };
          throw error;
        }
        const queueUpsert = await client.query(
          `insert into queue_items (id, firm_id, client_id, queue_label, status, payload, created_at)
           values ($1, $2, $3, $4, 'open', $5::jsonb, coalesce($6::timestamptz, now()))
           on conflict (id) do update set
             client_id = excluded.client_id,
             queue_label = excluded.queue_label,
             status = 'open',
             payload = excluded.payload,
             updated_at = now()
           where queue_items.firm_id = excluded.firm_id
           returning id`,
          [
            item.id,
            firmId,
            profile.id,
            item.queue_label || null,
            JSON.stringify({ ...item, client_id: profile.id }),
            item.created_at ? new Date(Number(item.created_at)).toISOString() : null
          ]
        );
        if (queueUpsert.rowCount === 0) {
          const error = new Error(`Queue item id "${item.id}" is already assigned outside this firm; no client was created.`);
          error.statusCode = 409;
          error.code = 'QUEUE_ITEM_FIRM_CONFLICT';
          error.details = { queue_item_id: item.id, requested_firm_id: firmId };
          throw error;
        }
      }

      // S2 + Gate 1B.3: on the desktop host a client is born with its runtime
      // plane rows ('auto' for the extractor wave + CODING_AUTO_POST). A row
      // that did not exist before this transaction also receives the exact
      // client-scoped readiness canary. Existing/legacy rows are deliberately
      // not enrolled by an idempotent upsert; they need the targeted manual
      // heal path.
      // This is load-bearing initialization, not a recoverable sidecar. A
      // seed failure aborts the WHOLE create transaction, so no active client
      // can exist without the runtime plane that makes its work drain. Boot
      // backfill remains recovery for legacy clients; it is never the success
      // path for a newly-created client. Cloud is untouched: the host gate
      // keys off DONNA_DESKTOP_BLOB_DIR.
      if (isDesktopHostEnv()) {
        let initializationStage = 'desktop_client_plane_seed';
        try {
          await seedDesktopClientPlaneRowsWithClient(client, { firmId, clientId: profile.id });
          // The chart follows the menu: with JURISDICTION_ACCOUNT_PALETTE just
          // seeded above (same transaction, same connection — the snapshot
          // read sees it), the client's pack palette lands in ledger_accounts
          // now, so no first posting has to mint a half-typed account. A row
          // born in this transaction is a new book: a market/form that declares
          // a coded birth chart (FI Oy, FI-21) is born with it, exactly as the
          // hosted birth does. A re-save keeps its chart untouched.
          initializationStage = 'pack_palette_chart_seed';
          await seedPackPaletteChartWithClient(client, { firmId, clientId: profile.id, newBook: isNewClient });
          if (isNewClient) {
            initializationStage = 'entity_readiness_new_client_enrollment';
            await seedNewClientReadinessEnrollmentWithClient(client, {
              firmId,
              clientId: profile.id
            });
          }
        } catch (seedError) {
          console.error(
            '[desktop] runtime plane seed failed; client creation will roll back',
            seedError?.message || seedError
          );
          const error = new Error(
            'Client runtime initialization failed; no client was created. Retry the request.'
          );
          error.statusCode = 503;
          error.code = 'CLIENT_RUNTIME_INITIALIZATION_FAILED';
          error.details = {
            stage: initializationStage,
            client_id: profile.id,
            retryable: true
          };
          error.cause = seedError;
          throw error;
        }
      }

      if (isNewClient && !isDesktopHostEnv()) {
        if (consumedNativeSelection) {
          consumedNativeSelection.client_config = await setClientFlagStage(client, { firmId, clientId: profile.id,
            flagKey: SG_NATIVE_PROCESSING_REVIEW_FLAG, stage: 'canary', source: 'manual',
            reason: 'authenticated_sg_native_processing_birth', actorType: creationAudit.actorType, actorId: creationAudit.actorId });
        }
        hostedBirthReceipt = await seedHostedFirmClientWithClient(client, {firmId,clientId:profile.id,creationAudit,
          ...(birthContract ? { birthContext: { birthContract, creationAudit, createdNewClient: true } } : {})});
      }
      if (birthContract) {
        if (!hostedBirthReceipt) nativeChartFailure('hosted_processing_birth_required');
        const lineage = await readNativeChartLineage({ query: client.query.bind(client), firmId, clientId: profile.id },
          { requireCreation: false, expectedContract: birthContract.id });
        nativeBirthReference = { receipt_id: lineage.receipt.id, receipt_digest: lineage.receipt.metadata.receipt_digest, contract_id: birthContract.id };
      }

      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, $3, $4, 'client.create', 'client', $2, $5::jsonb)`,
        [
          firmId,
          profile.id,
          creationAudit.actorType,
          creationAudit.actorId,
          JSON.stringify({
            queue_count: queue.length,
            ...(nativeBirthReference ? { native_chart_birth: nativeBirthReference } : {}),
            ...(consumedNativeSelection ? { native_processing_selection: consumedNativeSelection } : {}),
            ...(hostedBirthReceipt ? { hosted_birth_model_policy: hostedBirthReceipt.birth_model_policy } : {}),
            ...(hasAccountingProfilePatch(profileForInsert) ? { accounting_profile: readAccountingProfile(profileForInsert) } : {}),
            authority_basis: creationAudit.authorityBasis,
            executor: {
              actor_type: 'system',
              actor_id: 'createClientInDb'
            }
          })
        ]
      );

      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  };

  // dbClient escape hatch mirrors updateClientProfileInDb — inject a
  // mock client in tests (snapshot skipped); production callers omit it.
  if (dbClient) {
    await run(dbClient);
    return { created: createdNewClient, hosted_birth: hostedBirthReceipt?.version || null, snapshot: null };
  }
  await withFirmDbClient(run);
  // hosted_birth: the hosted pilot version this request birthed, if any — the
  // route's readiness coordinate follows it (a US client born into the
  // hosted pilot is a firm-intake profile, not the generic route).
  return { created: createdNewClient, hosted_birth: hostedBirthReceipt?.version || null, snapshot: await getFirmSnapshotFromDb({ firmId }) };
};

// Returns the small slice of client identity the document router and
// downstream classification logic need:
//   display_name : the firm-facing UI string (clients.company_name).
//   legal_names  : the canonical legal name and any trading-name
//                  aliases. By convention legal_names[0] is canonical
//                  and the remainder are aliases; the router consumes
//                  the whole array as alternative forms to match on.
//
// Returns null when the client doesn't exist. Defence in depth — never
// throws on a missing row so a freshly-uploaded doc for a stale
// client_id can still parse with `clientIdentity=null` (which puts
// the router into direction='unknown' fallback rather than blowing up
// the worker).
export const getClientIdentityInDb = async ({ firmId = DEFAULT_FIRM_ID, clientId } = {}) => {
  if (!firmId || !clientId) return null;
  const result = await queryFirmDb(
    'select id, company_name, legal_names from clients where firm_id = $1 and id = $2 limit 1',
    [firmId, clientId]
  );
  if (!result.rows.length) return null;
  const row = result.rows[0];
  const legalNames = Array.isArray(row.legal_names) ? row.legal_names.filter(Boolean) : [];
  return {
    id: row.id,
    display_name: row.company_name || null,
    legal_names: legalNames
  };
};

export const getClientEntityAxisFromDb = async ({ firmId = DEFAULT_FIRM_ID, clientId } = {}) => {
  if (!firmId || !clientId) return null;
  try {
    const result = await queryFirmDb(
      'select jurisdiction, entity_type, profile from clients where firm_id = $1 and id = $2 limit 1',
      [firmId, clientId]
    );
    if (!result.rows.length) return null;
    const row = result.rows[0];
    return resolveClientLifecycleAxis(row);
  } catch (error) {
    console.warn('[firmDb] getClientEntityAxisFromDb failed', error?.message || error);
    return null;
  }
};

// 0A.9 — InDb wrapper for the config control plane snapshot. The parse worker
// (handleParseEvent) has no raw pg client in scope — only firmId + clientId — so
// it resolves a per-run client_capability_config snapshot through this wrapper, the
// same way it reads identity / jurisdiction / corrections. Delegates to
// readClientConfigSnapshot, whose queries already soft-fail to {}; a connection-
// level throw is handled by the caller's soft-degrade try/catch. Returns {} when
// firmId/clientId are missing (no client to scope to ⇒ env fallback downstream).
export const readClientConfigSnapshotInDb = async ({ firmId = DEFAULT_FIRM_ID, clientId } = {}) => {
  if (!firmId || !clientId) return {};
  return withFirmDbClient((client) => readClientConfigSnapshot(client, { firmId, clientId }));
};

// Returns the firm's jurisdiction string (firms.jurisdiction) or null
// when unset. Used by the worker to compute a locale-aware date hint
// for the extractor prompts (see jurisdictionDate.js). Never throws.
export const getFirmJurisdictionInDb = async ({ firmId = DEFAULT_FIRM_ID } = {}) => {
  if (!firmId) return null;
  const result = await queryFirmDb(
    'select jurisdiction from firms where id = $1 limit 1',
    [firmId]
  );
  if (!result.rows.length) return null;
  const value = result.rows[0].jurisdiction;
  return value && String(value).trim() ? String(value).trim() : null;
};

// Returns the EFFECTIVE jurisdiction for a (firm, client) pair, with
// the client value taking precedence over the firm value. Used by the
// worker so a UK-based client managed by an SG firm gets the UK date
// hint rather than the firm's SG hint. Falls back to the firm value
// when the client column is null/empty; falls back to null when both
// are unset.
//
// Single query with LEFT JOIN — the firm row may not exist (defensive),
// the client row may not exist (also defensive), and either column may
// be null/empty. Trim and treat empty strings as unset so an operator
// who clears the column doesn't silently re-enable an inherited
// firm-level value via empty-string fallback.
export const getClientJurisdictionInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId
} = {}) => {
  if (!firmId) return null;
  if (!clientId) {
    // Caller is operating without a client context — fall back to the
    // firm-only path so existing call sites keep working.
    return getFirmJurisdictionInDb({ firmId });
  }
  const result = await queryFirmDb(
    `select c.jurisdiction as client_jurisdiction,
            f.jurisdiction as firm_jurisdiction
       from firms f
       left join clients c
              on c.firm_id = f.id and c.id = $2
      where f.id = $1
      limit 1`,
    [firmId, clientId]
  );
  if (!result.rows.length) return null;
  const row = result.rows[0];
  const client = row.client_jurisdiction && String(row.client_jurisdiction).trim();
  if (client) return client;
  const firm = row.firm_jurisdiction && String(row.firm_jurisdiction).trim();
  return firm || null;
};

export const deleteClientInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  revokeAtProvider = true,
  clearXeroMirrorAtProvider = false,
  retentionOverride = false,
  withFirmDbClientFn = withFirmDbClient
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required.');
    error.statusCode = 400;
    throw error;
  }

  // G-9 retention guard, BEFORE the best-effort Xero teardown below — a held
  // book must refuse without side effects. The cascade deletes the ledger,
  // documents, and close_archives: the statutory book, so the guard uses the
  // longer kirjanpitokirja horizon. An explicit retentionOverride proceeds and
  // is receipted on the client.delete audit event — never silent (D-G9-3).
  const heldFiscalYears = await withFirmDbClientFn((client) =>
    __heldFiscalYearsForRetention(client, { firmId, clientId, retentionClass: 'kirjanpitokirja' }));
  if (heldFiscalYears && !retentionOverride) {
    const retainUntil = heldFiscalYears.map((fy) => fy.hold.retain_until).sort().pop();
    const error = new Error(
      `KPL 2:10 retention holds this client's statutory book (fiscal years ${heldFiscalYears.map((fy) => fy.label).join(', ')}) until ${retainUntil}. ` +
      'Export the close archives first; pass retention_override=true to delete anyway (audited).'
    );
    error.statusCode = 409;
    error.code = 'FINLAND_RETENTION_CLIENT_HELD';
    error.details = { held_fiscal_years: heldFiscalYears.map((fy) => fy.label), retain_until: retainUntil };
    throw error;
  }

  // Best-effort teardown at Xero, BEFORE the cascade drops the rows (and the
  // xero_connections tokens). Order matters: clear the BankTransaction MIRROR
  // first (it needs a live token + the grant), THEN revoke the grant — otherwise
  // the mirrored BankTransactions are orphaned and/or the org stays "connected"
  // to the app and a re-upload + reconnect is stuck. Both run OUTSIDE the delete
  // transaction and never block the local delete (the operator's source of truth).
  //
  // clearXeroMirrorAtProvider defaults FALSE — the safe "DB-side clear first" cut
  // (docs/xero-writeback-idempotency-across-reset.md §4 / G2): drop our DB
  // back-references / hand the books over, but do NOT void real BankTransactions
  // in the live org. Pass true to VOID the untouched Donna mirrors (G6-guarded)
  // on a reset/rebuild so the re-upload posts clean — enable that only once the
  // orphan amount-drift diagnosis confirms voiding is needed (see the handoff).
  await clearXeroMirrorForClientBestEffort({ firmId, clientId, voidAtProvider: clearXeroMirrorAtProvider });
  if (revokeAtProvider) {
    await revokeXeroGrantsForClientBestEffort({ firmId, clientId });
  }

  return withFirmDbClientFn(async (client) => {
    await client.query('begin');
    try {
      // G-9: re-check the retention hold inside the transaction (the pre-check
      // above ran on a separate connection — the in-txn check is authoritative,
      // the G-8 cap pattern). An override skips the refusal, never the receipt.
      const heldInTxn = await __heldFiscalYearsForRetention(client, { firmId, clientId, retentionClass: 'kirjanpitokirja' });
      if (heldInTxn && !retentionOverride) {
        const retainUntil = heldInTxn.map((fy) => fy.hold.retain_until).sort().pop();
        const error = new Error(`KPL 2:10 retention holds this client's statutory book until ${retainUntil}.`);
        error.statusCode = 409;
        error.code = 'FINLAND_RETENTION_CLIENT_HELD';
        throw error;
      }
      // local_jobs rows name their client only inside payload (no FK), so the
      // cascade below never reaches them — and the birth residue proof counts
      // them in every status, so the deleted life's job history bricks the
      // next birth under the same id (2026-09-08, prior_client_residue:local_jobs
      // × 3, exhausted). Purge them here, in the transaction, before the
      // receipt below so the receipt carries what died.
      const localJobsPurged = await purgeLocalJobsForDeletedClient({ client, clientId });

      // Record the audit event before the cascade so client_id is still
      // resolvable. audit_events.client_id is `on delete set null`, so the
      // row survives the cascade with a NULL client_id; resource_id keeps
      // the deleted id for forensics. A retention override rides this event
      // as its receipt (D-G9-3); the purged job rows ride it too.
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', 'client.delete', 'client', $2, $3::jsonb)`,
        [firmId, clientId, JSON.stringify({
          ...(heldInTxn ? {
            retention_override: true,
            held_fiscal_years: heldInTxn.map((fy) => fy.label),
            retain_until: heldInTxn.map((fy) => fy.hold.retain_until).sort().pop()
          } : {}),
          ...(localJobsPurged
            ? { local_jobs_purged: { total: localJobsPurged.deleted, by_status: localJobsPurged.by_status } }
            : {})
        })]
      );

      // The cascade below also takes the AUTHORITY PLANE (client_capability_config
      // stage rows, reconciliation_authority_grants). Dying fail-closed is intended
      // — a reset must never silently re-arm authority — but dying SILENTLY is not:
      // a 2026-08-06 re-run disarmed LEDGER_AUTO_POST + RECONCILIATION_MATERIAL_AUTO_FYI
      // with no trace. Receipt what dies, before the cascade, so re-staging is a
      // checklist instead of forensics.
      await recordAuthorityPlaneWipeReceipt({ client, firmId, clientId });

      // Hard delete. Every client-keyed table is declared with
      // `client_id text references clients(id) on delete cascade`, so this
      // single statement removes the client and every dependent row
      // (transactions, documents, queue_items, ledger_*, evidence_*, etc.)
      // in one shot.
      const result = await client.query(
        'delete from clients where firm_id = $1 and id = $2 returning id',
        [firmId, clientId]
      );

      if (!result.rows.length) {
        const error = new Error('Client not found.');
        error.statusCode = 404;
        throw error;
      }

      // firm_facts has no client_id FK, so the cascade above leaves them
      // standing. Purge (hard-delete) the facts minted from this now-deleted
      // client (provenance.client_id) so a fresh re-upload is a genuine clean
      // slate, re-teachable. In-transaction with the delete; table-presence
      // guarded so a pre-migration deploy can never block a client deletion.
      await purgeFirmFactsForDeletedClient({ client, firmId, clientId });
      // Donna Loops shadow rows use a plain client_id (no clients FK, the
      // firm_facts pattern), so the cascade above leaves them standing —
      // purge them explicitly, in-transaction, table-presence guarded.
      await purgeLoopsShadowForDeletedClient({ client, firmId, clientId });
      // Convergence metric snapshots (Slice J trend) also use a plain client_id,
      // so the cascade misses them too — purge the now-deleted client's series so
      // a re-upload is a clean slate (firm memory dies with its client).
      await purgeConvergenceMetricSnapshotsForDeletedClient({ client, firmId, clientId });
      // memories (BizOS Slice 2b, migration 085) keeps its legal_entity lifecycle
      // root as a plain column (no clients FK), so the cascade misses it too. A
      // legal-entity memory dies with its legal entity (memory-v2 addendum §6) —
      // hard delete, in-transaction, presence-guarded, never flag-gated.
      await purgeMemoriesForDeletedLegalEntity({ client, firmId, clientId });
      // llm_decisions has no clients FK, so migration 129 gives its retained
      // Tier-1 receipts the same de-linked archival shape as audit_events.
      // Destroy Tier-2/Tier-3 prose, then null the old client link with a
      // write-once stamp under the transaction-authorized trigger exception.
      // This must happen before a deterministic client id can be reused.
      await archiveLlmDecisionsForDeletedClient({ client, firmId, clientId });

      await client.query('commit');
      return getFirmSnapshotFromDb({ firmId });
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};

// ─── EAW isolated-firm lifecycle (Unit 39 production prerequisite) ───────────
//
// Kari-authorized 2026-08-19: a symmetric, safe, isolated-firm lifecycle so
// the EAW DB-close harness can run against a real database without direct SQL
// and without ever touching a live book. Safety is by construction, not
// convention:
//   - firm ids MUST carry the `eaw-` prefix, so the demo/default firm ids can
//     never match and a careless call cannot adopt or delete a real firm;
//   - deleteFirmInDb deletes ONLY firms whose metadata says
//     created_via 'eaw_lifecycle' — every other firm refuses, prefix or not;
//   - on a non-local database the pair refuses outright unless the operator
//     explicitly opts in (DONNA_ALLOW_EAW_FIRM_LIFECYCLE=true — the
//     assertSeedTargetAllowed pattern; local databases are free);
//   - both calls demand a REAL actor (operator-safety substrate #1): a
//     missing or 'system' actor refuses. Per-mutation attribution is the
//     Unit 46 admission contract, and it starts at the writers.
//
// Migration 119 makes audit_events append-only with deliberately NO escape
// hatch: a firms-row delete would cascade DELETEs into the trail, which the
// trigger refuses. So deleteFirmInDb is a RETIRE, not a cascade (Kari's go,
// 2026-08-19): it snapshots the authority plane AND the full audit trail
// into the returned receipt (retention handled deliberately — the receipt
// is the export), deletes the clients (their audit rows survive via the
// sanctioned set-null cascade, 119 shape 2), sets the 037/038 purge GUC
// transaction-locally so the loop/suspension guards admit their sanctioned
// removal, sweeps every firm-scoped table EXCEPT audit_events and firms,
// then marks the firms row retired and appends a firm.eaw_retired audit
// event. WHO/WHEN survives forever; every row of eval bookkeeping state is
// provably gone. countFirmResidueInDb is the read-only probe a harness
// calls AFTER retirement to verify cleanup independently: `residue` must be
// zero; the retained set (one retired firms row + its audit trail) is
// reported separately and is BY DESIGN.

export const EAW_FIRM_ID_PREFIX = 'eaw-';
export const EAW_FIRM_LIFECYCLE_VERSION = 'eaw.firm-lifecycle.v1';

export class EawFirmLifecycleError extends Error {
  constructor(message, { statusCode = 400, code = 'EAW_FIRM_LIFECYCLE_INVALID' } = {}) {
    super(message);
    this.name = 'EawFirmLifecycleError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const assertEawFirmLifecycleAllowed = ({
  firmId,
  env = process.env,
  databaseUrl = getFirmDatabaseUrl()
} = {}) => {
  if (typeof firmId !== 'string'
    || !firmId.startsWith(EAW_FIRM_ID_PREFIX)
    || firmId.length <= EAW_FIRM_ID_PREFIX.length) {
    throw new EawFirmLifecycleError(
      `EAW firm lifecycle requires a firm id with the "${EAW_FIRM_ID_PREFIX}" prefix.`,
      { code: 'EAW_FIRM_ID_REQUIRED' }
    );
  }
  // Unreachable while the prefix holds — belt and braces against a future
  // DEFAULT_FIRM_ID someone points at an eaw- id.
  if (firmId === DEMO_FIRM_ID || firmId === DEFAULT_FIRM_ID) {
    throw new EawFirmLifecycleError(
      'EAW firm lifecycle refuses the demo/default firm.',
      { code: 'EAW_FIRM_ID_REQUIRED' }
    );
  }
  if (!databaseUrl) {
    throw new EawFirmLifecycleError(
      'Firm database is not configured.',
      { statusCode: 503, code: 'EAW_DB_UNCONFIGURED' }
    );
  }
  if (!isLocalDatabaseUrl(databaseUrl) && env.DONNA_ALLOW_EAW_FIRM_LIFECYCLE !== 'true') {
    throw new EawFirmLifecycleError(
      'Refusing EAW firm lifecycle against a non-local database. Set DONNA_ALLOW_EAW_FIRM_LIFECYCLE=true only for an intentional, isolated evaluation target.',
      { statusCode: 403, code: 'EAW_FIRM_LIFECYCLE_BLOCKED' }
    );
  }
  return firmId;
};

const assertEawLifecycleActor = (actor) => {
  const type = typeof actor?.type === 'string' ? actor.type.trim() : '';
  const id = typeof actor?.id === 'string' ? actor.id.trim() : '';
  if (!type || !id) {
    throw new EawFirmLifecycleError(
      'EAW firm lifecycle requires a real actor ({ type, id }).',
      { code: 'EAW_ACTOR_REQUIRED' }
    );
  }
  if (id.toLowerCase() === 'system') {
    throw new EawFirmLifecycleError(
      "'system' is not a real actor; name the principal running the evaluation.",
      { code: 'EAW_ACTOR_REQUIRED' }
    );
  }
  return { type, id };
};

const EAW_SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

const eawDeepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(eawDeepFreeze);
  }
  return value;
};

// (table, column) pairs that scope rows to a firm, from the live catalog so
// the residue proof cannot drift as the schema grows: every FK that
// references firms(id) (covers memories.tenant_id), unioned with every
// firm_id column FK'd or not (covers reconciliation_evaluations, the one
// plain firm_id in the schema).
const eawFirmScopedTablePairs = async (client) => {
  const res = await client.query(
    `select kcu.table_name, kcu.column_name
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
       join information_schema.constraint_column_usage ccu
         on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
      where tc.table_schema = 'public' and tc.constraint_type = 'FOREIGN KEY'
        and ccu.table_name = 'firms' and ccu.column_name = 'id'
      union
     select c.table_name, c.column_name
       from information_schema.columns c
       join information_schema.tables t
         on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public' and c.column_name = 'firm_id'
        and t.table_type = 'BASE TABLE'
      order by table_name, column_name`
  );
  return res.rows.filter((row) => EAW_SAFE_IDENT.test(row.table_name) && EAW_SAFE_IDENT.test(row.column_name));
};

// Tables scoped to a client with NO firm-scoping column of their own
// (message_delivery_ledger) — they die via the clients cascade; the residue
// proof still counts them, keyed by the captured client-id list.
const eawClientScopedOnlyTablePairs = async (client) => {
  const res = await client.query(
    `select kcu.table_name, kcu.column_name
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
       join information_schema.constraint_column_usage ccu
         on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
      where tc.table_schema = 'public' and tc.constraint_type = 'FOREIGN KEY'
        and ccu.table_name = 'clients' and ccu.column_name = 'id'
        and not exists (
          select 1 from information_schema.columns c2
           where c2.table_schema = 'public' and c2.table_name = kcu.table_name
             and c2.column_name = 'firm_id')
      order by kcu.table_name`
  );
  return res.rows.filter((row) => EAW_SAFE_IDENT.test(row.table_name) && EAW_SAFE_IDENT.test(row.column_name));
};

// audit_events is retained BY DESIGN (119: append-only, no escape) — it is
// counted separately, never as residue and never swept.
const EAW_RETAINED_TABLES = Object.freeze(['audit_events', 'firms']);

const eawCountScopedRows = async (client, { firmId, clientIds = [] }) => {
  const counts = [];
  for (const { table_name: table, column_name: column } of await eawFirmScopedTablePairs(client)) {
    if (EAW_RETAINED_TABLES.includes(table)) continue;
    const res = await client.query(
      `select count(*)::int as n from "${table}" where "${column}" = $1`,
      [firmId]
    );
    counts.push({ table, column, scope: 'firm', rows: res.rows[0]?.n ?? 0 });
  }
  if (clientIds.length) {
    for (const { table_name: table, column_name: column } of await eawClientScopedOnlyTablePairs(client)) {
      const res = await client.query(
        `select count(*)::int as n from "${table}" where "${column}" = any($1::text[])`,
        [clientIds]
      );
      counts.push({ table, column, scope: 'client', rows: res.rows[0]?.n ?? 0 });
    }
  }
  return counts;
};

const eawRetainedSnapshot = async (client, firmId) => {
  const firmRow = await client.query('select id, metadata from firms where id = $1', [firmId]);
  const auditCount = await client.query(
    'select count(*)::int as n from audit_events where firm_id = $1',
    [firmId]
  );
  return {
    firm_row_present: firmRow.rows.length > 0,
    firm_retired: Boolean(firmRow.rows[0]?.metadata?.eaw_retired_at),
    audit_event_rows: auditCount.rows[0]?.n ?? 0
  };
};

// Read-only residue probe. Before a retirement it is an inventory; after
// one it is the harness's INDEPENDENT cleanup verification (never trust the
// retire's own receipt alone). `residue`/`residue_rows` cover every
// firm-scoped table that must be empty; the retained set (retired firms row
// + audit trail) is reported under `retained` and is by design. No prefix
// guard: counting is safe on any firm id.
export const countFirmResidueInDb = async ({ firmId, clientIds = [], withFirmDbClientFn = withFirmDbClient } = {}) => {
  if (typeof firmId !== 'string' || !firmId.trim()) {
    throw new EawFirmLifecycleError('firmId is required.', { code: 'EAW_FIRM_ID_REQUIRED' });
  }
  return withFirmDbClientFn(async (client) => {
    const tables = await eawCountScopedRows(client, { firmId, clientIds });
    const retained = await eawRetainedSnapshot(client, firmId);
    return eawDeepFreeze({
      version: EAW_FIRM_LIFECYCLE_VERSION,
      firm_id: firmId,
      tables_checked: tables.length,
      residue: tables.filter((entry) => entry.rows > 0),
      residue_rows: tables.reduce((sum, entry) => sum + entry.rows, 0),
      retained
    });
  });
};

export const createFirmInDb = async ({
  firmId,
  name,
  jurisdiction = null,
  currency = null,
  actor,
  member = null,
  withFirmDbClientFn = withFirmDbClient
} = {}) => {
  assertEawFirmLifecycleAllowed({ firmId });
  const principal = assertEawLifecycleActor(actor);
  const firmName = String(name || '').trim();
  if (!firmName) {
    throw new EawFirmLifecycleError('Firm name is required.');
  }
  return withFirmDbClientFn(async (client) => {
    await client.query('begin');
    try {
      // A lifecycle API never adopts an existing firm — no upsert, ever.
      const existing = await client.query('select id from firms where id = $1', [firmId]);
      if (existing.rows.length) {
        throw new EawFirmLifecycleError(
          `Firm "${firmId}" already exists; EAW lifecycle never adopts an existing firm.`,
          { statusCode: 409, code: 'EAW_FIRM_EXISTS' }
        );
      }
      await client.query(
        `insert into firms (id, name, slug, jurisdiction, default_currency, metadata)
         values ($1, $2, $1, $3, $4, $5::jsonb)`,
        [firmId, firmName, jurisdiction, currency,
          JSON.stringify({ created_via: 'eaw_lifecycle', created_by: principal })]
      );
      let isolatedMember = null;
      if (member != null) {
        const memberId = String(member.id || '').trim();
        const memberName = String(member.name || '').trim();
        const memberEmail = String(member.email || '').trim().toLowerCase();
        if (!memberId || !memberName || !memberEmail.endsWith('.invalid')) {
          throw new EawFirmLifecycleError(
            'An EAW member needs id/name and a reserved .invalid email so it can never become a production recipient.',
            { statusCode: 400, code: 'EAW_MEMBER_ISOLATION_REQUIRED' }
          );
        }
        await client.query(
          `insert into firm_members
             (id, firm_id, email, name, role, status, access_level, metadata)
           values ($1, $2, $3, $4, 'admin', 'active', 'owner', $5::jsonb)`,
          [memberId, firmId, memberEmail, memberName, JSON.stringify({
            created_via: 'eaw_lifecycle',
            external_delivery_allowed: false
          })]
        );
        isolatedMember = { id: memberId, email: memberEmail, external_delivery_allowed: false };
      }
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, null, $2, $3, 'firm.eaw_created', 'firm', $1, $4::jsonb)`,
        [firmId, principal.type, principal.id,
          JSON.stringify({ jurisdiction, currency, source: 'eaw_lifecycle' })]
      );
      await client.query('commit');
      return eawDeepFreeze({
        version: EAW_FIRM_LIFECYCLE_VERSION,
        op: 'firm_created',
        firm_id: firmId,
        actor: principal,
        member: isolatedMember,
        audit_action: 'firm.eaw_created'
      });
    } catch (error) {
      try { await client.query('rollback'); } catch { /* surface the original error */ }
      throw error;
    }
  });
};

export const deleteFirmInDb = async ({
  firmId,
  actor,
  withFirmDbClientFn = withFirmDbClient
} = {}) => {
  assertEawFirmLifecycleAllowed({ firmId });
  const principal = assertEawLifecycleActor(actor);
  return withFirmDbClientFn(async (client) => {
    await client.query('begin');
    try {
      const firmRow = await client.query('select id, metadata from firms where id = $1', [firmId]);
      if (!firmRow.rows.length) {
        throw new EawFirmLifecycleError('Firm not found.', { statusCode: 404, code: 'EAW_FIRM_NOT_FOUND' });
      }
      if (firmRow.rows[0].metadata?.created_via !== 'eaw_lifecycle') {
        throw new EawFirmLifecycleError(
          `Firm "${firmId}" was not created by the EAW lifecycle; refusing to delete it.`,
          { statusCode: 403, code: 'EAW_FIRM_NOT_EAW_CREATED' }
        );
      }

      const clientRows = await client.query('select id from clients where firm_id = $1 order by id', [firmId]);
      const clientIds = clientRows.rows.map((row) => row.id);

      // The loud-death rail at firm level: snapshot every client's authority
      // plane BEFORE anything is removed. The receipt rides the return value.
      const authorityPlane = [];
      for (const clientId of clientIds) {
        const snapshot = await snapshotAuthorityPlaneForClient({ client, firmId, clientId });
        authorityPlane.push({ client_id: clientId, ...snapshot });
      }

      // Deliberate retention (119): export the full audit trail into the
      // receipt BEFORE retirement — the trail itself is never deleted.
      const auditTrail = await client.query(
        `select id, firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata, created_at
           from audit_events where firm_id = $1 order by id`,
        [firmId]
      );

      const preCounts = await eawCountScopedRows(client, { firmId, clientIds });

      // The 037/038 sanctioned escape, transaction-local: loop_runs,
      // loop_goal_reports and bookkeeping_case_suspensions forbid DELETE
      // except under this GUC (their recorded purge path). audit_events has
      // no such escape by design and is never touched.
      await client.query(`select set_config('donna.allow_append_only_purge', 'on', true)`);

      // Clients first: their audit rows survive via the sanctioned
      // client_id set-null cascade (119 shape 2).
      await client.query('delete from clients where firm_id = $1', [firmId]);

      // Sweep every remaining firm-scoped row (plain-firm_id tables and
      // anything the client cascade missed). Retained tables are excluded
      // by eawCountScopedRows/EAW_RETAINED_TABLES.
      for (const { table, column, scope } of preCounts) {
        if (scope === 'client') {
          await client.query(`delete from "${table}" where "${column}" = any($1::text[])`, [clientIds]);
        } else {
          await client.query(`delete from "${table}" where "${column}" = $1`, [firmId]);
        }
      }

      // In-transaction residue proof — fail CLOSED: rows left behind roll
      // the whole retirement back rather than leaving a half-torn-down firm.
      const residue = await eawCountScopedRows(client, { firmId, clientIds });
      const residueRows = residue.filter((entry) => entry.rows > 0);
      if (residueRows.length) {
        throw new EawFirmLifecycleError(
          `Firm retirement left residue in: ${residueRows.map((entry) => `${entry.table} (${entry.rows})`).join(', ')}.`,
          { statusCode: 500, code: 'EAW_FIRM_RESIDUE' }
        );
      }

      // Retire the firms row (kept so the audit trail keeps its FK parent)
      // and append the retirement to the surviving trail.
      await client.query(
        `update firms
            set metadata = metadata || jsonb_build_object('eaw_retired_at', now(), 'eaw_retired_by', $2::text),
                updated_at = now()
          where id = $1`,
        [firmId, principal.id]
      );
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, null, $2, $3, 'firm.eaw_retired', 'firm', $1, $4::jsonb)`,
        [firmId, principal.type, principal.id, JSON.stringify({
          client_ids: clientIds,
          rows_deleted: preCounts.reduce((sum, entry) => sum + entry.rows, 0),
          note: 'EAW retirement: bookkeeping state removed; firms row retained as the audit trail FK parent (119).'
        })]
      );

      const retained = await eawRetainedSnapshot(client, firmId);
      await client.query('commit');
      return eawDeepFreeze({
        version: EAW_FIRM_LIFECYCLE_VERSION,
        op: 'firm_retired',
        firm_id: firmId,
        actor: principal,
        client_ids: clientIds,
        authority_plane: authorityPlane,
        audit_trail: auditTrail.rows,
        rows_deleted: preCounts.filter((entry) => entry.rows > 0),
        tables_checked: preCounts.length,
        residue_verified: true,
        retained,
        note: 'Retire, not delete (migration 119): the audit trail and the retired firms row survive by design; this receipt carries the exported trail — re-verify with countFirmResidueInDb (residue_rows must be 0).'
      });
    } catch (error) {
      try { await client.query('rollback'); } catch { /* surface the original error */ }
      throw error;
    }
  });
};

// ─── EAW read-only observer ops (Unit 50 production prerequisite) ────────────
//
// Kari-commissioned 2026-08-20 (same shape as the #1741 lifecycle PR): the
// merged Unit 52 crash-resume harness (`scripts/eval_world_crash_resume.js`)
// refuses to run without two read-only observers on this ops seam
// (`EAW_RESUME_PROBE_INCOMPLETE`). They let a resumed run prove, from
// PERSISTED rows rather than caller attestation, that a crash-and-resume
// created no duplicate journals and left an identical terminal inventory.
//
// Both are pure reads — no writes, no locks, no actor requirement (reads
// carry no mutation to attribute; the mutating lifecycle keeps its guards).
// They read persisted state ONLY (the "render the persisted verdict" rail):
//   - journals: non-voided `ledger_journals` rows (the same liveness filter
//     the ledger period preview uses);
//   - T1: `close_periods` rows whose persisted status is a closed status —
//     the same `close_period_status` signal the harness's terminal
//     projection collapses from `ledger_period.status`;
//   - T2: customer-human asks in the canonical draft/open statuses;
//   - limbo: replied customer-human asks awaiting Donna processing and every
//     agent-audience ask. These semantics delegate to reconcileConvergenceState.
// The COMPUTED projections (`close_preview.lockable`, derived close
// exceptions) are deliberately NOT re-derived here: an observer that
// re-computed them would be a second projection to drift. At the only point
// the harness compares (pre-retirement, period locked, no open items) the
// persisted terminal and the harness projection agree byte-for-byte; in any
// corrupt state they diverge and the resume fails CLOSED
// (`EAW_RESUME_DIVERGED`), never silently passes. A locked period with open
// owner asks refuses here too (`EAW_TERMINAL_CONTRADICTION`) — the same
// contradiction the harness projection refuses.

export const EAW_OBSERVER_OPS_VERSION = 'eaw.observer-ops.v1';

const EAW_OBSERVED_ASK_STATUSES = Object.freeze([
  ...OPEN_OWNER_ASK_STATUSES,
  ...ANSWERED_PROCESSING_ASK_STATUSES
]);

const assertEawObserverFirmId = (firmId) => {
  if (typeof firmId !== 'string' || !firmId.trim()) {
    throw new EawFirmLifecycleError('firmId is required.', { code: 'EAW_FIRM_ID_REQUIRED' });
  }
  return firmId;
};

export const countPersistedJournalsInDb = async ({
  firmId,
  clientId = null,
  withFirmDbClientFn = withFirmDbClient
} = {}) => {
  assertEawObserverFirmId(firmId);
  return withFirmDbClientFn(async (client) => {
    const params = [firmId];
    let clientClause = '';
    if (clientId) {
      params.push(clientId);
      clientClause = 'and client_id = $2';
    }
    const result = await client.query(
      `select count(*)::int as count
       from ledger_journals
       where firm_id = $1
         ${clientClause}
         and status <> 'voided'`,
      params
    );
    return eawDeepFreeze({
      version: EAW_OBSERVER_OPS_VERSION,
      firm_id: firmId,
      client_id: clientId || null,
      count: result.rows[0]?.count ?? 0
    });
  });
};

export const readTerminalInventoryInDb = async ({
  firmId,
  clientId = null,
  withFirmDbClientFn = withFirmDbClient
} = {}) => {
  assertEawObserverFirmId(firmId);
  return withFirmDbClientFn(async (client) => {
    const params = [firmId];
    let clientClause = '';
    if (clientId) {
      params.push(clientId);
      clientClause = 'and client_id = $2';
    }
    const journalsResult = await client.query(
      `select id
       from ledger_journals
       where firm_id = $1
         ${clientClause}
         and status <> 'voided'
       order by journal_date, created_at, id`,
      params
    );
    const periodsResult = await client.query(
      `select id, client_id, period_start, period_end, status
       from close_periods
       where firm_id = $1
         ${clientClause}
       order by client_id, period_start`,
      params
    );
    const asksResult = await client.query(
      `select id, client_id, status, audience
       from client_evidence_requests
       where firm_id = $1
         ${clientClause}
         and status = any($${params.length + 1}::text[])
       order by updated_at desc`,
      [...params, [...EAW_OBSERVED_ASK_STATUSES]]
    );

    const journalIds = journalsResult.rows.map((row) => row.id);
    // Key insertion order below mirrors the harness projection exactly —
    // the resume probe compares JSON.stringify(terminal), so shape IS
    // contract: { t1, locked, t2, limbo }, t1 entries { source, status },
    // t2 entries { source, id, responsible_actor }.
    const t1 = periodsResult.rows
      .filter((row) => CLOSED_PERIOD_STATUSES.has(row.status))
      .map((row) => ({ source: 'close_period_status', status: row.status }));
    const locked = t1.length > 0;
    const openCustomerHumanAsks = asksResult.rows.filter((row) =>
      hasOpenOwnerAskInRequests([row]) || hasOpenSeatAskInRequests([row]));
    const answeredCustomerHumanAsks = asksResult.rows.filter((row) =>
      hasAnsweredOwnerAskInRequests([row]) || hasAnsweredSeatAskInRequests([row]));
    const agentAsks = asksResult.rows.filter((row) => hasOpenAgentAskInRequests([row]));
    const t2 = openCustomerHumanAsks.map((row) => ({
      source: 'getClientEvidenceRequestsFromDb',
      id: row.id,
      responsible_actor: (row.audience || 'client') === 'client'
        ? 'owner' : 'seat'
    }));
    const owedWork = [
      ...answeredCustomerHumanAsks.map((row) => ({ source: 'getClientEvidenceRequestsFromDb', id: row.id, reason: 'answered_customer_ask_awaiting_processing' })),
      ...agentAsks.map((row) => ({ source: 'getClientEvidenceRequestsFromDb', id: row.id, reason: 'agent_ask_unanswered' })),
    ];
    if (locked && (t2.length || owedWork.length)) {
      throw new EawFirmLifecycleError(
        'Persisted projections disagree: a locked/closed period coexists with customer-human or agent ask work.',
        { statusCode: 409, code: 'EAW_TERMINAL_CONTRADICTION' }
      );
    }
    const limbo = owedWork.length
      ? owedWork
      : locked || t2.length ? [] : [{ reason: 'no exclusive production terminal projection' }];
    return eawDeepFreeze({
      version: EAW_OBSERVER_OPS_VERSION,
      firm_id: firmId,
      client_id: clientId || null,
      counts: { journals: journalIds.length, t1: t1.length, t2: t2.length, limbo: limbo.length },
      journal_ids: journalIds,
      terminal: { t1, locked, t2, limbo },
      limbo
    });
  });
};

// The NAMED complete production-composition boundary for the EAW DB-close
// harness (Unit 39). The harness binds THESE named operations and nothing
// else — no direct SQL, no migrations, no eval-owned writer. Completeness is
// machine-checked: eawFirmLifecycle.test.js asserts every name is a real
// export of this module, so the manifest cannot drift from the surface.
// v2 (2026-08-20): + the `observers` group — the two read-only Unit 50/52
// crash-resume probes. Receipts recorded under v1 predate them.
export const EAW_CLOSE_COMPOSITION_BOUNDARY = Object.freeze({
  version: 'eaw.close-composition-boundary.v2',
  lifecycle: Object.freeze([
    'createFirmInDb', 'deleteFirmInDb', 'countFirmResidueInDb',
    'createClientInDb', 'deleteClientInDb'
  ]),
  data: Object.freeze(['syncDocumentsAndTransactionsInDb']),
  evidence: Object.freeze([
    'createClientEvidenceRequestInDb', 'acceptClientEvidenceRequestInDb',
    'rejectClientEvidenceRequestInDb', 'resolveClientEvidenceRequestInDb',
    'getClientEvidenceRequestsFromDb'
  ]),
  close: Object.freeze([
    'getLedgerPeriodPreviewFromDb', 'postLedgerPeriodInDb',
    'lockClosePeriodInDb', 'createCloseArchiveInDb'
  ]),
  readers: Object.freeze([
    'getCloseDiagnosticsFromDb', 'getCloseExceptionsFromDb',
    'getCloseArchiveExportFromDb', 'getFirmSnapshotFromDb',
    'isFirmDatabaseConfigured'
  ]),
  observers: Object.freeze(['countPersistedJournalsInDb', 'readTerminalInventoryInDb'])
});

// Server-stamped provenance on an operator profile write. The operator
// validator (clientProfileSchema) treats these keys as server-owned —
// the FE sends only the *choice* (services_engaged, accounting_system,
// jurisdiction) and the server records who/when from the authenticated
// principal, so the provenance can't be spoofed and all three axes stay
// consistent.
//
//   - services_engaged present → stamp services_engaged_set_by/_at.
//       The validator guarantees the value is an array (possibly empty);
//       explicit [] is the "not scoped yet" state from Phase 1.5 and
//       deserves a stamp too — the operator made a deliberate choice.
//   - accounting_system present → stamp accounting_system_set_by/_at.
//   - jurisdiction present:
//       a real value (incl. 'unknown') is an operator confirmation →
//       stamp jurisdiction_confirmed_by/_at;
//       null clears the choice → clear the confirmation provenance too,
//       so a later detector value never reads as operator-confirmed.
//
// Pure (no DB) and exported for unit tests. `now` is injectable for
// deterministic assertions; `actorId` is the resolved principal id
// (email → userId → principalId) or null.
export const stampProfileProvenance = (patch, { actorId = null, now = new Date() } = {}) => {
  const out = { ...patch };
  const iso = now instanceof Date ? now.toISOString() : new Date(now).toISOString();

  if (Object.prototype.hasOwnProperty.call(patch, 'services_engaged')) {
    out.services_engaged_set_by = actorId;
    out.services_engaged_set_at = iso;
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'accounting_system')) {
    out.accounting_system_set_by = actorId;
    out.accounting_system_set_at = iso;
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'jurisdiction')) {
    if (patch.jurisdiction === null) {
      out.jurisdiction_confirmed_by = null;
      out.jurisdiction_confirmed_at = null;
    } else {
      out.jurisdiction_confirmed_by = actorId;
      out.jurisdiction_confirmed_at = iso;
    }
  }

  return out;
};

// Shallow JSONB merge into clients.profile for a single (firm, client).
// `profilePatch` is an object of top-level keys to overwrite via the
// jsonb `||` operator (right side wins, no deep merge). Used by the
// client portal to persist UI state that lives off the document graph
// (dismissed intake tiles per period; eventually applicable_intake_
// categories from an operator surface).
//
// `actorId` is the authenticated principal id (the route derives it via
// access.principal); it's recorded on the audit_events row and stamped
// into server-owned provenance keys via stampProfileProvenance.
//
// `dbClient` mirrors the escape hatch on updateClientRuleStatusInDb —
// inject a mock for unit tests.
export const updateClientProfileInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  profilePatch,
  actorId = null,
  principal = null,
  dbClient = null,
  manageTransaction = true
} = {}) => {
  if (!manageTransaction && !dbClient) throw Object.assign(new Error('Caller-owned profile updates require dbClient.'), { code: 'PROFILE_TRANSACTION_REQUIRED' });
  if (!clientId) {
    const error = new Error('Client id is required.');
    error.statusCode = 400;
    throw error;
  }
  if (!profilePatch || typeof profilePatch !== 'object' || Array.isArray(profilePatch)) {
    const error = new Error('profile_patch must be a non-null object.');
    error.statusCode = 400;
    throw error;
  }

  const { profilePatchNeedsCountryValidation, PROFILE_VALIDATION_REGISTRY } = await import('../profileValidationRegistry.js');
  const { resolveProfileWriteJurisdiction, normalizeProfileJurisdiction } = await import('../profileValidation.js');
  const hasAccountingPatch = hasAccountingProfilePatch(profilePatch);
  if (hasAccountingPatch && (!actorId || actorId === 'system')) {
    throw new AccountingProfileError('ACCOUNTING_PROFILE_ACTOR_REQUIRED', 'An authenticated owner or member must record the accounting choice.');
  }
  const hasCountryFacts = profilePatchNeedsCountryValidation(profilePatch);
  const hasRegistrationPatch = Object.prototype.hasOwnProperty.call(profilePatch, 'gst_registration');
  const hasJurisdictionPatch = Object.prototype.hasOwnProperty.call(profilePatch, 'jurisdiction');
  const hasAccountingSystemPatch = typeof profilePatch.accounting_system === 'string' && Boolean(profilePatch.accounting_system.trim());

  // BF-2 compatibility path: a legacy free-form legal form is corrected
  // against the client's persisted jurisdiction. The owner card supplies a
  // canonical suggestion for known aliases; unsupported rows remain visible
  // with the same bounded options. Read before validation so an alias such as
  // "Limited company" is never interpreted without its country.
  let legalFormJurisdiction = profilePatch.jurisdiction || null;
  if (
    hasCountryFacts || hasRegistrationPatch || (
      typeof profilePatch.entity_type === 'string'
      && profilePatch.entity_type.trim()
      && !legalFormJurisdiction
    )
  ) {
    const jurisdictionRow = dbClient
      ? await dbClient.query(
          'select jurisdiction, profile from clients where firm_id = $1 and id = $2',
          [firmId, clientId]
        )
      : await queryFirmDb(
          'select jurisdiction, profile from clients where firm_id = $1 and id = $2',
          [firmId, clientId]
        );
    const stored = jurisdictionRow.rows[0] || null;
    legalFormJurisdiction = resolveProfileWriteJurisdiction({ patch: profilePatch, stored });
  }

  // Known-keys validator: enum-checks services_engaged ids, normalises
  // uk → gb on jurisdiction, rejects writes to server-owned keys
  // (jurisdiction_detected, accounting_system_connection, …). Unknown
  // keys are preserved forward-compat. See
  // docs/jurisdiction-services-accounting-plan.md.
  const { validateAndNormaliseProfilePatch } = await import('../clientProfileSchema.js');
  let nativeLineage = hasRegistrationPatch ? await readNativeChartLineage({
    query: dbClient ? dbClient.query.bind(dbClient) : queryFirmDb, firmId, clientId
  }) : null;
  const { patch: normalisedPatch, warnings } = validateAndNormaliseProfilePatch(
    profilePatch,
    { jurisdiction: legalFormJurisdiction, nativeLineage }
  );
  if (warnings.length) {
    for (const warning of warnings) console.warn('[updateClientProfileInDb]', warning);
  }

  // Server-stamp provenance (who/when) onto the validated patch. No-op
  // unless the patch touches a provenance-bearing choice.
  let stampedPatch = stampProfileProvenance(
    Object.prototype.hasOwnProperty.call(normalisedPatch, 'entity_type')
      ? { ...normalisedPatch, entityType: normalisedPatch.entity_type }
      : normalisedPatch,
    { actorId }
  );

  const run = async (client) => {
    // A factual reply co-commits profile, question and processing receipt.
    // SAVEPOINT refuses accidental autocommit and preserves caller ownership.
    await client.query(manageTransaction ? 'begin' : 'savepoint client_profile_update');
    try {
      const { preserved: preservedIntakeKeys, firstFill: fiIntakeFirstFill } = await assertFinnishProfileIntakeMutableWithClient(client, { firmId, clientId, patch: normalisedPatch });
      let accountingProfileReceipt = null;
      let nativeRegistrationReceipt = null;
      let countryFactsInvalidated = null;
      let jurisdictionChanged = false;
      if (hasAccountingPatch || hasCountryFacts || hasRegistrationPatch || hasJurisdictionPatch || hasAccountingSystemPatch || (typeof profilePatch.entity_type === 'string' && profilePatch.entity_type.trim())) {
        // Re-resolve the actual persisted homes under the write lock. A country
        // correction between initial validation and commit must not mint facts
        // normalized under the earlier country's rules.
        const current = await client.query(
          'select jurisdiction, profile from clients where firm_id = $1 and id = $2 for update',
          [firmId, clientId]
        );
        if (!current.rows.length) {
          const error = new Error('Client not found.');
          error.statusCode = 404;
          throw error;
        }
        const jurisdiction = resolveProfileWriteJurisdiction({ patch: profilePatch, stored: current.rows[0] });
        if (hasRegistrationPatch) nativeLineage = await readNativeChartLineage({
          query: client.query.bind(client), firmId, clientId, lock: true
        });
        if (hasAccountingSystemPatch) {
          // Platform selection records a setup preference, not a country or
          // chart. An unknown market remains undecidable; an identified market
          // must offer the platform, checked against the same locked identity.
          const availability = accountingSystemAvailability({
            jurisdiction: normalizeJurisdictionKey(jurisdiction),
            accountingSystem: stampedPatch.accounting_system
          });
          if (availability.verdict === 'not_offered') {
            const error = new Error(
              `accounting_system '${stampedPatch.accounting_system}' is not offered for jurisdiction '${jurisdiction}' `
              + `(pack '${availability.packId}' declares ${availability.platforms.join(', ')}). `
              + 'Pick a declared platform, or add it to the pack if the market really supports it.'
            );
            error.statusCode = 400;
            throw error;
          }
        }
        const { patch } = validateAndNormaliseProfilePatch(profilePatch, { jurisdiction, nativeLineage });
        stampedPatch = stampProfileProvenance(
          Object.prototype.hasOwnProperty.call(patch, 'entity_type')
            ? { ...patch, entityType: patch.entity_type }
            : patch,
          { actorId }
        );
        if (hasAccountingPatch) {
          stampedPatch = normalizeAccountingProfilePatch(stampedPatch, current.rows[0].profile || {});
          accountingProfileReceipt = {
            before: readAccountingProfile(current.rows[0].profile),
            after: readAccountingProfile({ ...current.rows[0].profile, ...stampedPatch }),
            authority_basis: { source: 'authenticated_profile_update', principal_id: actorId }
          };
        }
        if (hasJurisdictionPatch) {
          const stored = current.rows[0];
          const previousCountries = [...new Set([
            normalizeProfileJurisdiction(stored.jurisdiction),
            normalizeProfileJurisdiction(stored.profile?.jurisdiction)
          ].filter(Boolean))];
          const destination = normalizeProfileJurisdiction(stampedPatch.jurisdiction);
          // Tax facts belong to the jurisdiction under which they were captured.
          // A setup correction must never reinterpret retained shared-key facts
          // under the destination country. Keep the old values on the audit, and
          // let the existing fact collectors obtain fresh destination facts.
          jurisdictionChanged = previousCountries.length !== 1 || previousCountries[0] !== destination;
          if (jurisdictionChanged) {
            const previousValues = {};
            for (const key of PROFILE_VALIDATION_REGISTRY.fields) {
              if (stored.profile?.[key] != null) {
                previousValues[key] = stored.profile[key];
                if (!Object.prototype.hasOwnProperty.call(stampedPatch, key)) stampedPatch[key] = null;
              }
            }
            if (Object.keys(previousValues).length) {
              countryFactsInvalidated = {
                reason: 'jurisdiction_changed',
                previous_identity: { jurisdiction: stored.jurisdiction, profile_jurisdiction: stored.profile?.jurisdiction ?? null },
                jurisdiction: destination || null,
                previous_values: previousValues
              };
            }
          }
        }
        const registrationPolicy = nativeRegistrationPolicyForLineage(nativeLineage);
        if (registrationPolicy && hasRegistrationPatch) {
          const denied = reason => { throw Object.assign(new Error(`Native registration update refused: ${reason}`), {
            code: 'NATIVE_REGISTRATION_AUTHORITY_REQUIRED', statusCode: 403, details: { reason }
          }); };
          if (!principal?.principalId || actorId !== principal.principalId
            || !['firm_member', 'firm_collaborator'].includes(principal.principalType)) denied('authenticated_principal_required');
          const actor = principal.principalType === 'firm_member'
            ? (await client.query("select id,user_id,email,role,access_level from firm_members where firm_id=$1 and id=$2 and status='active' for share nowait", [firmId, actorId])).rows[0]
            : (await client.query(`select id,user_id,email,role,access_level from firm_collaborators where firm_id=$1 and id=$2 and status='active'
              and (starts_at is null or starts_at<=clock_timestamp()) and (ends_at is null or ends_at>clock_timestamp()) for share nowait`, [firmId, actorId])).rows[0];
          const desktop = principal.authenticatedVia === 'desktop_access_token';
          if (!actor || (!desktop && (!principal.userId || actor.user_id !== principal.userId))
            || ['viewer', 'read_only'].includes(actor.role) || ['viewer', 'read_only'].includes(actor.access_level)) denied('current_principal_required');
          if (principal.principalType === 'firm_collaborator') {
            const assignment = (await client.query(`select id from client_assignments where firm_id=$1 and client_id=$2
              and principal_type='firm_collaborator' and principal_id=$3 and assignment_kind='capability' and role='owner'
              and status='active' and access_level='client_scoped'
              and (starts_at is null or starts_at<=clock_timestamp()) and (ends_at is null or ends_at>clock_timestamp()) for share nowait`,
            [firmId, clientId, actorId])).rows[0];
            if (!assignment) denied('current_owner_assignment_required');
          }
          const previous = await readNativeRegistrationEvidence({ query: client.query.bind(client), firmId, clientId,
            lineage: nativeLineage, profile: current.rows[0].profile, lock: true, forAppend: true });
          const after = stampedPatch[registrationPolicy.field];
          const sourceDocument = after?.source_document_id ? (await client.query(
            'select * from documents where firm_id=$1 and client_id=$2 and id=$3 for share nowait',
            [firmId, clientId, after.source_document_id])).rows[0] : null;
          if (after?.source_document_id && !sourceDocument) denied('source_document_not_in_client');
          nativeRegistrationReceipt = registrationPolicy.createRevision({ before: current.rows[0].profile?.[registrationPolicy.field], after,
            clientLife: nativeLineage.client_life,
            predecessorDigest: previous.revision?.revision_digest || nativeLineage.receipt.metadata.registration_digest,
            actor: { id: actorId, type: principal.principalType }, sourceDocument });
          stampedPatch[registrationPolicy.revisionField] = nativeRegistrationReceipt;
        }
      }
      // profile.gb is DEEP-merged, not replaced: it is SHARED state — the owner
      // filing-details card writes vat_stagger / period-end facts while the GB
      // close engine reads (and will write) completion_evidence under the same
      // key. The top-level `||` is shallow, so without the deep branch a partial
      // patch like { gb: { vat_stagger: null } } would wipe the sibling facts
      // and completion_evidence wholesale. $4 selects the deep branch only when
      // THIS patch carries a gb OBJECT; `gb: null` still clears the whole key
      // through the shallow branch (the validator's null-clears contract).
      for (const key of preservedIntakeKeys) delete stampedPatch[key];
      const deepMergeGb = !jurisdictionChanged && Boolean(stampedPatch.gb) && typeof stampedPatch.gb === 'object' && !Array.isArray(stampedPatch.gb);
      const updated = await client.query(
        `update clients
            set profile = case when $4::boolean
                  then jsonb_set(coalesce(profile, '{}'::jsonb) || $3::jsonb, '{gb}', coalesce(profile->'gb', '{}'::jsonb) || ($3::jsonb->'gb'))
                  else coalesce(profile, '{}'::jsonb) || $3::jsonb
                end,
                updated_at = now()
          where firm_id = $1 and id = $2
        returning id`,
        [firmId, clientId, JSON.stringify(stampedPatch), deepMergeGb]
      );

      if (!updated.rows.length) {
        const error = new Error('Client not found.');
        error.statusCode = 404;
        throw error;
      }

      // Keep the load-bearing COLUMN in sync: the extractor date hint
      // reads clients.jurisdiction (getClientJurisdictionInDb), not the
      // profile blob — without this, a jurisdiction fix in the profile
      // view never reaches the pipeline.
      if (Object.prototype.hasOwnProperty.call(stampedPatch, 'jurisdiction')) {
        // Clearing/unknown must clear both homes, or a later country-owned
        // fact would silently recover the jurisdiction the owner removed.
        const canonicalJurisdiction = typeof stampedPatch.jurisdiction === 'string'
          && /^[A-Za-z]{2}$/.test(stampedPatch.jurisdiction.trim())
          ? stampedPatch.jurisdiction.trim().toUpperCase() : null;
        await client.query(
          `update clients
              set jurisdiction = $3,
                  updated_at = now()
            where firm_id = $1 and id = $2`,
          [firmId, clientId, canonicalJurisdiction]
        );
      }

      // Same column-sync for an in-portal rename: the display name resolves
      // `profile.companyName || company_name`, but the firm-facing
      // display_name reader (knownPrincipalsForClient and the clients list)
      // uses the raw company_name column with no profile fallback. Mirror the
      // validated, non-empty value so a portal rename reaches the firm side
      // too. The schema validator already trimmed and rejected empties.
      if (typeof stampedPatch.companyName === 'string' && stampedPatch.companyName.trim()) {
        await client.query(
          `update clients
              set company_name = $3,
                  updated_at = now()
            where firm_id = $1 and id = $2`,
          [firmId, clientId, stampedPatch.companyName.trim()]
        );
      }

      // Same column-sync for the legal form and incorporation date:
      // resolveClientFiscalYearTx and its call sites read the entity_type /
      // incorporation_date COLUMNS (and gb/entity.js raw() checks the column
      // FIRST), so a profile-only write would pass an entity gate that reads
      // both homes and then resolve fiscal years as if the form were unknown.
      // hasOwnProperty rather than truthiness: an explicit null must CLEAR the
      // column too, or the stale column value keeps winning on every reader.
      // The schema validator already canonicalized (gb-*) or refused upstream.
      if (Object.prototype.hasOwnProperty.call(stampedPatch, 'entity_type')) {
        await client.query(
          `update clients
              set entity_type = $3,
                  updated_at = now()
            where firm_id = $1 and id = $2`,
          [firmId, clientId, stampedPatch.entity_type]
        );
      }
      if (Object.prototype.hasOwnProperty.call(stampedPatch, 'incorporation_date')) {
        await client.query(
          `update clients
              set incorporation_date = $3,
                  updated_at = now()
            where firm_id = $1 and id = $2`,
          [firmId, clientId, stampedPatch.incorporation_date]
        );
      }

      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, $5, $3, 'client.profile.update', 'client', $2, $4::jsonb)`,
        [firmId, clientId, actorId, JSON.stringify({ keys: Object.keys(stampedPatch), ...(nativeRegistrationReceipt ? { native_registration: nativeRegistrationReceipt } : {}), ...(countryFactsInvalidated ? { country_facts_invalidated: countryFactsInvalidated } : {}), ...(accountingProfileReceipt ? { accounting_profile: accountingProfileReceipt } : {}), ...(fiIntakeFirstFill ? { fi_intake_first_fill: fiIntakeFirstFill } : {}) }), nativeRegistrationReceipt?.actor_type || 'system']
      );

      await client.query(manageTransaction ? 'commit' : 'release savepoint client_profile_update');
      return { client_id: clientId, keys: Object.keys(stampedPatch) };
    } catch (error) {
      await client.query(manageTransaction ? 'rollback' : 'rollback to savepoint client_profile_update');
      if (!manageTransaction) await client.query('release savepoint client_profile_update');
      throw error;
    }
  };

  if (dbClient) {
    const summary = await run(dbClient);
    return { ...summary, snapshot: null };
  }
  const summary = await withFirmDbClient(run);
  const snapshot = await getFirmSnapshotFromDb({ firmId });
  return { ...summary, snapshot };
};

// Slice 4 (autonomous-loop demo) — the firm-level autonomy settings writer. Today it
// governs ONE setting: `auto_send_client_asks`, the standing human authorization that
// lets Donna deliver a drafted client question on its own (Slice 1's `human_authorized`
// criterion; loopExecutionGate.FRIENDLY_AUTHORIZATION_FLAGS). It writes
// firms.metadata.loops.auto_send_client_asks WITHOUT clobbering the sibling loops keys
// (tier, suspended, authorizations) — the jsonb merge preserves them.
//
// GOVERNANCE: changing autonomy is an authority act (loopExecutionPolicy.isAuthority /
// AUTHORITY_ACTOR_TYPES). An owner/client may supply evidence but may never govern
// autonomy, so the writer REFUSES a non-authority actorType (defense-in-depth behind the
// endpoint's requireMember gate) and AUDITS the before/after to audit_events.
export const updateFirmLoopSettingsInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  autoSendClientAsks,
  actorId = null,
  actorType = 'firm_operator',
  dbClient = null
} = {}) => {
  if (typeof autoSendClientAsks !== 'boolean') {
    const error = new Error('auto_send_client_asks must be a boolean.');
    error.statusCode = 400;
    error.code = 'FIRM_LOOP_SETTING_INVALID';
    throw error;
  }
  if (!isAuthority(actorType)) {
    const error = new Error(`${actorType || 'an owner'} may not change autonomy settings — authority required.`);
    error.statusCode = 403;
    error.code = 'FIRM_LOOP_SETTING_FORBIDDEN';
    throw error;
  }

  const patch = { auto_send_client_asks: autoSendClientAsks };

  const run = async (client) => {
    await client.query('begin');
    try {
      // Read the prior value for the audit before/after (and to 404 a missing firm).
      const prior = await client.query(
        `select metadata->'loops'->>'auto_send_client_asks' as v from firms where id = $1`,
        [firmId]
      );
      if (!prior.rows.length) {
        const error = new Error('Firm not found.');
        error.statusCode = 404;
        throw error;
      }
      const before = prior.rows[0].v == null ? null : prior.rows[0].v === 'true';

      // Merge INTO the loops object (preserve tier / suspended / authorizations). The
      // jsonb_set with create_missing handles an absent metadata.loops.
      const updated = await client.query(
        `update firms
            set metadata = jsonb_set(
                  coalesce(metadata, '{}'::jsonb),
                  '{loops}',
                  coalesce(metadata->'loops', '{}'::jsonb) || $2::jsonb,
                  true),
                updated_at = now()
          where id = $1
        returning metadata`,
        [firmId, JSON.stringify(patch)]
      );

      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, null, $2, $3, 'loops.auto_send.update', 'firm', $1, $4::jsonb)`,
        [firmId, actorType, actorId, JSON.stringify({ setting: 'auto_send_client_asks', before, after: autoSendClientAsks })]
      );

      await client.query('commit');
      return { firm_id: firmId, loops: updated.rows[0]?.metadata?.loops || {} };
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  };

  if (dbClient) {
    const summary = await run(dbClient);
    return { ...summary, snapshot: null };
  }
  const summary = await withFirmDbClient(run);
  const snapshot = await getFirmSnapshotFromDb({ firmId });
  return { ...summary, snapshot };
};

// Max signals retained on clients.profile.jurisdiction_signals — keeps
// the audit trail bounded so the jsonb blob doesn't grow unbounded
// across many parses. Plan calls for ~20.
const JURISDICTION_SIGNAL_RING_SIZE = 20;

const CONFIDENCE_ORDER = { conflicted: 0, low: 1, medium: 2, high: 3 };

// Server-side recorder for a jurisdiction-detector inference. Bypasses
// the operator-facing validator (the detector writes server-owned
// keys: jurisdiction_detected, jurisdiction_signals, …) and applies
// the conflict + never-bump-down rules from the plan:
//
//   - Always append the signal to the jurisdiction_signals ring
//     buffer (capped at JURISDICTION_SIGNAL_RING_SIZE).
//   - Update jurisdiction_detected only when the new confidence is
//     >= the previously-stored confidence. Never bump down.
//   - When confidence is 'conflicted', preserve the existing
//     jurisdiction_detected value but still flip the
//     jurisdiction_detected_confidence to 'conflicted' so the UI can
//     surface the disagreement.
//   - Never touch `jurisdiction` (the authoritative operator-set
//     field).
//
// `signal` shape:
//   { source: 'bank_statement', jurisdiction: 'sg', confidence: 'high',
//     evidence: 'DBS Bank Singapore · SGD', document_id: '…' (optional) }
//
// dbClient escape hatch mirrors updateClientProfileInDb — inject a
// mock for unit tests.
export const recordJurisdictionSignalInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  signal,
  dbClient = null
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required.');
    error.statusCode = 400;
    throw error;
  }
  if (!signal || typeof signal !== 'object') {
    const error = new Error('signal must be an object.');
    error.statusCode = 400;
    throw error;
  }
  if (!signal.source || typeof signal.source !== 'string') {
    const error = new Error('signal.source is required.');
    error.statusCode = 400;
    throw error;
  }
  if (!signal.confidence || !(signal.confidence in CONFIDENCE_ORDER)) {
    const error = new Error('signal.confidence must be high|medium|low|conflicted.');
    error.statusCode = 400;
    throw error;
  }
  if (signal.confidence !== 'conflicted' && !signal.jurisdiction) {
    const error = new Error('signal.jurisdiction is required unless confidence is conflicted.');
    error.statusCode = 400;
    throw error;
  }

  const entry = {
    source: signal.source,
    jurisdiction: signal.jurisdiction || null,
    confidence: signal.confidence,
    evidence: typeof signal.evidence === 'string' ? signal.evidence : null,
    document_id: signal.document_id || null,
    at: new Date().toISOString()
  };

  const run = async (client) => {
    await client.query('begin');
    try {
      const current = await client.query(
        `select profile from clients where firm_id = $1 and id = $2 for update`,
        [firmId, clientId]
      );
      if (!current.rows.length) {
        const error = new Error('Client not found.');
        error.statusCode = 404;
        throw error;
      }
      const profile = current.rows[0].profile || {};
      const existingSignals = Array.isArray(profile.jurisdiction_signals)
        ? profile.jurisdiction_signals
        : [];
      const nextSignals = [...existingSignals, entry].slice(-JURISDICTION_SIGNAL_RING_SIZE);

      const existingDetected = profile.jurisdiction_detected || null;
      const existingConfidence = profile.jurisdiction_detected_confidence || null;

      // Idempotency guard for Inngest retries. The parse success handler
      // (the Phase 2b.1 caller) can re-run — Inngest backs off and
      // re-claims — re-invoking this recorder with the SAME document.
      // Appending a duplicate would pollute the bounded ring buffer,
      // evicting distinct older signals, and emit a redundant audit
      // event. When the most-recent signal already carries this
      // document_id with the same jurisdiction + confidence, treat the
      // call as a no-op replay: release the lock and return the current
      // state untouched. Signals without a document_id (e.g. manual REPL
      // writes) are never deduped.
      const lastSignal = existingSignals[existingSignals.length - 1] || null;
      if (
        entry.document_id &&
        lastSignal &&
        lastSignal.document_id === entry.document_id &&
        lastSignal.jurisdiction === entry.jurisdiction &&
        lastSignal.confidence === entry.confidence
      ) {
        await client.query('rollback');
        return {
          client_id: clientId,
          jurisdiction_detected: existingDetected,
          jurisdiction_detected_confidence: existingConfidence,
          signals_kept: existingSignals.length,
          skipped: 'duplicate_signal'
        };
      }

      // Apply the never-bump-down rule: only overwrite
      // jurisdiction_detected when the new confidence outranks the old.
      // Conflicted is a special case — leave the value, flip the
      // confidence marker so the UI shows the disagreement banner.
      let nextDetected = existingDetected;
      let nextConfidence = existingConfidence;

      if (entry.confidence === 'conflicted') {
        nextConfidence = 'conflicted';
      } else {
        const newRank = CONFIDENCE_ORDER[entry.confidence];
        const oldRank = existingConfidence ? CONFIDENCE_ORDER[existingConfidence] : -1;
        if (newRank >= oldRank) {
          nextDetected = entry.jurisdiction;
          nextConfidence = entry.confidence;
        }
      }

      const patch = {
        jurisdiction_signals: nextSignals,
        jurisdiction_detected: nextDetected,
        jurisdiction_detected_confidence: nextConfidence
      };

      await client.query(
        `update clients
            set profile = coalesce(profile, '{}'::jsonb) || $3::jsonb,
                updated_at = now()
          where firm_id = $1 and id = $2`,
        [firmId, clientId, JSON.stringify(patch)]
      );

      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', 'jurisdiction.detected', 'client', $2, $3::jsonb)`,
        [
          firmId,
          clientId,
          JSON.stringify({
            source: entry.source,
            jurisdiction: entry.jurisdiction,
            confidence: entry.confidence,
            promoted: nextDetected === entry.jurisdiction && nextConfidence === entry.confidence
          })
        ]
      );

      await client.query('commit');
      return {
        client_id: clientId,
        jurisdiction_detected: nextDetected,
        jurisdiction_detected_confidence: nextConfidence,
        signals_kept: nextSignals.length
      };
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  };

  if (dbClient) return run(dbClient);
  return withFirmDbClient(run);
};

export const clientAccountingBasisFromProfile = (row) => {
  const method = readAccountingProfile(row?.profile || (Object.prototype.hasOwnProperty.call(row || {}, 'accounting_basis') ? { accounting_basis: row.accounting_basis } : {})).method;
  if (method.status === 'unknown' || method.status === 'conflicting') {
    throw new AccountingProfileError('ACCOUNTING_METHOD_UNRESOLVED', 'Record a consistent cash or accrual method in the client profile before continuing.');
  }
  return method.value || 'accrual';
};

export const requireClientInFirm = async ({ client, firmId, clientId }) => {
  const result = await client.query('select id from clients where firm_id = $1 and id = $2 and status <> $3', [
    firmId,
    clientId,
    'deleted'
  ]);
  if (!result.rows.length) {
    const error = new Error('Client not found for Xero connection.');
    error.statusCode = 404;
    throw error;
  }
};

export { DEFAULT_FIRM_ID, DEMO_FIRM_ID };

// Display name for owner-channel receipts ("saved for <client>"). A binding can
// point at a different client than the owner assumes (the 2026-07-20 honeybee
// misbinding: two live incarnations, the Telegram link minted against the old
// one) — naming the destination in the ack is what makes that visible.
export const getClientDisplayNameInDb = async ({ firmId = DEFAULT_FIRM_ID, clientId } = {}) => {
  if (!clientId) return null;
  return withFirmDbClient(async (client) => {
    const result = await client.query(
      'select company_name from clients where firm_id = $1 and id = $2 limit 1',
      [firmId, clientId]
    );
    return result.rows[0]?.company_name || null;
  });
};
