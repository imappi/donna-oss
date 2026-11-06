// FI-13 slice 13.0A-2b — the Oy authority role model (D-FI13-11 v2).
//
// "Authority is a role model; the pilot is one person holding all roles
// EXPLICITLY." The distinct authorities a person can hold over an Oy —
// workspace access, bookkeeping approval, tax-filing authority, board
// membership, FS signatory, shareholder decision authority, company
// representation, PRH filing authority — are each a stored, effective-dated
// row {authority_basis, verified_at, verified_from, valid_from/until, scope},
// never an inferred boolean. A checkbox is NOT an authority basis for tax
// filing or published statements; prokura alone is insufficient for FS
// signing / PRH filing (D-FI13-11's provenance-pending statutory reading).
//
// Built ON the existing grant pattern (reconciliationAuthorityGrants.js /
// migrations 040 + 054 — this module is the third USE of that pattern, not a
// third substrate): deterministic ids, idempotent upserts, closed CHECK-pinned
// vocabularies, status governance where revoked is a recorded human "no".
// Store conventions mirror ownership.js / statutoryBlocker.js: pre-migration
// soft-fail (42P01/42703 → null) so a deploy that predates 079 degrades to
// "no authority recorded" rather than a hard crash.
//
// Two PURE derivations wire the model into its consumers:
//   • deriveAuthorityEnvelopeAttributes → the authority subset of the
//     D-FI13-13 acceptance-envelope attributes (singleDecisionMakerWithAuthority),
//     the sibling of ownership.js's deriveOwnershipEnvelopeAttributes.
//   • authorityBasisGaps → the roles whose recorded basis is INSUFFICIENT for
//     the role (the checkbox-for-tax-filing case). A gap is an onboarding fact
//     to surface resting on the owner to evidence (two-terminal-states), not a
//     write error — the store records the basis honestly; the gap is visible.
//
// AML / PII posture (counsel-gated §8): holderRef is a REFERENCE, never a raw
// hetu / Y-tunnus.

import crypto from 'node:crypto';

// The distinct authorities of D-FI13-11 v2 — pinned to the 079 CHECK by
// migrations.test.js.
export const FINLAND_AUTHORITY_ROLES = Object.freeze([
  'workspace_access',
  'bookkeeping_approval',
  'tax_filing',
  'board_membership',
  'fs_signatory',
  'shareholder_decision',
  'company_representation',
  'prh_filing'
]);

// WHY a holder has an authority — pinned to the 079 CHECK. Register/document-
// backed bases first; 'engagement_letter' and 'owner_attestation' are the
// attested (checkbox-grade) tail.
export const FINLAND_AUTHORITY_BASES = Object.freeze([
  'trade_register',
  'articles_of_association',
  'board_resolution',
  'shareholder_resolution',
  'suomifi_mandate',
  'prokura',
  'engagement_letter',
  'owner_attestation'
]);

// The sufficiency POLICY (D-FI13-11): which bases are NOT enough for which
// roles. A checkbox ('owner_attestation') or an engagement letter is not an
// authority basis for tax filing or published statements; prokura alone is
// insufficient for FS signing / PRH filing (FS are signed by the board + CEO;
// PRH filings by a board member / CEO / authorized person). Closed table —
// re-tune only on a dated Kari call (same discipline as the envelope catalog).
export const AUTHORITY_INSUFFICIENT_BASES_BY_ROLE = Object.freeze({
  tax_filing: Object.freeze(['engagement_letter', 'owner_attestation']),
  fs_signatory: Object.freeze(['engagement_letter', 'owner_attestation', 'prokura']),
  prh_filing: Object.freeze(['engagement_letter', 'owner_attestation', 'prokura'])
});

// authorityBasisSufficient({ role, basis }) → boolean. Fail-closed: an unknown
// role or basis is never sufficient. Pure.
export const authorityBasisSufficient = ({ role, basis } = {}) => {
  if (!FINLAND_AUTHORITY_ROLES.includes(role)) return false;
  if (!FINLAND_AUTHORITY_BASES.includes(basis)) return false;
  const insufficient = AUTHORITY_INSUFFICIENT_BASES_BY_ROLE[role];
  return !insufficient || !insufficient.includes(basis);
};

