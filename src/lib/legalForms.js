// Canonical client legal-form vocabulary shared by intake, persistence, and
// owner correction surfaces.
//
// The runtime resolvers branch on jurisdiction-prefixed values such as
// `us-llc` and `gb-ltd`. Identity documents and model-authored intake drafts
// naturally use display language instead ("Limited liability company",
// "Limited company", "Sole trader"). This module is the deterministic bridge:
// it maps a bounded, jurisdiction-specific alias set to the canonical values
// and classifies everything else for a visible correction path. It never
// guesses a jurisdiction or an ambiguous legal form.

export const ENTITY_TYPES_BY_JURISDICTION = Object.freeze({
  sg: Object.freeze(['sg-pte', 'sg-llp', 'sg-sole-prop']),
  us: Object.freeze(['us-llc', 'us-c-corp', 'us-s-corp', 'us-sole-prop', 'us-partnership']),
  gb: Object.freeze(['gb-ltd', 'gb-llp', 'gb-sole-trader', 'gb-partnership']),
  hk: Object.freeze(['hk-ltd', 'hk-sole-prop']),
  au: Object.freeze(['au-pty-ltd', 'au-sole-trader']),
  nz: Object.freeze(['nz-limited', 'nz-sole-trader']),
  my: Object.freeze(['my-sdn-bhd', 'my-sole-prop']),
  ca: Object.freeze(['ca-inc', 'ca-sole-prop']),
  fi: Object.freeze(['fi-toiminimi', 'fi-oy']),
  // AE (2026-08-30): a bounded starter set. The mainland/free-zone split is
  // carried as a FORM here (a free-zone company is registered with a free zone
  // authority, a mainland LLC with an emirate DED) because it is observable at
  // registration — but whether free-zone standing should instead be its own
  // profile axis (it drives corporate-tax treatment via qualifying-free-zone-
  // person status) is an open gap-6 question; see the AE addendum in
  // docs/donna-country-pack-contract-gaps.md before widening this list.
  ae: Object.freeze(['ae-llc', 'ae-free-zone-co', 'ae-sole-establishment'])
});

export const ENTITY_TYPE_LABEL = Object.freeze({
  'sg-pte': 'Private Limited (Pte Ltd)',
  'sg-llc': 'LLC',
  'sg-llp': 'LLP',
  'sg-sole-prop': 'Sole Proprietorship',
  'us-llc': 'LLC',
  'us-c-corp': 'C Corporation',
  'us-s-corp': 'S Corporation',
  'us-sole-prop': 'Sole Proprietorship',
  'us-partnership': 'Partnership',
  'gb-ltd': 'Limited Company',
  'gb-llp': 'LLP',
  'gb-sole-trader': 'Sole Trader',
  'gb-partnership': 'Partnership',
  'hk-ltd': 'Limited Company',
  'hk-sole-prop': 'Sole Proprietorship',
  'au-pty-ltd': 'Pty Ltd',
  'au-sole-trader': 'Sole Trader',
  'nz-limited': 'Limited Company',
  'nz-sole-trader': 'Sole Trader',
  'my-sdn-bhd': 'Sdn. Bhd.',
  'my-sole-prop': 'Sole Proprietorship',
  'ca-inc': 'Incorporated',
  'ca-sole-prop': 'Sole Proprietorship',
  'fi-toiminimi': 'Sole Trader (Toiminimi)',
  'fi-oy': 'Limited Company (Oy)',
  'ae-llc': 'LLC (Mainland)',
  'ae-free-zone-co': 'Free Zone Company (FZE/FZCO)',
  'ae-sole-establishment': 'Sole Establishment'
});

const aliases = (entries) => Object.freeze(Object.fromEntries(entries));

