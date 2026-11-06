// Manual-upload parser — unit coverage for the P0C source module: CSV header
// detection, quote handling, plain-lines fallback, jurisdiction/tier/email
// normalization, and the nothing-silent skip reporting.

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseManualUploadList } from './manualUploadSource.js';

test('CSV with headers parses into normalized candidates', () => {
  const text = [
    'name,company_number,country,website,email,signal,campaigns,tier',
    'Acme Design Ltd,12345678,gb,https://acme.example,hello@acme.example,"hiring a part-time bookkeeper",uk_overdue;micro_agencies,green',
    'Solo Studio,,SG,,,"complained about Stripe payouts",commerce_payouts,yellow'
  ].join('\n');

  const { mode, candidates, skipped } = parseManualUploadList(text);
  assert.equal(mode, 'csv');
  assert.equal(skipped.length, 0);
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates[0], {
    companyName: 'Acme Design Ltd',
    companyNumber: '12345678',
    jurisdiction: 'UK',
    website: 'https://acme.example',
    contactEmail: 'hello@acme.example',
    sourceNote: 'hiring a part-time bookkeeper',
    campaigns: ['uk_overdue', 'micro_agencies'],
    tier: 'green'
  });
  assert.equal(candidates[1].jurisdiction, 'SG');
  assert.equal(candidates[1].companyNumber, null);
  assert.equal(candidates[1].tier, 'yellow');
});

test('plain lines mode: one company per line, defaults applied', () => {
  const { mode, candidates } = parseManualUploadList('Koru Consulting\n\nBright Path Coaching\n', {
    defaultJurisdiction: 'US',
    defaultTier: 'yellow',
    defaultCampaigns: ['micro_agencies']
  });
  assert.equal(mode, 'lines');
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].companyName, 'Koru Consulting');
  assert.equal(candidates[0].jurisdiction, 'US');
  assert.equal(candidates[0].tier, 'yellow');
  assert.deepEqual(candidates[0].campaigns, ['micro_agencies']);
});

test('nothing silent: bad rows are reported with line numbers, never dropped', () => {
  const text = [
    'name,email,tier',
    ',missing@name.example,green',
    'Bad Email Co,not-an-email,green',
    'Bad Tier Co,ok@tier.example,purple',
    '"Unterminated Co,ok@quote.example,green'
  ].join('\n');
  const { candidates, skipped } = parseManualUploadList(text);
  assert.equal(candidates.length, 0);
  assert.equal(skipped.length, 4);
  assert.deepEqual(skipped.map((s) => s.line), [2, 3, 4, 5]);
  assert.match(skipped[0].reason, /missing company name/);
  assert.match(skipped[1].reason, /does not look like an email/);
  assert.match(skipped[2].reason, /unknown tier/);
  assert.match(skipped[3].reason, /unterminated quote/);
});

test('in-upload duplicates skip: registry-keyed and name-keyed', () => {
  const text = [
    'name,company_number',
    'Acme Ltd,12345678',
    'Acme Limited (rename),12345678',
    'No Number Co,',
    'no number co,'
  ].join('\n');
  const { candidates, skipped } = parseManualUploadList(text);
  assert.equal(candidates.length, 2);
  assert.equal(skipped.length, 2);
  assert.ok(skipped.every((s) => /duplicate/.test(s.reason)));
});

test('jurisdiction synonyms normalize; unknown codes survive as typed', () => {
  const text = ['name,country', 'A,United Kingdom', 'B,AU', 'C,DE'].join('\n');
  const { candidates } = parseManualUploadList(text);
  assert.deepEqual(candidates.map((c) => c.jurisdiction), ['UK', 'AUS', 'DE']);
});

test('empty input reports empty mode', () => {
  assert.deepEqual(parseManualUploadList('  \n \n'), { mode: 'empty', candidates: [], skipped: [] });
});

test('quoted fields keep commas and escaped quotes', () => {
  const text = ['name,notes', '"Smith, Jones & Co","said ""books are chaos"" on their site"'].join('\n');
  const { candidates } = parseManualUploadList(text);
  assert.equal(candidates[0].companyName, 'Smith, Jones & Co');
  assert.equal(candidates[0].sourceNote, 'said "books are chaos" on their site');
});
