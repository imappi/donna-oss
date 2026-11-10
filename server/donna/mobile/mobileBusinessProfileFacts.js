// The owner-declared business profile, as data: the contract's closed request
// shape (OnboardingProfileConfirmation) checked on the server, and the stored
// facts projected back as Entity.business_profile (BusinessProfile). Pure — no
// I/O, no inference: an empty optional fact stays absent, nothing is derived.
//
// What is NOT here: legal identity. business_name is the name the owner uses
// for the business; it is compared, never stored, by this module's writer
// (mobileBusinessProfile.js explains why).
import { mobileError } from './mobileAuth.js';

// Lengths are the contract's (counted in code points, as JSON Schema does).
const OWNER_NAME_MAX = 120;
const BUSINESS_NAME_MAX = 160;
const REQUIRED_TEXT = Object.freeze({ description: 600, operating_area: 240 });
const OPTIONAL_TEXT = Object.freeze({ profession: 240, billing_basis: 240, experience: 240, business_address: 240 });
const LISTS = Object.freeze(['people_involved', 'payment_methods', 'spending_categories']);
const LIST_MAX_ITEMS = 20;
const LIST_ITEM_MAX = 120;
export const EXACT_FIELDS = Object.freeze(['owner_name', 'business_name']);

const invalid = (message) => mobileError(400, 'PROFILE_INVALID', message);
const length = (text) => [...text].length;

const text = (body, key, max, { required }) => {
  const value = body[key];
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') throw invalid(`${key} must be a string.`);
  if (length(value) > max) throw invalid(`${key} must be at most ${max} characters.`);
  return value.trim();
};

const list = (body, key) => {
  const value = body[key];
  if (!Array.isArray(value)) throw invalid(`${key} must be a list.`);
  if (value.length > LIST_MAX_ITEMS) throw invalid(`${key} may hold at most ${LIST_MAX_ITEMS} entries.`);
  return value.map((item) => {
    if (typeof item !== 'string') throw invalid(`${key} entries must be strings.`);
    if (length(item) > LIST_ITEM_MAX) throw invalid(`${key} entries must be at most ${LIST_ITEM_MAX} characters.`);
    return item.trim();
  }).filter(Boolean);
};

// The request → { ownerName, businessName, facts, confirmed }. Keys outside the
// contract's shape are not read. Throws the contract's 400 envelope.
export const parseProfileConfirmation = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('The profile must be an object.');
  for (const key of ['owner_name', 'business_name', ...Object.keys(REQUIRED_TEXT), ...LISTS, 'confirmed_exact_fields']) {
    if (!(key in body)) throw invalid(`${key} is required.`);
  }
  const confirmed = body.confirmed_exact_fields;
  if (!Array.isArray(confirmed) || confirmed.some((field) => !EXACT_FIELDS.includes(field))) {
    throw invalid('confirmed_exact_fields may name only owner_name and business_name.');
  }
  if (new Set(confirmed).size !== confirmed.length) throw invalid('confirmed_exact_fields must not repeat a field.');
  const ownerName = text(body, 'owner_name', OWNER_NAME_MAX, { required: true });
  const businessName = text(body, 'business_name', BUSINESS_NAME_MAX, { required: true });
  if (!ownerName || !businessName) throw invalid('owner_name and business_name must not be empty.');
  // The exact identity fields are saved only when the owner visibly checked them.
  if (!EXACT_FIELDS.every((field) => confirmed.includes(field))) {
    throw mobileError(400, 'PROFILE_EXACT_CONFIRMATION_REQUIRED', 'The owner and business names must be checked before saving.');
  }
  const facts = {};
  for (const [key, max] of Object.entries(REQUIRED_TEXT)) facts[key] = text(body, key, max, { required: true });
  for (const [key, max] of Object.entries(OPTIONAL_TEXT)) {
    const value = text(body, key, max, { required: false });
    if (value) facts[key] = value; // empty optional facts are absent, never ''
  }
  for (const key of LISTS) facts[key] = list(body, key);
  return { ownerName, businessName, facts, confirmed: [...EXACT_FIELDS] };
};

// Stored facts → BusinessProfile, or null when the owner has declared nothing.
// Defensive about the stored shape: a key of the wrong type is dropped, never
// coerced into a value the owner did not state.
export const projectBusinessProfile = (facts) => {
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return null;
  const out = {};
  for (const key of Object.keys(REQUIRED_TEXT)) out[key] = typeof facts[key] === 'string' ? facts[key] : '';
  for (const key of Object.keys(OPTIONAL_TEXT)) if (typeof facts[key] === 'string' && facts[key]) out[key] = facts[key];
  for (const key of LISTS) out[key] = Array.isArray(facts[key]) ? facts[key].filter((item) => typeof item === 'string') : [];
  return out;
};

// Same facts? Key order and absent-vs-missing optional keys do not matter.
export const sameFacts = (a, b) => JSON.stringify(projectBusinessProfile(a)) === JSON.stringify(projectBusinessProfile(b));

// No fact stated at all (every text empty, every list empty).
export const isEmptyFacts = (facts) => {
  const projected = projectBusinessProfile(facts);
  return !projected || Object.values(projected).every((value) => (Array.isArray(value) ? value.length === 0 : !value));
};