// Deliberately bounded. Adding an alias is an identity-contract change, not a
// fuzzy-matching tweak. Every entry is safe only in the named jurisdiction.
export const LEGAL_FORM_ALIASES_BY_JURISDICTION = Object.freeze({
  sg: aliases([
    ['pte-ltd', 'sg-pte'],
    ['pte-limited', 'sg-pte'],
    ['private-limited', 'sg-pte'],
    ['private-limited-company', 'sg-pte'],
    ['private-limited-pte-ltd', 'sg-pte'],
    ['llp', 'sg-llp'],
    ['limited-liability-partnership', 'sg-llp'],
    ['sole-prop', 'sg-sole-prop'],
    ['sole-proprietor', 'sg-sole-prop'],
    ['sole-proprietorship', 'sg-sole-prop']
  ]),
  us: aliases([
    ['llc', 'us-llc'],
    ['limited-liability-company', 'us-llc'],
    ['c-corp', 'us-c-corp'],
    ['c-corporation', 'us-c-corp'],
    ['s-corp', 'us-s-corp'],
    ['s-corporation', 'us-s-corp'],
    ['sole-prop', 'us-sole-prop'],
    ['sole-proprietor', 'us-sole-prop'],
    ['sole-proprietorship', 'us-sole-prop'],
    ['partnership', 'us-partnership'],
    ['general-partnership', 'us-partnership']
  ]),
  gb: aliases([
    ['ltd', 'gb-ltd'],
    ['limited', 'gb-ltd'],
    ['limited-company', 'gb-ltd'],
    ['private-limited', 'gb-ltd'],
    ['private-limited-company', 'gb-ltd'],
    ['private-company-limited-by-shares', 'gb-ltd'],
    ['llp', 'gb-llp'],
    ['limited-liability-partnership', 'gb-llp'],
    ['sole-trader', 'gb-sole-trader'],
    ['partnership', 'gb-partnership'],
    ['general-partnership', 'gb-partnership']
  ]),
  hk: aliases([
    ['ltd', 'hk-ltd'],
    ['limited', 'hk-ltd'],
    ['limited-company', 'hk-ltd'],
    ['sole-prop', 'hk-sole-prop'],
    ['sole-proprietor', 'hk-sole-prop'],
    ['sole-proprietorship', 'hk-sole-prop']
  ]),
  au: aliases([
    ['pty-ltd', 'au-pty-ltd'],
    ['proprietary-limited', 'au-pty-ltd'],
    ['sole-trader', 'au-sole-trader']
  ]),
  nz: aliases([
    ['ltd', 'nz-limited'],
    ['limited', 'nz-limited'],
    ['limited-company', 'nz-limited'],
    ['sole-trader', 'nz-sole-trader']
  ]),
  my: aliases([
    ['sdn-bhd', 'my-sdn-bhd'],
    ['sendirian-berhad', 'my-sdn-bhd'],
    ['private-limited-company', 'my-sdn-bhd'],
    ['sole-prop', 'my-sole-prop'],
    ['sole-proprietor', 'my-sole-prop'],
    ['sole-proprietorship', 'my-sole-prop']
  ]),
  ca: aliases([
    ['inc', 'ca-inc'],
    ['incorporated', 'ca-inc'],
    ['sole-prop', 'ca-sole-prop'],
    ['sole-proprietor', 'ca-sole-prop'],
    ['sole-proprietorship', 'ca-sole-prop']
  ]),
  fi: aliases([
    ['oy', 'fi-oy'],
    ['osakeyhtio', 'fi-oy'],
    ['osakeyhtio-oy', 'fi-oy'],
    ['limited-company-oy', 'fi-oy'],
    ['toiminimi', 'fi-toiminimi'],
    ['yksityinen-elinkeinonharjoittaja', 'fi-toiminimi'],
    ['yksityinen-elinkeinonharjoittaja-toiminimi', 'fi-toiminimi'],
    ['sole-trader', 'fi-toiminimi'],
    ['sole-trader-toiminimi', 'fi-toiminimi'],
    ['sole-proprietor', 'fi-toiminimi'],
    ['sole-proprietorship', 'fi-toiminimi']
  ]),
  ae: aliases([
    ['llc', 'ae-llc'],
    ['limited-liability-company', 'ae-llc'],
    ['mainland-llc', 'ae-llc'],
    ['llc-mainland', 'ae-llc'],
    ['free-zone-company-fze-fzco', 'ae-free-zone-co'],
    ['fze', 'ae-free-zone-co'],
    ['fzco', 'ae-free-zone-co'],
    ['fz-llc', 'ae-free-zone-co'],
    ['free-zone-establishment', 'ae-free-zone-co'],
    ['free-zone-company', 'ae-free-zone-co'],
    ['sole-establishment', 'ae-sole-establishment'],
    ['sole-prop', 'ae-sole-establishment'],
    ['sole-proprietor', 'ae-sole-establishment'],
    ['sole-proprietorship', 'ae-sole-establishment']
  ])
});

