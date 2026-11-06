// Shared transport error and identity normalization; no country's field rules.
export const throwProfileBadRequest = (message, code = null, details = null) => {
  const error = new Error(message);
  error.statusCode = 400;
  if (code) error.code = code;
  if (details) error.details = details;
  throw error;
};

export const normalizeProfileJurisdiction = (value) => {
  const country = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return country === 'uk' ? 'gb' : country === 'unknown' ? '' : country;
};

export const resolveProfileWriteJurisdiction = ({ patch, stored }) => {
  // An explicit owner correction repairs the authoritative column and profile
  // through the named writer. Otherwise neither persisted home outranks a conflict.
  if (Object.prototype.hasOwnProperty.call(patch, 'jurisdiction')) return patch.jurisdiction;
  const column = normalizeProfileJurisdiction(stored?.jurisdiction);
  const profile = normalizeProfileJurisdiction(stored?.profile?.jurisdiction);
  if (column && profile && column !== profile) {
    throwProfileBadRequest('Client jurisdiction conflicts between its persisted column and profile; confirm jurisdiction before recording country-specific facts.',
      'jurisdiction_context_conflict', { column, profile });
  }
  return column || null;
};
