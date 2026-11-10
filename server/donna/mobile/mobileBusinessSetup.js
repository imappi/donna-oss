// The phone app's business register (Settings → Business → Register):
// GET/POST /entities/{entityId}/business-setup. Lookup in the Finnish register
// (POST …/business-setup/lookup) stays 501 on this server; see GAPS.md.
//
// THE ADAPTER RULE holds here too: nothing in this module writes a table.
// Every change is one `profile_patch` through the existing firm route
// POST /clients/:id/profile (mobileDispatch.js), so it passes the route's
// assertFirmAccess + assertClientEntitled and is committed by the existing
// writer (db/clients.js updateClientProfileInDb), which validates the keys,
// applies the Finnish pilot-intake lock (finland/profileIntake.js: a recorded
// businessId is read-only once pilot preparation bound it) and writes its
// `client.profile.update` audit row in the same transaction. That audit row is
// the receipt.
//
// Where the registered identity lives (the homes Donna's readers already use):
//   profile.businessId        the Y-tunnus. Read by the Finnish invoice seller
//                             context (finland/invoiceIssuance.js) and the
//                             owner-invoice seller context; a Finnish
//                             pilot-intake key.
//   profile.legalName         the registered legal name — the key
//                             deriveClientIdentityColumns (db/clients.js)
//                             already reads as the legal name.
//   company_name / companyName the owner-edited business name (another
//                             surface owns it). Written here ONLY when it is
//                             empty, with the legal name: the invoice seller
//                             name reads company_name first.
//   profile.business_register what was confirmed, by whom and from which
//                             source (legal form, form code, registered
//                             address, fetched_at). Never entity_type: the
//                             legal-form COLUMN is the statutory axis the
//                             Finnish tax modules branch on, and this surface
//                             must not change tax or filing behaviour.
//   profile.business_setup    the owner's setup answers (business stage,
//                             whether they put the suggestion off).
//
// The replacement rule (the contract's 409) is checked under a per-entity
// advisory lock held across the read and the dispatched write, so two phones
// confirming different Business IDs cannot both pass the check. A web edit by
// the firm is not serialized with it; the firm may correct a Business ID, the
// owner's phone may not replace one.
import { resolveClientLifecycle } from '../clientLifecycleRegistry.js';
import { queryFirmDb, withFirmDbClient } from '../firmDb.js';
import { mobileError } from './mobileAuth.js';
import { projectEntity, projectReceipt } from './mobileProjection.js';
import { readAuditRowsSince, readAuditWatermark } from './mobileReads.js';

export const LEGAL_FORMS = Object.freeze(['sole_trader', 'limited_company', 'other']);
export const BUSINESS_STAGES = Object.freeze(['new', 'existing']);
export const SETUP_ACTION_TYPES = Object.freeze(['confirm_registry', 'confirm_manual', 'set_stage', 'defer']);
// Fixed by the contract: these are enums of one value each, not verdicts.
export const SETUP_CAPABILITIES = Object.freeze({
  receipt_capture: 'available', tax_preparation: 'not_configured', external_actions: 'not_authorized'
});

const badRequest = (message, code = 'BAD_REQUEST') => mobileError(400, code, message);
const str = (value) => (typeof value === 'string' ? value.trim() : '');
const iso = (value) => {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
};
const plainObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

// The entity's country owns its business register identifier (format and
// check digit). It is reached through the client lifecycle composition root,
// never imported from a country directory: a country that registers no
// `registryIdentifier` has no register this surface can confirm against.
// Today that is Finland only (finland/businessId.js, the Y-tunnus).
export const registryIdentifierFor = (country) => {
  const canonical = resolveClientLifecycle(country)?.registryIdentifier?.canonical;
  return typeof canonical === 'function' ? canonical : null;
};

// The Business ID already associated with this entity, in canonical form when
// it is one (a stored value its country does not recognise is still
// associated: it is compared raw, so it still blocks a replacement).
const associatedBusinessId = (stored, country) => {
  const raw = str(stored);
  if (!raw) return null;
  return registryIdentifierFor(country)?.(raw) || raw;
};

// ── Read ──────────────────────────────────────────────────────────────────

const STATE_SQL = `select c.id, c.company_name, c.entity_type, c.jurisdiction,
       c.profile->>'defaultCurrency' as profile_currency,
       c.profile->>'businessId' as business_id,
       c.profile->>'legalName' as legal_name,
       c.profile->'business_register' as business_register,
       c.profile->'business_setup' as business_setup,
       f.jurisdiction as firm_jurisdiction, f.default_currency as firm_currency,
       exists (select 1 from documents d where d.firm_id = c.firm_id and d.client_id = c.id) as has_documents
  from clients c join firms f on f.id = c.firm_id
 where c.firm_id = $1 and c.id = $2`;

