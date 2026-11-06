import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('pilot report CLI executes offline fixtures and preserves existing private receipts',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'physical-report-'));
  try{
    const json=join(directory,'report.json'),markdown=join(directory,'report.md');
    const args=['scripts/report_donna_physical_pilot.js','--snapshot','fixtures/physical-qualification/snapshot.json','--inputs','fixtures/physical-qualification/inputs.json','--json',json,'--markdown',markdown];
    const result=spawnSync(process.execPath,args,{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
    const report=JSON.parse(await readFile(json,'utf8'));
    assert.equal(report.cohort,'fixture');assert.equal(report.detection.materialFalseSupported,1);
    assert.match(await readFile(markdown,'utf8'),/pending_human_ratification/);
    assert.equal((await stat(json)).mode&0o777,0o600);
    const retry=spawnSync(process.execPath,args,{encoding:'utf8'});assert.notEqual(retry.status,0);assert.match(retry.stderr,/EEXIST/);
    assert.deepEqual(JSON.parse(await readFile(json,'utf8')),report);
  }finally{await rm(directory,{recursive:true,force:true});}
});
