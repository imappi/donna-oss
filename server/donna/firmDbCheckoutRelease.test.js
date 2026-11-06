import test from 'node:test';
import assert from 'node:assert/strict';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, withFirmDbClient } from './db/pool.js';

for (const fails of [false, true]) {
  test(`checkout awaits release exactly once and preserves ${fails ? 'callback error' : 'callback result'}`, async t => {
    let finishRelease;
    const releaseGate = new Promise(resolve => { finishRelease = resolve; });
    let releases = 0, settled = false;
    const original = Object.assign(new Error('Original refusal'), { code: 'ORIGINAL_REFUSAL' });
    __setFirmDbPoolForTests({ connect: async () => ({ release: async () => { releases++; await releaseGate; } }) });
    t.after(__resetFirmDbPoolForTests);
    const pending = withFirmDbClient(async () => { if (fails) throw original; return 'canonical result'; });
    const observed = pending.then(value => { settled = true; return value; }, error => { settled = true; return error; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(releases, 1); assert.equal(settled, false);
    finishRelease();
    assert.equal(await observed, fails ? original : 'canonical result');
    assert.equal(releases, 1);
  });
  test(`release rejection ${fails ? 'retains first callback failure' : 'refuses apparent success'}`, async t => {
    const original = Object.assign(new Error('Original refusal'), { code: 'ORIGINAL_REFUSAL' });
    const release = Object.assign(new Error('Release failed'), { code: 'RELEASE_FAILURE' });
    let releases = 0;
    __setFirmDbPoolForTests({ connect: async () => ({ release: async () => { releases++; throw release; } }) });
    t.after(__resetFirmDbPoolForTests);
    await assert.rejects(withFirmDbClient(async () => { if (fails) throw original; return 'not success'; }), error => {
      assert.equal(error, fails ? original : release);
      if (fails) assert.deepEqual(error.admission_lease_cleanup, [{ code: 'RELEASE_FAILURE', responsible_system: 'donna_database_connection' }]);
      return true;
    });
    assert.equal(releases, 1);
  });
}