export const readBusinessSetupState = async ({ firmId, clientId, query = queryFirmDb }) => {
  const result = await query(STATE_SQL, [firmId, clientId]);
  if (!result.rows[0]) throw mobileError(404, 'NOT_FOUND', 'No such business in this account.');
  return result.rows[0];
};

// The confirmed identity, or null. Only an identity the owner confirmed on
// this surface is served: a Business ID recorded some other way (the firm, the
// invoice chat) has no source the contract can name (`prh_ytj | owner`), so it
// is not dressed up as one — it still counts as associated for the 409.
// A confirmation whose Business ID no longer matches the stored one (the firm
// corrected it since) is stale and not served either.
export const projectBusinessIdentity = (row) => {
  const record = plainObject(row.business_register);
  const businessId = associatedBusinessId(row.business_id, projectEntity(row).country);
  if (!businessId || !record.business_id || record.business_id !== businessId) return null;
  if (!['prh_ytj', 'owner'].includes(record.source) || !LEGAL_FORMS.includes(record.legal_form)) return null;
  return {
    business_id: businessId,
    legal_name: str(row.legal_name) || str(record.legal_name),
    legal_form: record.legal_form,
    legal_form_code: str(record.legal_form_code) || null,
    registered_address: str(record.registered_address),
    source: record.source,
    fetched_at: record.source === 'prh_ytj' ? iso(record.fetched_at) : null,
    authority_verified: false
  };
};

// next_step: identify → stage → first receipt → done. `prior_records` is never
// served: this server cannot store background records (registering one would
// parse and post it — mobileApi.js `purpose: prior_records` answers 501), so
// it would send the owner to a step that can only fail.
export const projectBusinessSetup = (row) => {
  const identity = projectBusinessIdentity(row);
  const setup = plainObject(row.business_setup);
  const stage = BUSINESS_STAGES.includes(setup.business_stage) ? setup.business_stage : null;
  const hasDocuments = row.has_documents === true;
  const nextStep = !identity ? 'identify_business' : !stage ? 'business_stage' : hasDocuments ? 'done' : 'first_receipt';
  return {
    identity,
    business_stage: stage,
    suggestion_dismissed: setup.suggestion_dismissed === true,
    // The reference timing: offered in Books once the first document is in.
    suggestion_available: hasDocuments,
    prior_record_ids: [],
    next_step: nextStep,
    capabilities: { ...SETUP_CAPABILITIES }
  };
};

export const getBusinessSetup = async (ctx) =>
  projectBusinessSetup(await readBusinessSetupState({ firmId: ctx.firmId, clientId: ctx.clientId }));

// ── Write ─────────────────────────────────────────────────────────────────

// The closed request shape → a validated action, before anything is read.
export const parseSetupAction = (body) => {
  const type = body?.type;
  if (!SETUP_ACTION_TYPES.includes(type)) {
    throw badRequest(`type must be one of ${SETUP_ACTION_TYPES.join(', ')}.`, 'SETUP_ACTION_INVALID');
  }
  if (type === 'confirm_registry') {
    if (typeof body.candidate_id !== 'string' || !body.candidate_id.trim() || body.candidate_id.length > 200) {
      throw badRequest('candidate_id is required.', 'CANDIDATE_ID_REQUIRED');
    }
    return { type, candidateId: body.candidate_id.trim() };
  }
  if (type === 'confirm_manual') {
    // The format is the entity's country's to check (setupPatchFor), once
    // the entity is read; here only the shape.
    if (typeof body.business_id !== 'string' || !body.business_id.trim() || body.business_id.length > 40) {
      throw badRequest('business_id is required.', 'BUSINESS_ID_INVALID');
    }
    const businessId = body.business_id;
    const legalName = str(body.legal_name);
    if (!legalName || legalName.length > 1000) throw badRequest('legal_name must be 1–1000 characters.', 'BUSINESS_DETAILS_INVALID');
    if (!LEGAL_FORMS.includes(body.legal_form)) {
      throw badRequest(`legal_form must be one of ${LEGAL_FORMS.join(', ')}.`, 'BUSINESS_DETAILS_INVALID');
    }
    return { type, businessId, legalName, legalForm: body.legal_form };
  }
  if (type === 'set_stage') {
    if (!BUSINESS_STAGES.includes(body.business_stage)) {
      throw badRequest('business_stage must be new or existing.', 'BUSINESS_STAGE_INVALID');
    }
    return { type, businessStage: body.business_stage };
  }
  return { type };
};

