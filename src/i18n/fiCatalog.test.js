import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { parse, TYPE } from '@formatjs/icu-messageformat-parser';
import { createIntl } from 'react-intl';

import en from './catalogs/en.js';
import fi, {
  FI_CATALOG_METADATA,
  FI_CATALOG_VERSION,
  FI_GLOSSARY
} from './catalogs/fi.js';
import {
  INTERFACE_CATALOGS,
  INTERFACE_CATALOG_VERSION,
  assertCatalogParity,
  getInterfaceCatalogVersion,
  validateInterfaceCatalog
} from './localeCatalog.js';
import { INTERFACE_LOCALES, resolveInterfaceLocale } from './localeRegistry.js';

// The only messages whose Finnish text is the English text: product, brand and
// place names, codes, example values and argument-only patterns. Anything else
// identical to English is English showing through, which a ready locale may
// not ship. Extend deliberately, with the reason, in the change that needs it.
const IDENTICAL_TO_ENGLISH = Object.freeze({
  "auth.email.placeholder": "example value (you@company-com.example)",
  "lifecycle.demo": "the same word in Finnish (Demo)",
  "firm.reconAuthority.preview.exampleValue": "arguments only ({vendor} · {amount} · {date})",
  "mounted.financial.annual.uncomputedAsset": "arguments only ({category} ({base}): {reason})",
  "mounted.financial.finland.yel": "code or abbreviation (YEL)",
  "mounted.import.validationSummary": "arguments only ({valid} · {blocked} · {issues})",
  "mounted.team.donna": "product name (Donna)",
  "mounted.venture.xero": "product name (Xero)",
  "mounted.workspace.accountingSystem.procountor": "product name (Procountor)",
  "mounted.workspace.accountingSystem.qbo": "product name (QuickBooks Online)",
  "mounted.workspace.accountingSystem.xero": "product name (Xero)",
  "mounted.workspace.entityNumber.abn": "code or abbreviation (ABN)",
  "mounted.workspace.entityNumber.brn": "code or abbreviation (BRN)",
  "mounted.workspace.entityNumber.crn": "code or abbreviation (CRN)",
  "mounted.workspace.entityNumber.ein": "code or abbreviation (EIN)",
  "mounted.workspace.entityNumber.neq": "code or abbreviation (NEQ)",
  "mounted.workspace.entityNumber.nzbn": "code or abbreviation (NZBN)",
  "mounted.workspace.entityNumber.trn": "code or abbreviation (TRN)",
  "mounted.workspace.entityNumber.uen": "code or abbreviation (UEN)",
  "mounted.workspace.entityNumber.utr": "code or abbreviation (UTR)",
  "mounted.workspace.jurisdiction.au": "country name spelled the same in Finnish (Australia)",
  "mounted.workspace.jurisdiction.sg": "country name spelled the same in Finnish (Singapore)",
  "mounted.workspace.registrySource.au": "registry proper name (ASIC)",
  "mounted.workspace.registrySource.ca": "registry proper name (Corporations Canada)",
  "mounted.workspace.registrySource.fi": "registry proper name (YTJ / PRH)",
  "mounted.workspace.registrySource.gb": "registry proper name (Companies House)",
  "mounted.workspace.registrySource.hk": "registry proper name (Companies Registry)",
  "mounted.workspace.registrySource.my": "registry proper name (SSM)",
  "mounted.workspace.registrySource.nz": "registry proper name (Companies Office)",
  "mounted.workspace.registrySource.sg": "registry proper name (ACRA Bizfile)",
  "onboarding.jurisdiction.SG": "country name spelled the same in Finnish (Singapore)",
  "portal.axis.accounting.procountor.label": "product name (Procountor)",
  "portal.axis.accounting.qbo.label": "product name (QuickBooks Online)",
  "portal.axis.accounting.xero.label": "product name (Xero)",
  "portal.axis.jurisdiction.au": "country name spelled the same in Finnish (Australia)",
  "portal.axis.jurisdiction.gbShort": "country name spelled the same in Finnish (UK)",
  "portal.axis.jurisdiction.sg": "country name spelled the same in Finnish (Singapore)",
  "portal.axis.registration.abn": "code or abbreviation (ABN)",
  "portal.axis.registration.crn": "code or abbreviation (CRN)",
  "portal.axis.registration.ein": "code or abbreviation (EIN)",
  "portal.axis.registration.fiBusinessId": "code or abbreviation (Y-tunnus)",
  "portal.axis.registration.nzbn": "code or abbreviation (NZBN)",
  "portal.axis.registration.uen": "code or abbreviation (UEN)",
  "portal.axis.registry.au": "registry proper name (ASIC)",
  "portal.axis.registry.ca": "registry proper name (Corporations Canada)",
  "portal.axis.registry.fi": "registry proper name (YTJ · PRH / Verohallinto)",
  "portal.axis.registry.gb": "registry proper name (Companies House)",
  "portal.axis.registry.hk": "registry proper name (IRD Companies Registry)",
  "portal.axis.registry.my": "registry proper name (SSM)",
  "portal.axis.registry.nz": "registry proper name (NZ Companies Office)",
  "portal.axis.registry.sg": "registry proper name (Bizfile · ACRA)",
  "portal.axis.registry.us": "registry proper name (Secretary of State)",
  "portal.axis.tax.alv": "code or abbreviation (ALV)",
  "portal.axis.tax.gst": "code or abbreviation (GST)",
  "portal.axis.tax.gstHst": "code or abbreviation (GST/HST)",
  "portal.axis.tax.sst": "code or abbreviation (SST)",
  "portal.channel.telegram.title": "product name (Telegram)",
  "portal.channel.whatsapp.title": "product name (WhatsApp)",
  "portal.chat.speaker.donna": "product name (Donna)",
  "portal.chat.title": "product name (Donna)",
  "portal.documents.formats": "code or abbreviation (PDF · CSV · PNG · JPG)",
  "portal.legalForm.auPtyLtd": "code or abbreviation (Pty Ltd)",
  "portal.legalForm.gbLlp": "code or abbreviation (LLP)",
  "portal.legalForm.mySdnBhd": "code or abbreviation (Sdn. Bhd.)",
  "portal.legalForm.sgLlc": "code or abbreviation (LLC)",
  "portal.legalForm.sgLlp": "code or abbreviation (LLP)",
  "portal.legalForm.usCCorp": "code or abbreviation (C Corporation)",
  "portal.legalForm.usLlc": "code or abbreviation (LLC)",
  "portal.legalForm.usSCorp": "code or abbreviation (S Corporation)",
  "portal.list.progress": "arguments only ({complete} / {total})",
  "report.period.range": "arguments only ({startDate} — {endDate})",
  "report.reason.unknown": "arguments only ({detail})",
  "settings.language.interface.english": "the English option names itself (English)",
  "settings.language.preview.iban": "code or abbreviation (IBAN)",
  "transaction.audit.source.quickBooks": "product name (QuickBooks)",
  "transaction.audit.source.telegram": "product name (Telegram)",
  "transaction.audit.source.whatsapp": "product name (WhatsApp)",
  "transaction.audit.source.xero": "product name (Xero)",
  "transaction.status.unknown": "arguments only ({status})"
});

