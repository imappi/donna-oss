import test from 'node:test';
import assert from 'node:assert/strict';
import { readEntityCertificateSnapshot } from './entityCertificateB.js';

const countMarker = '::text as table_name, count(*)::integer as count from';
const inventoryMarker = "c.column_name = 'client_id'";
const snapshot = query => readEntityCertificateSnapshot({ query, firmId: 'synthetic-firm', clientId: 'synthetic-client' });

test('snapshot batches the complete scoped inventory, retaining zero counts', async () => {
  const calls=[];
  const result=await snapshot(async (sql,params) => {
    if(sql.includes(inventoryMarker)) return {rows:[{table_name:'a_scoped',has_firm_id:true},{table_name:'b_unscoped',has_firm_id:false},{table_name:'c_empty',has_firm_id:true}]};
    if(sql.includes(countMarker)) {calls.push({sql,params});return {rows:[{table_name:'c_empty',count:0},{table_name:'b_unscoped',count:3},{table_name:'a_scoped',count:2}]};}
    return {rows:[]};
  });
  assert.deepEqual(result.client_table_counts,{a_scoped:2,b_unscoped:3,c_empty:0});
  assert.deepEqual(Object.keys(result.client_table_counts),['a_scoped','b_unscoped','c_empty'],'original catalog ordering survives differently ordered batch rows');
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0].params,['synthetic-client','synthetic-firm']);
  assert.match(calls[0].sql,/from "a_scoped" where client_id = \$1 and firm_id = \$2/);
  assert.match(calls[0].sql,/from "b_unscoped" where client_id = \$1 union all/);
  assert.match(calls[0].sql,/from "c_empty" where client_id = \$1 and firm_id = \$2 order by table_name$/);
});

test('empty inventory performs no count batch; unscoped inventory has no unused parameter', async () => {
  const empty=await snapshot(async sql=>{assert.ok(!sql.includes(countMarker));return {rows:[]};});
  assert.deepEqual(empty.client_table_counts,{});
  const unscoped=await snapshot(async (sql,params)=>{
    if(sql.includes(inventoryMarker))return {rows:[{table_name:'unscoped',has_firm_id:false}]};
    if(sql.includes(countMarker)){assert.deepEqual(params,['synthetic-client']);return {rows:[{table_name:'unscoped',count:0}]};}
    return {rows:[]};
  });
  assert.deepEqual(unscoped.client_table_counts,{unscoped:0});
});

test('unsafe table identifiers and database count failures refuse the snapshot', async () => {
  await assert.rejects(snapshot(async sql=>{
    if(sql.includes(inventoryMarker))return {rows:[{table_name:'unsafe;drop',has_firm_id:true}]};
    assert.ok(!sql.includes(countMarker));return {rows:[]};
  }),/Unsafe database identifier/);
  await assert.rejects(snapshot(async sql=>{
    if(sql.includes(inventoryMarker))return {rows:[{table_name:'documents',has_firm_id:true}]};
    if(sql.includes(countMarker))throw Object.assign(new Error('Synthetic query failure'),{code:'08006'});
    return {rows:[]};
  }),{code:'08006'});
});


test('a missing batch result cannot silently drop a table from the certificate', async () => {
  await assert.rejects(snapshot(async sql=>{
    if(sql.includes(inventoryMarker))return {rows:[{table_name:'documents',has_firm_id:true}]};
    return {rows:[]};
  }),{code:'ENTITY_SNAPSHOT_COUNT_INCOMPLETE'});
});
