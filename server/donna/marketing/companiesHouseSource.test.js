// Companies House source modules — unit coverage: URL building (incl. the
// first-filing incorporation window), auth header, live-shape assertions,
// per-mode profile evaluation off the CANONICAL accounts.next_accounts block,
// the PECR type allowlist, and the paced scan loop with mocked fetch.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CH_SOURCE_BY_MODE,
  assertSearchShape,
  buildAdvancedSearchUrl,
  buildProfileUrl,
  chAuthHeader,
  evaluateProfile,
  runCompaniesHouseScan
} from './companiesHouseSource.js';

const NOW = new Date('2026-07-06T12:00:00Z');

const PROFILE = {
  company_name: 'Acme Design Ltd',
  company_number: '12345678',
  company_status: 'active',
  type: 'ltd',
  date_of_creation: '2025-08-15',
  accounts: {
    next_accounts: { overdue: true, due_on: '2026-05-31', period_start_on: '2025-01-01', period_end_on: '2025-12-31' }
  }
};

test('auth header is HTTP Basic with the key as username', () => {
  assert.equal(chAuthHeader('my-key'), `Basic ${Buffer.from('my-key:').toString('base64')}`);
});

test('advanced-search URL: overdue mode filters active + SIC only', () => {
  const url = new URL(buildAdvancedSearchUrl({ mode: 'overdue', sicCodes: ['70229', '73110'], now: NOW }));
  assert.equal(url.origin + url.pathname, 'https://api.company-information.service.gov.uk/advanced-search/companies');
  assert.equal(url.searchParams.get('company_status'), 'active');
  assert.equal(url.searchParams.get('sic_codes'), '70229,73110');
  assert.equal(url.searchParams.get('incorporated_from'), null);
});

test('advanced-search URL: first-filing mode carries the 8-14 month incorporation window', () => {
  const url = new URL(buildAdvancedSearchUrl({ mode: 'first_filing', sicCodes: ['70229'], now: NOW }));
  assert.equal(url.searchParams.get('incorporated_from'), '2025-05-06');
  assert.equal(url.searchParams.get('incorporated_to'), '2025-11-06');
});

test('search shape assertion refuses unknown payloads loudly', () => {
  assert.throws(() => assertSearchShape({ hits: 3 }), /live shape assertion failed/);
  assert.throws(() => assertSearchShape({ items: [{ title: 'x' }] }), /company_number/);
  assert.doesNotThrow(() => assertSearchShape({ items: [] }));
});

test('overdue mode: canonical next_accounts.overdue drives the signal, with citation-shaped note', () => {
  const verdict = evaluateProfile({ profile: PROFILE, mode: 'overdue', now: NOW });
  assert.equal(verdict.eligible, true);
  assert.match(verdict.signalNote, /accounts\.next_accounts\.overdue=true/);
  assert.match(verdict.signalNote, /due 2026-05-31/);
  assert.match(verdict.signalNote, /as of 2026-07-06/);

  const clean = evaluateProfile({
    profile: { ...PROFILE, accounts: { next_accounts: { ...PROFILE.accounts.next_accounts, overdue: false } } },
    mode: 'overdue',
    now: NOW
  });
  assert.equal(clean.eligible, false);
});

test('a profile without the canonical block is a shape refusal, never a legacy-field guess', () => {
  const verdict = evaluateProfile({
    profile: { ...PROFILE, accounts: { overdue: true, next_due: '2026-05-31' } },
    mode: 'overdue',
    now: NOW
  });
  assert.equal(verdict.eligible, false);
  assert.match(verdict.reason, /live shape assertion failed/);
});

test('PECR allowlist: non-corporate types are skipped with a reason; inactive companies too', () => {
  const lp = evaluateProfile({ profile: { ...PROFILE, type: 'limited-partnership' }, mode: 'overdue', now: NOW });
  assert.equal(lp.eligible, false);
  assert.match(lp.reason, /PECR/);
  const dissolved = evaluateProfile({ profile: { ...PROFILE, company_status: 'dissolved' }, mode: 'overdue', now: NOW });
  assert.equal(dissolved.eligible, false);
});

test('first-filing mode: due-soon and not overdue qualifies; overdue or far-out does not', () => {
  const preventive = {
    ...PROFILE,
    accounts: { next_accounts: { overdue: false, due_on: '2026-08-15' } }
  };
  const verdict = evaluateProfile({ profile: preventive, mode: 'first_filing', now: NOW });
  assert.equal(verdict.eligible, true);
  assert.match(verdict.signalNote, /First accounts due 2026-08-15/);

  const farOut = evaluateProfile({
    profile: { ...preventive, accounts: { next_accounts: { overdue: false, due_on: '2027-06-30' } } },
    mode: 'first_filing',
    now: NOW
  });
  assert.equal(farOut.eligible, false);

  const alreadyOverdue = evaluateProfile({ profile: PROFILE, mode: 'first_filing', now: NOW });
  assert.equal(alreadyOverdue.eligible, false);
  assert.match(alreadyOverdue.reason, /overdue campaign/);
});

test('scan loop: search + capped profile reads, eligible minted as candidates, rest reported', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Authorization, chAuthHeader('k'));
    if (url.includes('/advanced-search/')) {
      return {
        ok: true,
        json: async () => ({
          items: [
            { company_number: '11111111', company_name: 'Overdue Ltd' },
            { company_number: '22222222', company_name: 'Clean Ltd' },
            { company_number: '33333333', company_name: 'Weird Partnership' }
          ]
        })
      };
    }
    const number = url.split('/').pop();
    const profiles = {
      11111111: { ...PROFILE, company_name: 'Overdue Ltd', company_number: '11111111' },
      22222222: { ...PROFILE, company_name: 'Clean Ltd', company_number: '22222222', accounts: { next_accounts: { overdue: false, due_on: '2027-01-01' } } },
      33333333: { ...PROFILE, company_name: 'Weird Partnership', company_number: '33333333', type: 'limited-partnership' }
    };
    return { ok: true, json: async () => profiles[number] };
  };

  const result = await runCompaniesHouseScan({ mode: 'overdue', sicCodes: ['70229'], apiKey: 'k', fetchImpl, now: NOW });
  assert.equal(result.searched, 3);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].companyNumber, '11111111');
  assert.equal(result.candidates[0].jurisdiction, 'UK');
  assert.match(result.candidates[0].sourceNote, /overdue/i);
  assert.equal(result.skipped.length, 2);
  assert.equal(calls.length, 4); // 1 search + 3 profiles
});

test('scan refuses honestly: no key (503), no SIC codes (400), provider error surfaces its body', async () => {
  await assert.rejects(
    runCompaniesHouseScan({ mode: 'overdue', sicCodes: ['1'], apiKey: '' }),
    (e) => e.statusCode === 503 && /COMPANIES_HOUSE_API_KEY/.test(e.message)
  );
  await assert.rejects(
    runCompaniesHouseScan({ mode: 'overdue', sicCodes: [], apiKey: 'k' }),
    (e) => e.statusCode === 400
  );
  await assert.rejects(
    runCompaniesHouseScan({
      mode: 'overdue',
      sicCodes: ['1'],
      apiKey: 'k',
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'Invalid Authorization' })
    }),
    /401: Invalid Authorization/
  );
});

test('source vocabulary maps modes onto the pinned PROSPECT_SOURCES values', () => {
  assert.deepEqual(CH_SOURCE_BY_MODE, {
    overdue: 'companies_house_overdue',
    first_filing: 'companies_house_first_filing'
  });
  assert.equal(buildProfileUrl('OC345678'), 'https://api.company-information.service.gov.uk/company/OC345678');
});