// These labels are genuinely insufficient to select one supported form.
// Refusing with the exact choices is safer than silently treating every US
// corporation as a C corporation.
const AMBIGUOUS_ALIASES_BY_JURISDICTION = Object.freeze({
  us: Object.freeze({
    corporation: Object.freeze(['us-c-corp', 'us-s-corp']),
    incorporated: Object.freeze(['us-c-corp', 'us-s-corp'])
  })
});

export const normalizeLegalFormJurisdiction = (value) => {
  if (value == null) return null;
  const lower = String(value).trim().toLowerCase();
  if (!lower || lower === 'unknown') return null;
  if (lower === 'uk') return 'gb';
  return /^[a-z]{2}$/.test(lower) ? lower : null;
};

export const normalizeLegalFormToken = (value) => {
  if (value == null) return '';
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
};

const canonicalJurisdictionFor = (token) => {
  for (const [jurisdiction, options] of Object.entries(ENTITY_TYPES_BY_JURISDICTION)) {
    if (options.includes(token)) return jurisdiction;
  }
  return null;
};

export const legalFormCompatibility = ({ jurisdiction, entityType } = {}) => {
  const supplied = entityType == null ? null : String(entityType).trim();
  const token = normalizeLegalFormToken(entityType);
  const jurisdictionKey = normalizeLegalFormJurisdiction(jurisdiction);
  const explicitCanonicalJurisdiction = canonicalJurisdictionFor(token);

  if (!token) {
    return {
      status: 'missing',
      supplied,
      jurisdiction: jurisdictionKey,
      canonical: null,
      options: jurisdictionKey ? [...(ENTITY_TYPES_BY_JURISDICTION[jurisdictionKey] || [])] : []
    };
  }

  if (!jurisdictionKey) {
    return {
      status: 'jurisdiction_required',
      supplied,
      jurisdiction: null,
      suggestedJurisdiction: explicitCanonicalJurisdiction,
      canonical: null,
      options: []
    };
  }

  const options = [...(ENTITY_TYPES_BY_JURISDICTION[jurisdictionKey] || [])];
  if (!options.length) {
    return {
      status: 'jurisdiction_unsupported',
      supplied,
      jurisdiction: jurisdictionKey,
      canonical: null,
      options
    };
  }

  if (explicitCanonicalJurisdiction && explicitCanonicalJurisdiction !== jurisdictionKey) {
    return {
      status: 'jurisdiction_mismatch',
      supplied,
      jurisdiction: jurisdictionKey,
      suppliedJurisdiction: explicitCanonicalJurisdiction,
      canonical: null,
      options
    };
  }

  if (options.includes(token)) {
    return { status: 'canonical', supplied, jurisdiction: jurisdictionKey, canonical: token, options };
  }

  const ambiguousOptions = AMBIGUOUS_ALIASES_BY_JURISDICTION[jurisdictionKey]?.[token] || null;
  if (ambiguousOptions) {
    return {
      status: 'ambiguous',
      supplied,
      jurisdiction: jurisdictionKey,
      canonical: null,
      options: [...ambiguousOptions]
    };
  }

  const canonical = LEGAL_FORM_ALIASES_BY_JURISDICTION[jurisdictionKey]?.[token] || null;
  if (canonical && options.includes(canonical)) {
    return { status: 'alias', supplied, jurisdiction: jurisdictionKey, canonical, options };
  }

  return {
    status: 'unsupported',
    supplied,
    jurisdiction: jurisdictionKey,
    canonical: null,
    options
  };
};