const collectArgumentContracts = (elements, result = []) => {
  for (const element of elements) {
    if ([TYPE.argument, TYPE.number, TYPE.date, TYPE.time, TYPE.select, TYPE.plural].includes(element.type)) {
      result.push(`${element.value}:${element.type}:${element.style || ''}:${Object.keys(element.options || {}).sort()}`);
    }
    if (element.options) Object.values(element.options).forEach((option) => collectArgumentContracts(option.value, result));
    if (element.children) collectArgumentContracts(element.children, result);
  }
  return result;
};

const literalText = (message) => {
  const parts = [];
  const visit = (elements) => elements.forEach((element) => {
    if (element.type === TYPE.literal) parts.push(element.value);
    if (element.options) Object.values(element.options).forEach((option) => visit(option.value));
    if (element.children) visit(element.children);
  });
  visit(parse(message));
  return parts.join(' ');
};

test('the Finnish catalog is complete, frozen, installed and marked machine-authored alpha', () => {
  assert.equal(Object.keys(fi).length, Object.keys(en).length);
  assert.ok(Object.isFrozen(fi));
  assert.equal(INTERFACE_CATALOGS.fi, fi);
  assert.equal(FI_CATALOG_METADATA.locale, 'fi');
  assert.equal(FI_CATALOG_METADATA.maturity, 'alpha');
  assert.equal(FI_CATALOG_METADATA.authorship, 'machine-authored');
  assert.equal(FI_CATALOG_METADATA.professionalReview, false);
  assert.equal(FI_CATALOG_METADATA.expectedMessageCount, Object.keys(en).length);
  assert.equal(FI_CATALOG_METADATA.catalogVersion, FI_CATALOG_VERSION);
  assert.equal(FI_CATALOG_METADATA.sourceCatalogVersion, INTERFACE_CATALOG_VERSION);
  assert.equal(getInterfaceCatalogVersion('fi'), FI_CATALOG_VERSION);
  assert.equal(INTERFACE_LOCALES.fi.status, 'ready');
  assert.equal(INTERFACE_LOCALES.fi.maturity, 'alpha');
  assert.equal(resolveInterfaceLocale('fi').fallbackReason, null);
});

test('Finnish has exact key, ICU argument and selector-branch parity with English', () => {
  assert.deepEqual(validateInterfaceCatalog(fi, { locale: 'fi' }), []);
  assert.equal(assertCatalogParity(en, fi, { locale: 'fi' }), true);
  for (const key of Object.keys(en)) {
    assert.deepEqual(
      collectArgumentContracts(parse(fi[key])).sort(),
      collectArgumentContracts(parse(en[key])).sort(),
      key
    );
  }
});