const hash = (...parts) =>
  crypto.createHash('sha256').update(parts.map((p) => String(p ?? '')).join('|')).digest('hex').slice(0, 16);
const slug = (value) =>
  String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'x';

// A holder's natural key: holderRef when present, else the display name — the
// buildShareholderId convention, so the same person collapses to one identity.
const holderKey = ({ holderRef = null, holderDisplayName = null } = {}) =>
  holderRef || holderDisplayName || '';

// Deterministic id — one row per (holder, role); re-recording the same
// authority upserts (basis / validity / verification update), never duplicates.
export const buildAuthorityRoleId = ({ firmId, clientId, holderRef = null, holderDisplayName = null, role } = {}) =>
  ['fi-authrole', slug(clientId), hash(firmId, clientId, holderKey({ holderRef, holderDisplayName }), role)].join('-');

// ── Pure derivations ─────────────────────────────────────────────────────────

// The envelope's decision-maker question reads these two roles: the board seat
// and the representation authority (D-FI13-13's "one decision-maker with
// board/representation authority").
const DECISION_MAKER_ROLES = Object.freeze(['board_membership', 'company_representation']);

const rowHolderKey = (row = {}) => holderKey({ holderRef: row.holder_ref, holderDisplayName: row.holder_display_name });

// deriveAuthorityEnvelopeAttributes({ roles }) → the authority SUBSET of the
// acceptance-envelope attributes (the sibling of ownership.js's
// deriveOwnershipEnvelopeAttributes). `roles` are the ACTIVE as-of rows.
//
// Tri-state, matching the envelope's fail-closed read:
//   • null (unknown)  — the decision-maker structure is not yet recorded (no
//     rows at all, or a decision role missing) → the envelope fires
//     'unconfirmed', resting on the owner.
//   • true            — exactly ONE person holds BOTH board membership and
//     company representation, and nobody else holds either.
//   • false           — a multi-member board or split representation: a
//     recorded structure OUTSIDE the pilot envelope.
// Pure, never throws.
export const deriveAuthorityEnvelopeAttributes = ({ roles = [] } = {}) => {
  const rows = Array.isArray(roles) ? roles : [];
  if (rows.length === 0) return { singleDecisionMakerWithAuthority: null };

  const holdersByRole = new Map(DECISION_MAKER_ROLES.map((r) => [r, new Set()]));
  for (const row of rows) {
    if (!holdersByRole.has(row.role)) continue;
    const key = rowHolderKey(row);
    if (key) holdersByRole.get(row.role).add(key);
  }

  const board = holdersByRole.get('board_membership');
  const representation = holdersByRole.get('company_representation');
  // Roles are recorded but a decision role is still missing → unknown, not a
  // disqualification: the answer rests on the owner.
  if (board.size === 0 || representation.size === 0) {
    return { singleDecisionMakerWithAuthority: null };
  }
  const single =
    board.size === 1 && representation.size === 1 && [...board][0] === [...representation][0];
  return { singleDecisionMakerWithAuthority: single };
};

// authorityBasisGaps({ roles }) → the ACTIVE rows whose recorded basis is
// insufficient for the role (authorityBasisSufficient), each a visible
// onboarding gap for the owner to evidence. Pure, deterministic order.
export const authorityBasisGaps = ({ roles = [] } = {}) => {
  const rows = Array.isArray(roles) ? roles : [];
  return rows
    .filter((row) => !authorityBasisSufficient({ role: row.role, basis: row.authority_basis }))
    .map((row) => ({
      id: row.id ?? null,
      role: row.role ?? null,
      authority_basis: row.authority_basis ?? null,
      holder_display_name: row.holder_display_name ?? null
    }));
};

// ── Store (pre-migration soft-fail like ownership.js) ────────────────────────

const softFail = (error) => error?.code === '42P01' || error?.code === '42703';