const RECEIPT_SUMMARY = Object.freeze({
  confirm_manual: 'Business details saved as you entered them. This does not verify ownership or give Donna any authority.',
  set_stage: 'Saved. This only tailors your setup.',
  defer: 'Saved. You can finish setting up any time from Account.'
});

// Pure: the profile patch an action writes, given the entity's current state.
// Throws the contract's 409s. `now` and `actorId` are stamped onto the record.
export const setupPatchFor = ({ action, row, actorId, now = new Date() }) => {
  const setup = plainObject(row.business_setup);
  const nextSetup = (changes) => ({
    business_stage: BUSINESS_STAGES.includes(setup.business_stage) ? setup.business_stage : null,
    suggestion_dismissed: false,
    ...changes
  });
  if (action.type === 'confirm_registry') {
    // No lookup on this server issues candidates (GAPS.md), so no candidate
    // is ever current. Same answer the contract gives an expired one.
    throw mobileError(409, 'REGISTRY_CANDIDATE_EXPIRED',
      'This register result has expired or was not issued for this business. Look the Business ID up again, or enter the details yourself.');
  }
  if (action.type === 'confirm_manual') {
    const country = projectEntity(row).country;
    const canonical = registryIdentifierFor(country);
    if (!canonical) {
      throw badRequest('Business register details can be confirmed for Finnish businesses only.', 'BUSINESS_REGISTER_FINLAND_ONLY');
    }
    const businessId = canonical(action.businessId);
    if (!businessId) throw badRequest('That is not a valid Finnish Business ID (1234567-8).', 'BUSINESS_ID_INVALID');
    const existing = associatedBusinessId(row.business_id, country);
    if (existing && existing !== businessId) {
      throw mobileError(409, 'BUSINESS_ID_LOCKED',
        'This business already has a different Business ID on file. Ask your accountant if it needs correcting.');
    }
    return {
      businessId,
      legalName: action.legalName,
      ...(str(row.company_name) ? {} : { companyName: action.legalName }),
      business_register: {
        business_id: businessId,
        legal_form: action.legalForm,
        legal_form_code: null,
        registered_address: '',
        source: 'owner',
        fetched_at: null,
        authority_verified: false,
        confirmed_by: actorId,
        confirmed_at: now.toISOString(),
        terminal: 'mobile'
      },
      business_setup: nextSetup({})
    };
  }
  if (action.type === 'set_stage') return { business_setup: nextSetup({ business_stage: action.businessStage }) };
  return { business_setup: nextSetup({ suggestion_dismissed: true }) };
};

const LOCK_SQL = "select pg_advisory_xact_lock(hashtextextended('mobile-business-setup:' || $1 || ':' || $2, 0))";

export const updateBusinessSetup = async (ctx, body, { withClient = withFirmDbClient, now = () => new Date() } = {}) => {
  const action = parseSetupAction(body);
  return withClient(async (client) => {
    // This transaction only holds the lock; the write is the firm route's own
    // transaction on its own connection, committed before this one ends.
    await client.query('begin');
    try {
      await client.query("set local lock_timeout = '5s'");
      await client.query(LOCK_SQL, [ctx.firmId, ctx.clientId]);
      const row = await readBusinessSetupState({ firmId: ctx.firmId, clientId: ctx.clientId, query: client.query.bind(client) });
      const profilePatch = setupPatchFor({ action, row, actorId: ctx.principal?.principalId || null, now: now() });
      const watermark = await readAuditWatermark({ firmId: ctx.firmId });
      const routed = await ctx.dispatch({
        method: 'POST',
        path: `/clients/${encodeURIComponent(ctx.clientId)}/profile`,
        body: { firm_id: ctx.firmId, profile_patch: profilePatch }
      });
      if (routed.status < 200 || routed.status >= 300) {
        throw mobileError(routed.status >= 400 ? routed.status : 502, routed.body?.code || 'BUSINESS_SETUP_FAILED',
          routed.body?.error || 'Donna could not save these details.');
      }
      const after = await readBusinessSetupState({ firmId: ctx.firmId, clientId: ctx.clientId, query: client.query.bind(client) });
      const auditRows = (await readAuditRowsSince({ firmId: ctx.firmId, clientId: ctx.clientId, watermark, resourceIds: [ctx.clientId] }))
        .filter((auditRow) => auditRow.action === 'client.profile.update');
      await client.query('commit');
      return {
        setup: projectBusinessSetup(after),
        receipt: projectReceipt({
          summary: RECEIPT_SUMMARY[action.type],
          targets: [{ target: `entity:${ctx.clientId}:business_setup`, applied: true }],
          auditRows
        })
      };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    }
  });
};
