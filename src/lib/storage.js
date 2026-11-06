import { DEFAULT_MODEL } from './constants.js';

export const loadFromStorage = (key, fallback) => {
  try {
    const stored = localStorage.getItem(key);
    if (!stored) return fallback;
    return JSON.parse(stored);
  } catch {
    return fallback;
  }
};

export const readStoredValue = (key) => {
  try {
    const stored = localStorage.getItem(key);
    if (!stored) return undefined;
    return JSON.parse(stored);
  } catch {
    return undefined;
  }
};

export const saveToStorage = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore storage errors
  }
};

export const removeFromStorage = (key) => {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore storage errors
  }
};

export const replaceStorage = (key, value) => {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
  saveToStorage(key, value);
};

export const normalizeModelName = (value, fallback = DEFAULT_MODEL) => {
  const normalized = String(value || '').trim();
  return normalized || fallback;
};

export const createLogId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};