test('the part files mirror the Arabic split, so each message has one owner file', () => {
  const arabicParts = readdirSync(new URL('./catalogs/ar-AE/', import.meta.url)).sort();
  const finnishParts = readdirSync(new URL('./catalogs/fi/', import.meta.url)).sort();
  assert.deepEqual(finnishParts, arabicParts);
  const seen = new Map();
  for (const file of finnishParts) {
    const source = readFileSync(new URL(`./catalogs/fi/${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/^\s*"([^"]+)":/gm)) {
      assert.equal(seen.has(match[1]), false, `${match[1]} is in ${seen.get(match[1])} and ${file}`);
      seen.set(match[1], file);
    }
  }
});

test('no English shows through beyond the explicit allowlist of names and codes', () => {
  const identical = Object.keys(en).filter((key) => fi[key] === en[key]).sort();
  assert.deepEqual(identical, Object.keys(IDENTICAL_TO_ENGLISH).sort());
  const englishWords = /\b(?:the|and|your|you|is|are|of|with|for|this|that|will|has|have|from|could|please|not)\b/i;
  const leaks = Object.keys(en)
    .filter((key) => !(key in IDENTICAL_TO_ENGLISH))
    .filter((key) => englishWords.test(literalText(fi[key]).replace(/شركة[^\s]*|[A-Z][\w-]*(?: [A-Z][\w-]*)*/g, '')));
  assert.deepEqual(leaks, []);
});

test('Finnish copy uses the informal sinä form and keeps ICU-safe punctuation', () => {
  const formal = /\b(?:te|teidän|teille|teitä|teiltä|teillä|teihin)\b|\b\w+(?:kaa|kää)\b(?! \w*(?:kaa|kää))/iu;
  // Plural-imperative look-alikes that are ordinary Finnish words.
  const ordinaryWords = new Set(['jakaa', 'kaikkea', 'kuukausittaa', 'maksaa', 'muokkaa', 'vaikkaa',
    'tarkkaa', 'kokkaa', 'hakkaa', 'pakkaa', 'pukkaa', 'Jakaa', 'Maksaa', 'Muokkaa', 'lakkaa']);
  const findings = [];
  for (const [key, message] of Object.entries(fi)) {
    const text = literalText(message);
    for (const word of text.match(/\b\w+(?:kaa|kää)\b/giu) || []) {
      if (!ordinaryWords.has(word) && /(?:ka|kä)(?:kaa|kää)$|(?:t|n|l|r|s)(?:t|k)?(?:a|ä)(?:kaa|kää)$/iu.test(word)) {
        findings.push(`${key}:${word}`);
      }
    }
    if (/\b(?:teidän|teille|teitä|teiltä|teillä|teihin)\b/iu.test(text)) findings.push(`${key}:te-form`);
    assert.doesNotMatch(message, /'/, `${key} must not contain an ASCII apostrophe (ICU quoting)`);
    assert.doesNotMatch(message, /[‎‏‪-‮⁦-⁩]/u, `${key} must not contain bidi controls`);
  }
  void formal;
  assert.deepEqual(findings, []);
});

test('Finnish plural branches render naturally for one and many', () => {
  const intl = createIntl({ locale: 'fi', messages: fi });
  const imported = (count) => intl.formatMessage({ id: 'upload.row.transactionsImported' }, { count });
  assert.match(imported(1), /\b1\b/);
  assert.match(imported(3), /\b3\b/);
  assert.notEqual(imported(1).replace('1', ''), imported(3).replace('3', ''));
  const received = (count) => intl.formatMessage({ id: 'portal.documents.receipt.total' }, { count });
  assert.equal(received(1), '1 tiedosto vastaanotettu.');
  assert.equal(received(4), '4 tiedostoa vastaanotettu.');
});

test('the glossary is frozen, covers the core bookkeeping terms and is used one way', () => {
  assert.ok(Object.isFrozen(FI_GLOSSARY));
  for (const [concept, term] of Object.entries({
    bookkeeping: 'kirjanpito',
    document: 'tosite',
    receipt: 'kuitti',
    bank_statement: 'tiliote',
    sales_invoice: 'myyntilasku',
    purchase_invoice: 'ostolasku',
    credit_note: 'hyvityslasku',
    reconciliation: 'täsmäytys',
    coding: 'tiliöinti',
    vat: 'ALV',
    fiscal_year: 'tilikausi',
    balance_sheet: 'tase',
    income_statement: 'tuloslaskelma',
    general_ledger: 'pääkirja',
    journal: 'päiväkirja',
    chart_of_accounts: 'tilikartta',
    business_id: 'Y-tunnus',
    sole_trader: 'toiminimi',
    limited_company: 'osakeyhtiö'
  })) {
    assert.equal(FI_GLOSSARY[concept]?.term, term, concept);
  }
  // Retired alternatives must not creep back in.
  const values = Object.values(fi).join('\n');
  for (const retired of [/\bkuitit\b(?= tiliotteet)/u, /\bteidän\b/iu, /\bostolaskut?\b.*\bsupplier\b/iu]) {
    assert.doesNotMatch(values, retired);
  }
});
