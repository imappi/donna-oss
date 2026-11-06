import { parse, TYPE } from '@formatjs/icu-messageformat-parser';

import en from './catalogs/en.js';
import arAE, { AR_AE_CATALOG_VERSION } from './catalogs/ar-AE.js';

export const INTERFACE_CATALOG_VERSION = AR_AE_CATALOG_VERSION;

const PSEUDO_CHARS = Object.freeze({
  a: 'á', b: 'ƀ', c: 'ç', d: 'đ', e: 'ë', f: 'ƒ', g: 'ğ', h: 'ħ', i: 'ï',
  j: 'ĵ', k: 'ķ', l: 'ľ', m: 'ɱ', n: 'ñ', o: 'ö', p: 'þ', q: 'ɋ', r: 'ř',
  s: 'š', t: 'ŧ', u: 'ü', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ÿ', z: 'ž'
});

const pseudoCharacter = (character) => {
  const lower = character.toLowerCase();
  const mapped = PSEUDO_CHARS[lower];
  if (!mapped) return character;
  const cased = character === lower ? mapped : mapped.toUpperCase();
  return /[aeiou]/i.test(character) ? `${cased}${cased}` : cased;
};

const matchingBrace = (message, start) => {
  let depth = 0;
  for (let index = start; index < message.length; index += 1) {
    if (message[index] === '{') depth += 1;
    if (message[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

const topLevelCommas = (content) => {
  const commas = [];
  let depth = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '{') depth += 1;
    else if (content[index] === '}') depth = Math.max(0, depth - 1);
    else if (content[index] === ',' && depth === 0) commas.push(index);
  }
  return commas;
};

const pseudoLocalizeSegment = (message) => {
  let transformed = '';
  for (let index = 0; index < message.length; index += 1) {
    if (message[index] !== '{') {
      transformed += pseudoCharacter(message[index]);
      continue;
    }

    const end = matchingBrace(message, index);
    if (end < 0) {
      transformed += message.slice(index);
      break;
    }
    const content = message.slice(index + 1, end);
    const commas = topLevelCommas(content);
    const argumentType = commas.length > 1
      ? content.slice(commas[0] + 1, commas[1]).trim()
      : '';
    if (!['plural', 'selectordinal', 'select'].includes(argumentType)) {
      transformed += `{${content}}`;
      index = end;
      continue;
    }

    const optionsStart = commas[1] + 1;
    const optionSource = content.slice(optionsStart);
    let options = '';
    for (let optionIndex = 0; optionIndex < optionSource.length; optionIndex += 1) {
      if (optionSource[optionIndex] !== '{') {
        options += optionSource[optionIndex];
        continue;
      }
      const optionEnd = matchingBrace(optionSource, optionIndex);
      if (optionEnd < 0) {
        options += optionSource.slice(optionIndex);
        break;
      }
      options += `{${pseudoLocalizeSegment(optionSource.slice(optionIndex + 1, optionEnd))}}`;
      optionIndex = optionEnd;
    }
    transformed += `{${content.slice(0, optionsStart)}${options}}`;
    index = end;
  }
  return transformed;
};

// Preserve ICU argument names and grammar while expanding every user-facing
// literal, including text nested inside plural/select options. A pseudo locale
// that leaves English inside a plural hides exactly the catalog gap it exists
// to expose.
export const pseudoLocalizeMessage = (message) =>
  `⟦ ${pseudoLocalizeSegment(String(message))} ـــ ⟧`;

export const buildPseudoCatalog = (source) => Object.freeze(
  Object.fromEntries(
    Object.entries(source).map(([key, message]) => [key, pseudoLocalizeMessage(message)])
  )
);

const arXB = buildPseudoCatalog(en);

export const INTERFACE_CATALOGS = Object.freeze({
  en,
  'ar-AE': arAE,
  'ar-XB': arXB
});

const collectArguments = (elements, result = new Set()) => {
  for (const element of elements) {
    if ([TYPE.argument, TYPE.number, TYPE.date, TYPE.time, TYPE.select, TYPE.plural]
      .includes(element.type)) {
      result.add(element.value);
    }
    if (element.options) {
      Object.values(element.options).forEach((option) => collectArguments(option.value, result));
    }
    if (element.children) collectArguments(element.children, result);
  }
  return result;
};

const argumentTypeName = (type) => Object.entries(TYPE)
  .find(([, value]) => value === type)?.[0] || String(type);

const collectArgumentContracts = (elements, result = []) => {
  for (const element of elements) {
    if ([TYPE.argument, TYPE.number, TYPE.date, TYPE.time, TYPE.select, TYPE.plural]
      .includes(element.type)) {
      result.push(JSON.stringify({
        argument: element.value,
        type: argumentTypeName(element.type),
        ...(element.style ? { style: element.style } : {}),
        ...(element.options ? { branches: Object.keys(element.options).sort() } : {}),
        ...(element.offset ? { offset: element.offset } : {}),
        ...(element.pluralType ? { pluralType: element.pluralType } : {})
      }));
    }
    if (element.options) {
      Object.values(element.options)
        .forEach((option) => collectArgumentContracts(option.value, result));
    }
    if (element.children) collectArgumentContracts(element.children, result);
  }
  return result;
};

export const validateInterfaceCatalog = (catalog, { locale = 'unknown' } = {}) => {
  const errors = [];
  for (const [key, message] of Object.entries(catalog || {})) {
    if (!String(message || '').trim()) {
      errors.push(`${locale}:${key}:empty`);
      continue;
    }
    try {
      parse(message);
    } catch (error) {
      errors.push(`${locale}:${key}:${error.message}`);
    }
  }
  return errors;
};

export const assertCatalogParity = (source, candidate, { locale = 'unknown' } = {}) => {
  const sourceKeys = Object.keys(source).sort();
  const candidateKeys = Object.keys(candidate).sort();
  if (JSON.stringify(sourceKeys) !== JSON.stringify(candidateKeys)) {
    throw new Error(`Interface catalog key mismatch for ${locale}`);
  }

  const syntaxErrors = validateInterfaceCatalog(candidate, { locale });
  if (syntaxErrors.length) throw new Error(syntaxErrors.join('\n'));

  for (const key of sourceKeys) {
    const sourceArguments = [...collectArguments(parse(source[key]))].sort();
    const candidateArguments = [...collectArguments(parse(candidate[key]))].sort();
    if (JSON.stringify(sourceArguments) !== JSON.stringify(candidateArguments)) {
      throw new Error(`Interface catalog placeholder mismatch for ${locale}:${key}`);
    }

    const sourceContracts = collectArgumentContracts(parse(source[key])).sort();
    const candidateContracts = collectArgumentContracts(parse(candidate[key])).sort();
    if (JSON.stringify(sourceContracts) !== JSON.stringify(candidateContracts)) {
      throw new Error(`Interface catalog ICU argument structure mismatch for ${locale}:${key}`);
    }
  }
  return true;
};

assertCatalogParity(en, arXB, { locale: 'ar-XB' });
assertCatalogParity(en, arAE, { locale: 'ar-AE' });

export const getInterfaceCatalog = (locale) => INTERFACE_CATALOGS[locale] || null;
