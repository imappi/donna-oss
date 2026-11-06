import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import * as firmDb from './firmDb.js';
import { createStatutoryRegistry, resolveStatutoryHandler, STATUTORY_REGISTRY } from './statutoryRegistry.js';
import { createStatutoryObligationRegistry, STATUTORY_OBLIGATION_BINDINGS } from './statutoryObligationRegistry.js';
import { runStatutoryObligationSweep } from './outbound/statutoryObligations.js';
import { loadOutboundPack } from './outbound/packs.js';
import * as blockerStore from './statutoryBlocker.js';
import * as finlandBlocker from './finland/statutoryBlocker.js';

const PUBLIC_STATUTORY_API = [
  "getFinlandAnnualReturnFromDb",
  "getFinlandCutoverPackFromDb",
  "getFinlandAlvReturnFromDb",
  "getSingaporeGstReturnFromDb",
  "getFinlandAlvThresholdWatchFromDb",
  "drainFinlandAlvThresholdEscalations",
  "drainGbVatThresholdEscalations",
  "drainAeVatThresholdEscalations",
  "drainAeVatReturnDeadlineEscalations",
  "drainAeCtRegistrationEscalations",
  "drainAeVatRegistrationEscalations",
  "deliverPendingFinlandScopeDriftAsks",
  "getFinlandScopeDriftFromDb",
  "getFinlandOyOnboardingStateFromDb",
  "getFinlandOyYelApplicabilityFromDb",
  "getFinlandOyBalanceSheetWatchesFromDb",
  "getFinlandOyMonthlyCloseFromDb",
  "getGbLtdMonthlyCloseFromDb",
  "getFinlandYelStatusFromDb",
  "getFinlandEnnakkoveroStatusFromDb",
  "__recordPrepaymentRegisterCheckWithClient",
  "recordPrepaymentRegisterCheckInDb",
  "getFinlandPrepaymentRegisterFromDb",
  "getFinlandScopeDriftFilingGateFromDb",
  "finlandAlvFilingWhatsAppFlagActsInDb",
  "createAlvReturnEvidenceRequestInDb",
  "__createAlvReturnDraftWithClient",
  "createAlvReturnDraftInDb",
  "__cancelAlvReturnWithClient",
  "cancelAlvReturnInDb",
  "__markAlvReturnFiledWithClient",
  "markAlvReturnFiledInDb",
  "getAlvReturnByIdInDb",
  "getAlvReturnForPeriodInDb",
  "__recordSuomifiMandateWithClient",
  "recordSuomifiMandateInDb",
  "__revokeSuomifiMandateWithClient",
  "revokeSuomifiMandateInDb",
  "getActiveSuomifiMandateInDb",
  "getSuomifiMandateStatusInDb",
  "startFinlandAlvReturnFilingInDb",
  "singaporeGstFilingFlagActsInDb",
  "createGstReturnEvidenceRequestInDb",
  "__createGstReturnDraftWithClient",
  "createGstReturnDraftInDb",
  "__cancelGstReturnWithClient",
  "cancelGstReturnInDb",
  "__markGstReturnFiledWithClient",
  "markGstReturnFiledInDb",
  "getGstReturnByIdInDb",
  "getGstReturnForPeriodInDb",
  "__recordCorpPassMandateWithClient",
  "recordCorpPassMandateInDb",
  "__revokeCorpPassMandateWithClient",
  "revokeCorpPassMandateInDb",
  "getActiveCorpPassMandateInDb",
  "getCorpPassMandateStatusInDb",
  "startSingaporeGstReturnFilingInDb",
  "getSingaporeFilerContextInDb"
];

