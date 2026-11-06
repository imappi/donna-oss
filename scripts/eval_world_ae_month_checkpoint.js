// A real process-loss probe after the named close writer commits. The parent
// appliance owns the scratch database; this process must never clean it up.
import { readFile, writeFile } from 'node:fs/promises';
import { lockClosePeriodInDb, getCloseArchiveExportFromDb, closeFirmDbPool, deleteFirmInDb, countFirmResidueInDb } from '../server/donna/firmDb.js';
const [inputFile,outputFile,phase]=process.argv.slice(2);
const input=JSON.parse(await readFile(inputFile,'utf8'));
const database=new URL(process.env.DATABASE_URL||'invalid:');
const expected=`donna_appliance_${input.runToken.replace(/-/g,'_')}`;
if(!['127.0.0.1','localhost','[::1]'].includes(database.hostname)||database.pathname!==`/${expected}`
  ||input.firmId!==`eaw-appliance-${input.runToken}`||!input.clientId.startsWith(`${input.firmId}-client-`)
  ||!['crash_after_commit','resume','retire'].includes(phase))throw new Error('AE_MONTH_CHECKPOINT_ISOLATION_REQUIRED');
if(phase==='retire'){
  const retirement=await deleteFirmInDb({firmId:input.firmId,actor:{type:'operator',id:input.actorId}});
  const residue=await countFirmResidueInDb({firmId:input.firmId,clientIds:[input.clientId]});
  await writeFile(outputFile,JSON.stringify({retirement,residue}),{flag:'wx'});
  await closeFirmDbPool();
} else {
const common={firmId:input.firmId,clientId:input.clientId,actorId:input.actorId,periodStart:'2026-09-01',periodEnd:'2026-09-30'};
let result;
if(input.operation==='export')result={operation:'getCloseArchiveExportFromDb',deliveryArtifact:await getCloseArchiveExportFromDb({...common,archiveId:input.archiveId})};
else if(input.operation==='close')result={operation:'lockClosePeriodInDb',closeLock:(await lockClosePeriodInDb(common)).close_lock};
else throw new Error('AE_MONTH_CHECKPOINT_OPERATION_UNKNOWN');
await writeFile(outputFile,JSON.stringify({pid:process.pid,phase,...result}),{flag:'wx'});
if(phase==='crash_after_commit')process.exit(86);
await closeFirmDbPool();

}
