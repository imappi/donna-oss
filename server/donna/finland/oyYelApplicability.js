// FI-13 slice 13.3A PR2 (D-FI13-7 v2) — YEL applicability for an osakeyhtiö,
// DERIVED from the ownership + authority models, never from a single pct field.
//
// The toiminimi YEL watch (yel.js) assumes the owner is a self-employed
// entrepreneur who is ALWAYS YEL-liable. An Oy owner is not: the pension regime
// depends on whether they work in a LEADING POSITION and how much they own.
// YEL 3 § (applicability, NOT työtulo): a person in a leading position
// (toimitusjohtaja / hallituksen jäsen) is YEL-insured if they own — alone —
// more than 30 % of the company, OR more than 50 % together with family members;
// ownership counts VOTES as well as shares and includes indirect holdings.
// Everyone else in the company is a TyEL employee.
//
// This module DERIVES that applicability from the persisted models
// (computeCapTable + loadAuthorityRolesAsOf) and renders it as a PROPOSAL with
// `confirmedAgainstPrimary: false` — the thresholds, the leading-position
// mapping, and the treatment of indirect holdings are the F-FI13-V verification
// surface. Two hard lines, both load-bearing:
//   • Donna NEVER determines työtulo (the YEL income figure) — that is set
//     between the entrepreneur and their insurer. This module answers "which
//     pension regime", never "how much".
//   • When the model is incomplete (no ownership recorded, no authority roles),
//     the person is UNDETERMINED and escalates — never silently defaulted to
//     TyEL by absence.
//
// Deterministic KEEP-layer module, no model call. Pure; the DB caller supplies
// the cap table + authority rows.

// Config-plane flag (migration 042 pattern) — clientFlagActs, envFallback
// () => false; dark by default, canary per client.
export const FINLAND_OY_YEL_APPLICABILITY_FLAG_KEY = 'FINLAND_OY_YEL_APPLICABILITY';

// A "leading position" (johtava asema) for YEL 3 §: the managing director /
// company representation, or a board seat. Pinned to the authority model's
// role vocabulary (finland/authority.js DECISION_MAKER_ROLES is the same pair).
export const YEL_LEADING_POSITION_ROLES = Object.freeze(['board_membership', 'company_representation']);

// Ownership thresholds (percent). > (strictly greater), per YEL 3 §.
export const YEL_OWNERSHIP_THRESHOLD_ALONE_PCT = 30;
export const YEL_OWNERSHIP_THRESHOLD_FAMILY_PCT = 50;

// Closed pension-regime enum. 'undetermined' is a real terminal-input: it means
// the model cannot yet answer, so the case rests on a human — never a guess.
export const YEL_PENSION_REGIMES = Object.freeze(['yel', 'tyel', 'undetermined']);

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pct = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// The controlling percentage for the threshold test is the GREATER of the
// ownership share and the voting share — YEL 3 § keys on omistus OR äänivalta.
const controllingPct = (ownership, voting) => Math.max(pct(ownership) ?? 0, pct(voting) ?? 0);

const holderKeyOf = (row = {}) =>
  row.shareholder_id
    ? `sh:${row.shareholder_id}`
    : (row.holder_ref ? `ref:${String(row.holder_ref).trim().toLowerCase()}`
      : (row.holder_display_name ? `name:${String(row.holder_display_name).trim().toLowerCase()}` : null));

const YEL_NOTE = Object.freeze({
  yel_alone: {
    fi: 'Työskentelet johtavassa asemassa ja omistat yksin yli 30 % yhtiöstä — kuulut YEL:n (yrittäjän eläkevakuutus) piiriin, et TyEL:iin. Donna ei määritä työtuloa; se vahvistetaan vakuutusyhtiön kanssa.',
    en: 'You work in a leading position and own over 30 % of the company alone — you fall under YEL (entrepreneur pension), not TyEL. Donna does not determine your YEL work income; that is set with your insurer.'
  },
  yel_family: {
    fi: 'Työskentelet johtavassa asemassa ja perheenne omistaa yhdessä yli 50 % yhtiöstä — kuulut YEL:n piiriin, et TyEL:iin. Donna ei määritä työtuloa.',
    en: 'You work in a leading position and your family together owns over 50 % of the company — you fall under YEL, not TyEL. Donna does not determine your YEL work income.'
  },
  tyel_minority: {
    fi: 'Työskentelet johtavassa asemassa mutta omistus jää alle YEL-rajan (yli 30 % yksin tai yli 50 % perheen kanssa) — työsuhde kuuluu TyEL:n piiriin. Tarkistetaan vakuutuslaji.',
    en: 'You work in a leading position but ownership is below the YEL threshold (over 30 % alone or over 50 % with family) — the employment falls under TyEL. The insurance class is confirmed.'
  },
  no_leading_position: {
    fi: 'Osakas ilman kirjattua johtavaa asemaa: YEL/TyEL-luokitusta ei voi johtaa pelkästä omistuksesta. Jos osakas työskentelee yhtiössä, vakuutuslaji tarkistetaan.',
    en: 'Shareholder with no recorded leading position: YEL/TyEL cannot be derived from ownership alone. If the shareholder works in the company, the insurance class is reviewed.'
  },
  leading_no_ownership: {
    fi: 'Johtava asema ilman omistusta (esim. palkattu toimitusjohtaja): työsuhde kuuluu TyEL:n piiriin.',
    en: 'Leading position with no ownership (e.g. a hired managing director): the employment falls under TyEL.'
  }
});

