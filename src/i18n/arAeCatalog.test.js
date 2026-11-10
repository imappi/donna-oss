import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse, TYPE } from '@formatjs/icu-messageformat-parser';
import { createIntl } from 'react-intl';

import en from './catalogs/en.js';
import arAE, {
  AR_AE_ARGUMENT_BIDI,
  AR_AE_CATALOG_METADATA,
  AR_AE_CATALOG_VERSION,
  AR_AE_GLOSSARY,
  AR_AE_NAMESPACE_CONTEXT
} from './catalogs/ar-AE.js';
import {
  INTERFACE_CATALOGS,
  assertCatalogParity,
  validateInterfaceCatalog
} from './localeCatalog.js';
import { INTERFACE_LOCALES, resolveInterfaceLocale } from './localeRegistry.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');

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

const intentionalCanonicalValues = new Set([
  'settings.language.interface.english',
  'settings.language.preview.iban',
  'auth.email.placeholder',
  'auth.language.englishShort',
  'portal.list.progress',
  'portal.list.groupPrimary',
  'transaction.status.unknown',
  'transaction.audit.source.whatsapp',
  'transaction.audit.source.telegram',
  'transaction.audit.source.xero',
  'transaction.audit.source.quickBooks',
  'report.period.range',
  'report.reason.unknown',
  'portal.file.size.zero',
  'portal.file.size.kilobytes',
  'portal.file.size.megabytes',
  'portal.channel.whatsapp.title',
  'portal.channel.telegram.title',
  'portal.documents.formats',
  'portal.axis.accounting.xero.label',
  'portal.axis.accounting.qbo.label',
  'portal.axis.accounting.procountor.label',
  'portal.axis.jurisdiction.gbShort',
  'portal.axis.jurisdiction.aeShort',
  'portal.axis.registration.uen',
  'portal.axis.registration.ein',
  'portal.axis.registration.crn',
  'portal.axis.registration.abn',
  'portal.axis.registration.nzbn',
  'portal.axis.registration.fiBusinessId',
  'portal.axis.registry.sg',
  'portal.axis.registry.us',
  'portal.axis.registry.gb',
  'portal.axis.registry.hk',
  'portal.axis.registry.au',
  'portal.axis.registry.nz',
  'portal.axis.registry.my',
  'portal.axis.registry.ca',
  'portal.axis.registry.fi',
  'portal.axis.tax.gst',
  'portal.axis.tax.sst',
  'portal.axis.tax.gstHst',
  'portal.axis.tax.alv'
]);

// 2,341 at AR-3B; 2,345 after RT-10 added four `upload.row.*` messages to both
// catalogs (catalog version .2); 2,346 after RT-09 added `firm.readiness.waitingForHost`
// (version .3); JN wave 2 adds six owner jurisdiction setup messages.
// JN corrections add the document currency confirmation cue in both catalogs.
// U01 adds fourteen accounting view/method setup messages (2,388 total).
// Snapshot availability adds five messages (2,393 total).
// Initial Finnish owner intake adds twelve messages (2,570 total).
// Self-service firm signup adds two web onboarding messages (2,572 total).
// Scoped no-settlement assessment adds three lifecycle labels (2,575 total).
// Refused-upload tray states add three row labels (2,578 total).
// Pilot send-containment release adds seventeen operator messages (2,595 total).
// FI profile first fill after birth preparation adds one form notice (2,596 total).
// Verdict-first activity pills add fifteen working-phase and batch-summary labels (2,611 total).
// SG native intake adds five explicit processing-scope fact labels (2,626 total).
// The portal's answered-questions notice adds one heading (2,868 total).
// A firm member's ledger adjustment question adds four Mentions-lane lines (2,876 total).
// Re-pin deliberately, in the same change as the keys.
test('AR-3A plus AR-3B install one immutable 2,621-message Alpha catalog for AR-3C activation', () => {
  assert.equal(AR_AE_CATALOG_VERSION, '2026-09-28.sg-native-intake.1');
  assert.equal(Object.keys(en).length, 2876);
  assert.equal(Object.keys(arAE).length, 2876);
  assert.equal(AR_AE_CATALOG_METADATA.expectedMessageCount, 2876);
  assert.equal(AR_AE_CATALOG_METADATA.maturity, 'alpha');
  assert.equal(AR_AE_CATALOG_METADATA.displayLabel, 'العربية · إصدار تجريبي');
  assert.equal(AR_AE_CATALOG_METADATA.authorship, 'machine-authored');
  assert.equal(AR_AE_CATALOG_METADATA.nativeReview, false);
  assert.equal(AR_AE_CATALOG_METADATA.certification, false);
  assert.equal(AR_AE_CATALOG_METADATA.regulatorApproval, false);
  assert.ok(Object.isFrozen(arAE));
  assert.equal(INTERFACE_CATALOGS['ar-AE'], arAE);
  assert.equal(INTERFACE_LOCALES['ar-AE'].status, 'ready');
  assert.equal(resolveInterfaceLocale('ar-AE').locale, 'ar-AE');
  assert.equal(resolveInterfaceLocale('ar-AE').fallbackReason, null);
});

