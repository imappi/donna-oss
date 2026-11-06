#!/usr/bin/env node
// Evaluation seam: expected economics stay in this parent, outside the solver child.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAeDiagnosticDatabase } from './eval_world_ae_runtime.js';
import { AE_MONTH_EXPECTED } from '../server/donna/world/aeMonthExpected.js';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
export function compareAeMonthEconomics(receipt) {
  const e=AE_MONTH_EXPECTED,r=receipt?.financialReport;
  const checks=[];
  const check=(name,actual,expected)=>checks.push({name,actual:actual??null,expected,pass:actual===expected});
  const byRole=role=>r?.trial_balance?.accounts?.filter(account=>account.canonical_role===role)||[];
  const balance=role=>{const rows=byRole(role);return rows.length===1?rows[0].balance:null;};
  check('bank',balance('asset.cash'),e.bank);check('revenue',r?.profit_and_loss?.revenue,e.revenue);
  check('supplies',balance('expense.operating_supplies'),e.operatingSupplies);
  check('vat_payable',balance('liability.sales_tax_payable'),e.vatPayable);check('share_capital',balance('equity.share_capital'),e.shareCapital);
  check('profit',r?.profit_and_loss?.net_income,e.profit);check('trial_balance_debit',r?.trial_balance?.total_debit,e.trialBalanceDebit);
  check('trial_balance_credit',r?.trial_balance?.total_credit,e.trialBalanceCredit);
  check('trial_balance_balanced',r?.trial_balance?.balanced,true);
  check('balance_sheet_assets',r?.balance_sheet?.total_assets,e.bank);
  check('balance_sheet_liabilities',r?.balance_sheet?.total_liabilities,e.vatPayable);
  check('balance_sheet_equity',r?.balance_sheet?.total_equity,e.shareCapital+e.profit);
  check('balance_sheet_balanced',r?.balance_sheet?.balanced,true);
  check('carry_forward_bank',receipt?.carryForward?.cash?.total,e.bank);
  check('carry_forward_equity',receipt?.carryForward?.balance_sheet?.total_equity,e.shareCapital+e.profit);
  check('next_month_profit',receipt?.carryForward?.profit_and_loss?.net_income,0);
  const vat=receipt?.vatReturn?.vatReturn;
  check('vat_supplies',vat?.fields?.standard_rated_supplies?.total?.amount,e.vat.supplies);
  check('vat_output',vat?.fields?.standard_rated_supplies?.total?.vat,e.vat.output);
  check('vat_expenses',vat?.fields?.standard_rated_expenses?.amount,e.vat.expenses);
  check('vat_input',vat?.fields?.standard_rated_expenses?.recoverable_vat,e.vat.input);check('vat_net',vat?.netVat,e.vat.net);
  return {status:checks.every(c=>c.pass)?'PASS':'INCOMPLETE',checks};
}

export function certifyAeMonthReceipt(receipt) {
  const observer=receipt.observation?.terminal?.terminal;
  const checks={
    correct_economics:compareAeMonthEconomics(receipt).status==='PASS',
    named_observer:observer?.locked===true&&observer.t1.length===1&&observer.t2.length===0&&observer.limbo.length===0,
    all_source_rows_posted:receipt.lastObservation?.transactions?.length===3&&receipt.lastObservation.transactions.every(tx=>['posted','closed','synced'].includes(tx.coding_state)),
    exact_journal_count:receipt.lastObservation?.journalCount?.count===4,
    automatic_reply_continuation:receipt.automaticContinuation?.journalCount?.count===4
      &&receipt.automaticContinuation?.transactions?.length===3
      &&receipt.automaticContinuation.transactions.every(tx=>['posted','closed','synced'].includes(tx.coding_state)),
    source_bound_matches:receipt.matches?.length===3&&AE_MONTH_EXPECTED.sourceMatches.every(source=>{
      const tx=receipt.lastObservation?.transactions?.filter(row=>row.transaction_date===source.date)||[];
      const matches=receipt.matches.filter(match=>match.bank_transaction_id===tx[0]?.id);
      return tx.length===1&&matches.length===1&&matches[0].status==='auto_matched'
        &&matches[0].matched_object_id===receipt.sources?.[source.key]&&Number(matches[0].match_amount)===source.amount;
    }),
    owner_answer_was_required:receipt.beforeOwnerAnswer?.report?.draft?.is_draft===true&&receipt.beforeOwnerAnswer?.observation?.asks?.filter(a=>['open','draft','replied'].includes(a.status)).length===1,
    final_report:receipt.financialReport?.draft?.stamp==='FINAL',
    close_process_restart:receipt.closeCrashResume?.sameCloseIdentity===true&&receipt.closeCrashResume?.separateProcesses===true&&receipt.closeCrashResume?.replayIdempotent===true,
    export_process_restart:receipt.exportCrashResume?.separateProcesses===true&&JSON.stringify(receipt.exportCrashResume.exitCodes)==='[86,0]',
    retained_export:typeof receipt.deliveryArtifact?.bundle_checksum_sha256==='string'
      &&Object.keys(receipt.deliveryArtifact?.files||{}).length===9
      &&receipt.deliveryArtifact?.handoff?.status==='delivered'
      &&receipt.deliveryArtifact?.files?.['period.json']?.close_status==='ready'
      &&receipt.deliveryArtifact?.files?.['period.json']?.lockable===true
      &&typeof receipt.deliveryArtifact?.files?.['period.json']?.locked_at==='string'
      &&receipt.exportReplayStable===true,
    retirement:receipt.retirement?.residue_verified===true&&receipt.residue?.residue_rows===0&&receipt.blobResidue===0,
    no_unscripted_transport:Array.isArray(receipt.unscripted)&&receipt.unscripted.length===0,
    no_blockers:receipt.blockers?.length===0,
  };
  return {status:Object.values(checks).every(Boolean)?'PASS':'INCOMPLETE',scope:'one supported synthetic management-books month',checks};
}

