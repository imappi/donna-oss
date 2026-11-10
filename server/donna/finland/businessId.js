// The Finnish business register identifier (Y-tunnus) as an owner may type
// it — "1234567-8", "12345678", or the VAT form "FI12345678" of the same
// number — to the canonical "1234567-8", or null. The check digit is the
// existing validator (prepaymentRegister.js isValidBusinessId).
import { isValidBusinessId } from './prepaymentRegister.js';

export const canonicalFinnishBusinessId = (input) => {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  const compact = String(input).replace(/\s+/g, '').toUpperCase();
  const match = compact.match(/^(?:FI)?(\d{7})-?(\d)$/);
  if (!match) return null;
  const value = `${match[1]}-${match[2]}`;
  return isValidBusinessId(value) ? value : null;
};