// Upsert an authority role (idempotent on the deterministic (holder, role)
// identity). Returns { id } or null (bad input / pre-migration). The store
// accepts an INSUFFICIENT basis — the gap surfaces via authorityBasisGaps, it
// is not a write error (recording the honest current basis is the point).
export const upsertAuthorityRole = async ({
  client, firmId, clientId, holderDisplayName, holderRef = null, shareholderId = null,
  role, authorityBasis, verifiedAt = null, verifiedFrom = null, scope = {},
  validFrom, validUntil = null, detail = {}
} = {}) => {
  if (!client || !firmId || !clientId || !holderDisplayName || !validFrom) return null;
  if (!FINLAND_AUTHORITY_ROLES.includes(role)) return null;
  if (!FINLAND_AUTHORITY_BASES.includes(authorityBasis)) return null;
  const id = buildAuthorityRoleId({ firmId, clientId, holderRef, holderDisplayName, role });
  try {
    await client.query(
      `insert into finland_authority_roles
         (id, firm_id, client_id, holder_display_name, holder_ref, shareholder_id, role,
          authority_basis, verified_at, verified_from, scope, valid_from, valid_until, detail)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14::jsonb)
       on conflict (id) do update set
         holder_display_name = excluded.holder_display_name,
         shareholder_id = coalesce(excluded.shareholder_id, finland_authority_roles.shareholder_id),
         authority_basis = excluded.authority_basis,
         verified_at = excluded.verified_at,
         verified_from = excluded.verified_from,
         scope = excluded.scope,
         valid_from = excluded.valid_from,
         valid_until = excluded.valid_until,
         status = 'active',
         revoked_reason = null,
         detail = finland_authority_roles.detail || excluded.detail,
         updated_at = now()`,
      [
        id, firmId, clientId, holderDisplayName, holderRef, shareholderId, role,
        authorityBasis, verifiedAt, verifiedFrom, JSON.stringify(scope || {}),
        validFrom, validUntil, JSON.stringify(detail || {})
      ]
    );
  } catch (error) {
    if (softFail(error)) return null;
    throw error;
  }
  return { id };
};

// Revoke an authority role — a recorded human "no" (status='revoked' + reason
// + the validity window closed), never a delete. Returns { id, revoked } or
// null (pre-migration); revoked=false when no matching row existed.
export const revokeAuthorityRole = async ({
  client, firmId, clientId, holderDisplayName = null, holderRef = null, role,
  revokedReason = null, validUntil = null
} = {}) => {
  if (!client || !firmId || !clientId || !role) return null;
  if (!holderKey({ holderRef, holderDisplayName })) return null;
  const id = buildAuthorityRoleId({ firmId, clientId, holderRef, holderDisplayName, role });
  try {
    const result = await client.query(
      `update finland_authority_roles
          set status = 'revoked',
              revoked_reason = $4,
              valid_until = coalesce($5::date, valid_until, current_date),
              updated_at = now()
        where id = $1 and firm_id = $2 and client_id = $3
        returning id`,
      [id, firmId, clientId, revokedReason, validUntil]
    );
    return { id, revoked: result.rows.length > 0 };
  } catch (error) {
    if (softFail(error)) return null;
    throw error;
  }
};

// loadAuthorityRolesAsOf({ client, firmId, clientId, asOf }) → the ACTIVE
// authority rows as of a date (default today at the DB; the 078 half-open
// window convention), or null when the store predates migration 079
// (soft-fail — "no authority recorded", distinct from an empty []).
export const loadAuthorityRolesAsOf = async ({ client, firmId, clientId, asOf = null } = {}) => {
  if (!client || !firmId || !clientId) return null;
  try {
    const result = await client.query(
      `select id, holder_display_name, holder_ref, shareholder_id, role, authority_basis,
              verified_at, verified_from, scope, valid_from, valid_until, status
         from finland_authority_roles
        where firm_id = $1 and client_id = $2
          and status = 'active'
          and valid_from <= coalesce($3::date, current_date)
          and (valid_until is null or coalesce($3::date, current_date) < valid_until)
        order by role, holder_display_name`,
      [firmId, clientId, asOf]
    );
    return result.rows || [];
  } catch (error) {
    if (softFail(error)) return null;
    throw error;
  }
};