test('Arabic has exact key, ICU argument and selector-branch parity with English', () => {
  assert.deepEqual(validateInterfaceCatalog(arAE, { locale: 'ar-AE' }), []);
  assert.equal(assertCatalogParity(en, arAE, { locale: 'ar-AE' }), true);
});

test('every namespace and ICU argument has deterministic correction and bidi context', () => {
  const namespaces = [...new Set(Object.keys(en).map((key) => key.split('.')[0]))].sort();
  assert.deepEqual(Object.keys(AR_AE_NAMESPACE_CONTEXT).sort(), namespaces);

  const argumentsInCatalog = new Set();
  Object.values(en).forEach((message) => collectArguments(parse(message), argumentsInCatalog));
  assert.deepEqual(Object.keys(AR_AE_ARGUMENT_BIDI).sort(), [...argumentsInCatalog].sort());
  assert.ok(Object.values(AR_AE_ARGUMENT_BIDI).every((mode) => (
    mode === 'auto' || mode === 'ltr' || mode === 'formatted'
  )));
  assert.equal(AR_AE_ARGUMENT_BIDI.filename, 'auto');
  assert.equal(AR_AE_ARGUMENT_BIDI.clientName, 'auto');
  assert.equal(AR_AE_ARGUMENT_BIDI.email, 'ltr');
  assert.equal(AR_AE_ARGUMENT_BIDI.code, 'ltr');
  assert.equal(AR_AE_ARGUMENT_BIDI.currency, 'ltr');
  assert.equal(AR_AE_ARGUMENT_BIDI.amount, 'formatted');
  assert.equal(AR_AE_ARGUMENT_BIDI.date, 'formatted');
});

test('catalog contains no pseudo-locale reuse, hidden English fallback or bidi controls', () => {
  const identical = Object.keys(en).filter((key) => en[key] === arAE[key]).sort();
  assert.deepEqual(identical, [...intentionalCanonicalValues].sort());

  for (const [key, message] of Object.entries(arAE)) {
    assert.doesNotMatch(message, /[⟦⟧]|[áƀçđëƒğħïĵķľɱñöþɋřšŧüṽŵẋÿž]/iu, key);
    assert.doesNotMatch(message, /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u, key);
    if (!intentionalCanonicalValues.has(key)) {
      assert.match(message, /\p{Script=Arabic}/u, `${key} must contain authored Arabic`);
      assert.notEqual(message, en[key], `${key} must not fall back to English`);
    }
  }
});

test('representative Arabic plural and select branches execute as valid ICU', () => {
  const selector = '{state, select, ready {جاهز} blocked {محظور} other {غير معروف}}';
  const intl = createIntl({
    locale: 'ar-AE',
    messages: {
      imported: arAE['upload.row.transactionsImported'],
      selector
    }
  });

  assert.equal(intl.formatMessage({ id: 'imported' }, { count: 1 }), 'استُوردت معاملة واحدة');
  assert.equal(intl.formatMessage({ id: 'imported' }, { count: 3 }), 'استُوردت 3 معاملات');
  assert.equal(intl.formatMessage({ id: 'selector' }, { state: 'ready' }), 'جاهز');
  assert.equal(intl.formatMessage({ id: 'selector' }, { state: 'blocked' }), 'محظور');
  assert.equal(intl.formatMessage({ id: 'selector' }, { state: 'unexpected' }), 'غير معروف');
  assert.deepEqual(validateInterfaceCatalog({ selector }, { locale: 'ar-AE-select' }), []);
});

