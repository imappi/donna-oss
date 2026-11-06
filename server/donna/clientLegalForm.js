// BF-2 — the fail-closed identity boundary for client legal forms.
//
// `src/lib/legalForms.js` owns the pure vocabulary so the owner correction UI
// and server writers cannot drift. This server wrapper turns non-canonical
// outcomes into stable API errors with an explicit correction path.

import {
  legalFormCompatibility,
  normalizeLegalFormJurisdiction
} from '../../src/lib/legalForms.js';

const errorForCompatibility = (compatibility) => {
  const jurisdiction = compatibility.jurisdiction?.toUpperCase() || null;
  const options = compatibility.options || [];
  const supplied = compatibility.supplied || '';
  const suffix = options.length ? ` Choose one of: ${options.join(', ')}.` : '';

  let code = 'CLIENT_LEGAL_FORM_UNSUPPORTED';
  let message = `Legal form ${JSON.stringify(supplied)} is not supported for ${jurisdiction || 'this jurisdiction'}.${suffix}`;
  if (compatibility.status === 'jurisdiction_required') {
    code = 'CLIENT_LEGAL_FORM_JURISDICTION_REQUIRED';
    message = `A jurisdiction is required before legal form ${JSON.stringify(supplied)} can be saved.`;
  } else if (compatibility.status === 'jurisdiction_mismatch') {
    code = 'CLIENT_LEGAL_FORM_JURISDICTION_MISMATCH';
    message = `Legal form ${JSON.stringify(supplied)} belongs to ${compatibility.suppliedJurisdiction?.toUpperCase()}, not ${jurisdiction}.${suffix}`;
  } else if (compatibility.status === 'ambiguous') {
    code = 'CLIENT_LEGAL_FORM_AMBIGUOUS';
    message = `Legal form ${JSON.stringify(supplied)} is ambiguous for ${jurisdiction}.${suffix}`;
  } else if (compatibility.status === 'jurisdiction_unsupported') {
    code = 'CLIENT_LEGAL_FORM_JURISDICTION_UNSUPPORTED';
    message = `Donna has no canonical legal-form vocabulary for jurisdiction ${jurisdiction}. Set a supported jurisdiction before creating this client.`;
  }

  const error = new Error(message);
  error.statusCode = 422;
  error.code = code;
  error.details = {
    supplied_legal_form: compatibility.supplied || null,
    jurisdiction,
    canonical_options: options,
    correction: compatibility.status === 'jurisdiction_required'
      ? 'set_jurisdiction'
      : 'choose_supported_legal_form'
  };
  return error;
};

export const canonicalizeClientLegalForm = ({
  jurisdiction,
  entityType,
  allowMissing = true
} = {}) => {
  const compatibility = legalFormCompatibility({ jurisdiction, entityType });
  if (compatibility.status === 'missing' && allowMissing) {
    return { canonical: null, compatibility };
  }
  if (compatibility.status === 'canonical' || compatibility.status === 'alias') {
    return { canonical: compatibility.canonical, compatibility };
  }
  throw errorForCompatibility(compatibility);
};

// Normalise the create profile without gratuitously changing its shape. The
// shared create writer consumes camelCase `entityType`, so it is always
// canonical; a supplied snake_case home is canonicalized too. The legacy
// profile-correction writer deliberately mirrors both homes because that is
// where a stale camelCase value may already exist.
export const canonicalizeClientProfileLegalForm = (profile = {}) => {
  const rawJurisdiction = profile?.jurisdiction;
  const jurisdiction = normalizeLegalFormJurisdiction(rawJurisdiction);
  const candidates = [profile?.entityType, profile?.entity_type]
    .filter((value) => value != null && String(value).trim() !== '');

  if (!candidates.length) {
    return {
      profile: { ...profile },
      canonical: null,
      jurisdiction: jurisdiction ? jurisdiction.toUpperCase() : null,
      compatibility: legalFormCompatibility({ jurisdiction, entityType: null })
    };
  }

  const resolved = candidates.map((entityType) =>
    canonicalizeClientLegalForm({ jurisdiction, entityType, allowMissing: false })
  );
  const canonical = resolved[0].canonical;
  if (resolved.some((entry) => entry.canonical !== canonical)) {
    const error = new Error('Client profile contains conflicting legal-form values. Choose one supported legal form and retry.');
    error.statusCode = 422;
    error.code = 'CLIENT_LEGAL_FORM_CONFLICT';
    error.details = {
      supplied_legal_forms: candidates.map(String),
      jurisdiction: jurisdiction?.toUpperCase() || null,
      canonical_options: resolved[0].compatibility.options || [],
      correction: 'choose_supported_legal_form'
    };
    throw error;
  }

  return {
    profile: {
      ...profile,
      jurisdiction: jurisdiction.toUpperCase(),
      entityType: canonical,
      ...(Object.prototype.hasOwnProperty.call(profile, 'entity_type')
        ? { entity_type: canonical }
        : {})
    },
    canonical,
    jurisdiction: jurisdiction.toUpperCase(),
    compatibility: resolved[0].compatibility
  };
};

export const canonicalizeClientProfilePatchLegalForm = ({ jurisdiction, value } = {}) =>
  canonicalizeClientLegalForm({ jurisdiction, entityType: value, allowMissing: true }).canonical;