export async function runAeMonthRehearsal({postgresUrl,runToken,orders=['document_first','bank_first','late_document'],continuation=true,withholdOwnerAnswer=false}={}) {
  assertAeDiagnosticDatabase(postgresUrl);
  if(!/^[a-z0-9-]{1,38}$/.test(runToken||''))throw Object.assign(new Error('Use a unique lowercase run token of at most 38 characters.'),{code:'AE_MONTH_RUN_TOKEN_REQUIRED'});
  if(!orders.length||orders.some(order=>!['document_first','bank_first','late_document'].includes(order)))throw new Error('Unknown or empty month order set.');
  const directory=await mkdtemp(join(tmpdir(),'donna-ae-month-'));const receipts=[];
  try {
    for(const [index,order] of orders.entries()){
      const output=join(directory,`${order}.json`),input=join(directory,`${order}-input.json`);
      await writeFile(input,JSON.stringify({postgresUrl,runToken:`${runToken}-${index}`,order,continuation,withholdOwnerAnswer}));
      const child=await new Promise((resolveChild,reject)=>{
        const env={PATH:process.env.PATH,HOME:directory,TMPDIR:directory,TZ:process.env.TZ||'UTC'};
        const processChild=spawn(process.execPath,[join(ROOT,'scripts/eval_world_ae_month_worker.js'),input,output],{cwd:directory,env,stdio:['ignore','pipe','pipe']});
        let logs='';const capture=chunk=>{logs=(logs+chunk).slice(-12000);};processChild.stdout.on('data',capture);processChild.stderr.on('data',capture);
        const timeout=setTimeout(()=>processChild.kill('SIGKILL'),240000);
        processChild.on('error',reject);processChild.on('close',(exitCode,signal)=>{clearTimeout(timeout);resolveChild({exitCode,signal,logs});});
      });
      if(child.exitCode!==0)throw new Error(`Month worker failed (${child.exitCode}/${child.signal}): ${child.logs}`);
      const receipt=JSON.parse(await readFile(output,'utf8'));receipt.economics=compareAeMonthEconomics(receipt);receipt.certificate=certifyAeMonthReceipt(receipt);receipts.push(receipt);
    }
  } finally {await rm(directory,{recursive:true,force:true});}
  return {version:'ae.month-rehearsal-suite.v1',status:receipts.every(r=>r.certificate.status==='PASS')?'PASS':'INCOMPLETE',
    assurance:'synthetic provider integration only; not live-model, six-world AE-7 or complete-service assurance',ae7Status:'INCOMPLETE',spend:{paidCalls:0,amountUsd:'0.00'},orders:receipts};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),value=flag=>args.includes(flag)?args[args.indexOf(flag)+1]:undefined;
  const receipt=await runAeMonthRehearsal({postgresUrl:process.env.DONNA_PG_TEST_URL,runToken:value('--run-token')});
  const json=JSON.stringify(receipt,null,2)+'\n';if(value('--output'))await writeFile(resolve(value('--output')),json,{flag:'wx'});else process.stdout.write(json);
  process.exitCode=receipt.status==='PASS'?0:2;
}