test('the frozen glossary preserves official versus proposed terminology status', () => {
  assert.deepEqual(AR_AE_GLOSSARY.trial_balance, {
    term: 'ميزان المراجعة',
    status: 'official_mof',
    source: 'AR-4F:S5'
  });
  assert.equal(AR_AE_GLOSSARY.input_vat.status, 'official_fta_mof');
  assert.equal(AR_AE_GLOSSARY.tax_invoice.status, 'official_fta_statutory_title');
  assert.equal(AR_AE_GLOSSARY.reconciliation.status, 'proposed_product');
  assert.equal(AR_AE_GLOSSARY.owner_decision.status, 'proposed_product');
  assert.equal(AR_AE_GLOSSARY.receipt.term, 'إيصال / سجل إثبات');
});

// The pre-AR-3B pin moved at RT-10 (four tray keys) and at RT-09 (one readiness
// card key, `firm.readiness.waitingForHost`) and for the three refused-upload
// tray labels (2026-09-23) and for the fifteen verdict-first working-phase and
// batch-summary labels (2026-09-23) and for the FI-05 customer-failure
// projection (2026-10-15: eleven `upload.failure.*`, four
// `operator.providerFailure.customer.*` messages, six retired raw-reason
// tray labels); any later English change outside
// `mounted.*` re-pins it in the commit that makes it. The mounted source pin
// moved for the retired owner checkout (2026-10-21: three `mounted.billing.*`
// strings now say the accounting firm gives access) and for the pilot send
// release (2026-11-09: five `mounted.settings.cloudPilot.send.*` strings name
// the owner channels a release switches on; `send.effect` reworded).
// 2026-11-10: the remainingSurfaces.en.js source pin did not match the file
// already on main (the file is unchanged here) and #49's 32 messages had not
// re-pinned the pre-AR-3B hash; both re-pinned with the 133 interface-value
// and owner-access messages of the follow-up to #49.
// 2026-11-10: re-pinned for `portal.answered.title`, the heading of the
// portal's answered questions (what Donna did with the owner's answers).
// 2026-11-10: mounted source re-pinned for the two firm-view lines that name a
// document's stored provider wait (`mounted.financial.waitingProviderKey`,
// `mounted.financial.waitingProvider`, and the refused-key and no-credit lines `mounted.financial.waitingProviderKeyRefused`, `mounted.financial.waitingProviderCredit`).
// 2026-11-10: mounted source re-pinned for the four Mentions-lane lines of a
// firm member's ledger adjustment question (`mounted.financial.ledgerAdjustmentAsk.*`).
test('the pre-AR-3B English catalog semantics are pinned and the mounted source is pinned', () => {
  const remainingSource = readFileSync(new URL('./catalogs/remainingSurfaces.en.js', import.meta.url));
  const mountedSource = readFileSync(new URL('./catalogs/mountedSurfaces.en.js', import.meta.url));
  const preAr3bEn = Object.fromEntries(
    Object.entries(en).filter(([key]) => !key.startsWith('mounted.'))
  );
  assert.equal(hash(remainingSource), '327d38f3bac59683faa61e2fc4dc7d127339bf9f1b954f567f02116ef931b488');
  assert.equal(hash(mountedSource), '04862a16906925b313f0c86d833c07dca174c5d92f92f7165963f89a3d019056');
  assert.equal(hash(JSON.stringify(preAr3bEn)), '0262e7da2a8812f88961ab199f15555775c7b30b59d0115dfadf147b0baec4ef');
});

test('native intake authority and scope copy uses exact Arabic phrases rather than lexical fallback', () => {
  assert.equal(arAE['mounted.venture.processingTitle'], 'معالجة المستندات ومراجعتها');
  assert.equal(arAE['mounted.venture.bookkeepingStart'], 'تاريخ بدء مسك الدفاتر');
  assert.match(arAE['mounted.venture.processingLimit'], /ترحيل القيود المحاسبية غير متاح/);
  assert.match(arAE['mounted.venture.processingConfirm'], /الدولار السنغافوري/);
  assert.match(arAE['mounted.venture.processingGstUnknown'], /ملف Bizfile وحده لا يؤكدها/);
});