// evaluateOyYelApplicability({ capTable, authorityRoles }) → the per-person
// derived pension regime, plus a `determinable` flag and stated caveats.
// Pure, never throws on garbage.
export const evaluateOyYelApplicability = ({ capTable = null, authorityRoles = [] } = {}) => {
  const shareholders = Array.isArray(capTable?.shareholders) ? capTable.shareholders : [];
  const roleRows = Array.isArray(authorityRoles) ? authorityRoles : [];

  // Leading-position holders keyed by holder identity (shareholder id preferred).
  const leadingByKey = new Map();
  for (const row of roleRows) {
    if (!YEL_LEADING_POSITION_ROLES.includes(row?.role)) continue;
    const key = holderKeyOf(row);
    if (!key) continue;
    const entry = leadingByKey.get(key) || { key, shareholder_id: row.shareholder_id ?? null, display_name: row.holder_display_name ?? null, roles: new Set() };
    entry.roles.add(row.role);
    if (!entry.shareholder_id && row.shareholder_id) entry.shareholder_id = row.shareholder_id;
    if (!entry.display_name && row.holder_display_name) entry.display_name = row.holder_display_name;
    leadingByKey.set(key, entry);
  }

  // Family-aggregated ownership by family_group_ref (a null ref is its own group).
  const familyTotals = new Map();
  for (const s of shareholders) {
    if (!s.family_group_ref) continue;
    const prev = familyTotals.get(s.family_group_ref) || { ownership: 0, voting: 0 };
    prev.ownership += num(s.ownership_pct);
    prev.voting += num(s.voting_pct);
    familyTotals.set(s.family_group_ref, prev);
  }

  const persons = [];
  const seenLeadingKeys = new Set();

  const classify = ({ shareholder, leadingEntry }) => {
    const leadingRoles = leadingEntry ? [...leadingEntry.roles].sort() : [];
    const leading_position = leadingRoles.length > 0;
    const ownership_pct = shareholder ? pct(shareholder.ownership_pct) : 0;
    const voting_pct = shareholder ? pct(shareholder.voting_pct) : 0;
    const solo = controllingPct(ownership_pct, voting_pct);

    const familyRef = shareholder?.family_group_ref ?? null;
    const familyAgg = familyRef ? familyTotals.get(familyRef) : null;
    const family_controlling_pct = familyAgg ? controllingPct(familyAgg.ownership, familyAgg.voting) : solo;

    let pension_regime = 'undetermined';
    let basis = 'model_incomplete';
    let note = null;

    if (leading_position && shareholder) {
      if (solo > YEL_OWNERSHIP_THRESHOLD_ALONE_PCT) {
        pension_regime = 'yel'; basis = 'leading_position_over_30_alone'; note = YEL_NOTE.yel_alone;
      } else if (family_controlling_pct > YEL_OWNERSHIP_THRESHOLD_FAMILY_PCT) {
        pension_regime = 'yel'; basis = 'leading_position_over_50_family'; note = YEL_NOTE.yel_family;
      } else {
        pension_regime = 'tyel'; basis = 'below_ownership_threshold'; note = YEL_NOTE.tyel_minority;
      }
    } else if (leading_position && !shareholder) {
      pension_regime = 'tyel'; basis = 'leading_position_no_ownership'; note = YEL_NOTE.leading_no_ownership;
    } else if (shareholder) {
      pension_regime = 'undetermined'; basis = 'no_leading_position'; note = YEL_NOTE.no_leading_position;
    }

    return {
      shareholder_id: shareholder?.id ?? leadingEntry?.shareholder_id ?? null,
      display_name: shareholder?.display_name ?? leadingEntry?.display_name ?? null,
      leading_position,
      leading_roles: leadingRoles,
      ownership_pct,
      voting_pct,
      family_group_ref: familyRef,
      controlling_pct: shareholder ? solo : 0,
      family_controlling_pct: shareholder ? family_controlling_pct : 0,
      pension_regime,
      basis,
      note_fi: note?.fi ?? null,
      note_en: note?.en ?? null
    };
  };

  for (const shareholder of shareholders) {
    const key = shareholder.id ? `sh:${shareholder.id}` : null;
    const leadingEntry = key ? leadingByKey.get(key) : null;
    if (leadingEntry) seenLeadingKeys.add(leadingEntry.key);
    persons.push(classify({ shareholder, leadingEntry }));
  }

  // Leading-position holders who are NOT in the cap table (a hired CEO with no
  // shares): still classified — TyEL, no ownership.
  for (const entry of leadingByKey.values()) {
    if (seenLeadingKeys.has(entry.key)) continue;
    persons.push(classify({ shareholder: null, leadingEntry: entry }));
  }

  const determinable = shareholders.length > 0 || leadingByKey.size > 0;

  return {
    determinable,
    persons,
    // Indirect holdings (holdings through an intermediary company) are part of
    // the YEL 3 § test but are NOT yet in the ownership model (single-owner
    // pilot). State the boundary rather than silently ignoring it.
    caveats: Object.freeze(['indirect_holdings_not_modelled']),
    // The rule shape is coded; the thresholds and leading-position mapping are
    // confirmed against a Finnish primary source before any FI canary.
    confirmedAgainstPrimary: false,
    provenance: {
      deterministic: true,
      policy: 'YEL 3 § applicability (leading position + >30 % alone / >50 % with family, votes included); työtulo NEVER derived'
    }
  };
};
