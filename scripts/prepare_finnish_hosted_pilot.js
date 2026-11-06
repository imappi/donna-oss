// Uses the operator's existing database credential. Never prints credentials,
// generates user passwords, sends invitations, or enables cloud automation.
import { readFile } from 'node:fs/promises';
import { prepareFinnishHostedPilotInDb } from '../server/donna/hostedPilot.js';
import { closeFirmDbPool } from '../server/donna/db/pool.js';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--apply') {
  console.error('Usage: node scripts/prepare_finnish_hosted_pilot.js --apply /absolute/path/to/operator-pilot-input.json');
  process.exitCode = 1;
} else {
  try {
    const input = JSON.parse(await readFile(args[1], 'utf8'));
    const receipt = await prepareFinnishHostedPilotInDb(input);
    console.log(JSON.stringify(receipt, null, 2));
  } catch (error) {
    // Database/provider errors can carry connection details: print only typed
    // pilot refusals verbatim; other errors are identified by code.
    console.error(JSON.stringify({ status: 'INCOMPLETE', code: error.code || 'PILOT_SETUP_FAILED',
      ...(String(error.code || '').startsWith('PILOT_') ? { message: error.message } : {}) }));
    process.exitCode = 1;
  } finally { await closeFirmDbPool(); }
}
