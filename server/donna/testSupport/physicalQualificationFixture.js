import { randomUUID, createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { setClientFlagStage } from '../clientConfig.js';
import { applyInventoryOperation } from '../inventory/db.js';
import { prepareCiHostPostgres } from '../../../scripts/prepare_ci_host_postgres.js';

// Disposable synthetic fixture shared by the PostgreSQL proof and the explicit
// browser exercise. Never connects to or enrolls a customer database.
export async function physicalQualificationFixture() {
  const connectionString = process.env.DONNA_PG_TEST_URL;
  if (!connectionString) throw new Error('INCOMPLETE: DONNA_PG_TEST_URL required');
  const address = new URL(connectionString);
  if (!['localhost','127.0.0.1','::1'].includes(address.hostname)) throw new Error('Synthetic qualification requires local PostgreSQL');
  const admin = new pg.Client({connectionString}); await admin.connect();
  const databaseName = `physical_qualification_${randomUUID().replaceAll('-','')}`;
  await admin.query(`create database "${databaseName}"`);
  address.pathname=`/${databaseName}`;
  const pool = new pg.Pool({connectionString:address.toString(),connectionTimeoutMillis:2000});
  const dispose = async () => { await pool.end(); await admin.query(`drop database "${databaseName}"`); await admin.end(); };
  try {
    await prepareCiHostPostgres({databaseUrl:address.toString()});
    const migrations = new URL('../../../db/migrations/',import.meta.url);
    for (const f of (await readdir(migrations)).filter(f=>f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(f,migrations),'utf8'));
    const a={firmId:'qualification-firm',clientId:'qualification-client',actorId:'member',actorType:'firm_member'};
    await pool.query(`insert into firms(id,name,slug) values('qualification-firm','Synthetic qualification','qualification');
      insert into clients(id,firm_id,company_name) values('qualification-client','qualification-firm','Synthetic stock');
      insert into firm_members(id,firm_id,user_id,email,name,status,access_level) values
      ('member','qualification-firm','qualification-user','qualification@example.invalid','Synthetic operator','active','owner'),
      ('senior','qualification-firm','senior-user','senior@example.invalid','Synthetic senior','active','owner');`);
    await pool.query('update clients set profile=$1::jsonb where id=$2',[JSON.stringify({physical_reconciliation:{reviewer:{principalType:'firm_member',principalId:'member'},senior:{principalType:'firm_member',principalId:'senior'},calendar:{timeZone:'Europe/London',workingDays:[1,2,3,4,5],holidays:[]}}}),a.clientId]);
    const client=await pool.connect();
    try {
      for (const flagKey of ['INVENTORY_CORE','PHYSICAL_RECONCILIATION']) await setClientFlagStage(client,{...a,flagKey,stage:'canary',reason:'Disposable synthetic qualification'});
      await client.query("insert into inventory_units_of_measure(id,firm_id,client_id,code,name,kind) values('each',$1,$2,'EA','Each','count')",[a.firmId,a.clientId]);
      await client.query("insert into inventory_locations(id,firm_id,client_id,code,name) values('shelf',$1,$2,'S','Synthetic shelf')",[a.firmId,a.clientId]);
      for(let i=0;i<5;i++){
        await client.query('insert into inventory_items(id,firm_id,client_id,sku,name,base_uom_id) values($1,$2,$3,$4,$5,$6)',[`item-${i}`,a.firmId,a.clientId,`SKU${i}`,`Item ${i}`,'each']);
        const result=await applyInventoryOperation({...a,client,itemId:`item-${i}`,locationId:'shelf',uomId:'each',operationType:'receipt',quantity:10,unitCostAmount:5,unitCostCurrency:'GBP',occurredAt:'2026-01-01',idempotencyKey:`seed-${i}`});
        if(!result.applied)throw new Error(JSON.stringify(result));
      }
    }finally{client.release();}
    const photo=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS8cAAAAASUVORK5CYII=','base64');
    const checksum=createHash('sha256').update(photo).digest('hex');
    await pool.query("insert into documents(id,firm_id,client_id,filename,checksum_sha256,storage_object_key,payload) values('fixture-photo',$1,$2,'fixture.png',$3,$4,jsonb_build_object('mime_type','image/png','file_size',$5::integer))",[a.firmId,a.clientId,checksum,`${a.firmId}/${a.clientId}/evidence/fixture.png`,photo.length]);
    return {pool, a, photo, checksum, dispose};
  }catch(error){await dispose();throw error;}
}