test('all historical statutory exports retain the registered country function identity', () => {
  const exports = Object.entries(STATUTORY_REGISTRY).flatMap(([jurisdiction, handlers]) =>
    Object.entries(handlers).map(([operation, handler]) => ({ jurisdiction, operation, handler })));
  assert.deepEqual(exports.filter(({ operation }) => PUBLIC_STATUTORY_API.includes(operation)).map(({ operation }) => operation).sort(), [...PUBLIC_STATUTORY_API].sort());
  for (const { jurisdiction, operation, handler } of exports) {
    if (PUBLIC_STATUTORY_API.includes(operation)) assert.equal(firmDb[operation], handler, operation);
    if (Object.hasOwn(firmDb, operation)) assert.equal(firmDb[operation], handler, operation);
    assert.equal(resolveStatutoryHandler({ jurisdiction, operation }), handler);
  }
  assert.equal(resolveStatutoryHandler({ jurisdiction: 'UK', operation: 'getGbLtdMonthlyCloseFromDb' }), firmDb.getGbLtdMonthlyCloseFromDb);
});

test('registry never turns missing, unsupported, or coding-only country support into a statutory handler', () => {
  for (const jurisdiction of [null, '', 'unknown']) {
    assert.throws(() => resolveStatutoryHandler({ jurisdiction, operation: 'getSingaporeGstReturnFromDb' }), { code: 'statutory_jurisdiction_unresolved' });
  }
  for (const jurisdiction of ['us', 'au', 'nz']) {
    assert.throws(() => resolveStatutoryHandler({ jurisdiction, operation: 'getSingaporeGstReturnFromDb' }), { code: 'statutory_jurisdiction_unsupported' });
  }
  assert.throws(() => resolveStatutoryHandler({ jurisdiction: 'fi', operation: 'getSingaporeGstReturnFromDb' }), { code: 'statutory_operation_unsupported' });
  assert.throws(() => resolveStatutoryHandler({ jurisdiction: 'gb', operation: 'toString' }), { code: 'statutory_operation_unsupported' });
});

test('an additional registered country and duty run through the unchanged handler resolution and sweep', async () => {
  const receipt = Object.freeze({ country: 'nz', source: 'fixture', completed: 1 });
  const run = async () => receipt;
  const registry = createStatutoryRegistry({ nz: { computeReturn: run } });
  assert.equal(await resolveStatutoryHandler({ jurisdiction: 'NZ', operation: 'computeReturn', registry })(), receipt);
  const bindings = createStatutoryObligationRegistry([{ nz_fixture: { run } }]);
  const pack = structuredClone(loadOutboundPack('fi'));
  pack.obligations.items = [{ ...pack.obligations.items[0], id: 'nz_fixture', binding: 'nz_fixture' }];
  const result = await runStatutoryObligationSweep({ packIds: ['nz'], bindings, loadPack: () => pack });
  assert.equal(result.ran, 1);
  assert.equal(result.errors, 0);
  assert.equal(result.obligations[0].summary, receipt);
  assert.equal(result.obligations[0].packId, 'nz');
  assert.throws(() => createStatutoryObligationRegistry([{ duplicate: { run } }, { duplicate: { run } }]), /duplicate/);
  assert.throws(() => createStatutoryObligationRegistry([{ malformed: { run: null } }]), /Invalid/);
  assert.throws(() => createStatutoryRegistry({ unknown: {} }), /canonical country/);
  assert.equal(STATUTORY_OBLIGATION_BINDINGS.ae_vat_registration_escalation.hourly, true);
});

test('country modules and compatibility entry points load in either direction of the existing import cycle', () => {
  for (const entry of ['./finland/statutoryDb.js', './gb/statutoryDb.js', './ae/statutoryDb.js', './singapore/statutoryDb.js', './statutoryRegistry.js']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL(entry, import.meta.url).href)});`], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('retired Finnish blocker shims are absent and country policy stays owned', () => {
  for (const name of Object.keys(blockerStore)) assert.equal(Object.hasOwn(finlandBlocker, name), false, name);
  assert.equal(Object.hasOwn(blockerStore, 'mintForm5OyQuarantineBlocker'), false, 'Finnish form-5 quarantine stays country-owned');
  assert.equal(Object.hasOwn(blockerStore, 'FORM5_OY_UNSUPPORTED_RESOLUTION_PATH'), false);
  assert.equal(Object.hasOwn(blockerStore, 'KNOWN_BLOCKER_REASON_CODES'), false);
});
