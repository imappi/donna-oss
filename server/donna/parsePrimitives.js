import { toUtcIsoDay } from './dates.js';
export const normalizeIsoDate = (value) => {
  if (!value) return null;
  const date = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
};

export const normalizeValidIsoDate = (value) => {
  const date = normalizeIsoDate(value);
  if (!date) return null;
  // toUtcIsoDay round-trips a bare day and refuses an impossible one
  // (2026-02-30 → '', never a rolled-over March 2).
  return toUtcIsoDay(date) === date ? date : null;
};

export const normalizeIsoOrDayFirstDate = (value, { allowDayFirst = true } = {}) => {
  if (!value) return null;
  const raw = String(value).trim();
  const iso = normalizeIsoDate(raw);
  if (iso) return iso;
  if (!allowDayFirst) return null;
  const match = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
};

export const normalizeIsoCurrency = (value) => {
  const currency = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
};
