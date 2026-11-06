// Unit test for the manual sweep driver — pure arg logic. The load-bearing
// property is receipts-first: without --run the script prints database +
// firm gates + endpoint and executes NOTHING (the 2026-08-17 wrong-DB /
// stale-endpoint incident is the reason this two-step exists).
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgv } from './run_bank_line_disposition_sweep.js';

test('receipts-only by default; --run opts into execution', () => {
  assert.equal(parseArgv([]).run, false);
  assert.equal(parseArgv(['--run']).run, true);
  assert.equal(parseArgv(['--anything-else']).run, false);
});
