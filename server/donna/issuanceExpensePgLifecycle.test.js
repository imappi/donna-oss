import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import * as db from './firmDb.js';
import { ledgerRecordId } from './db/ledger.js';
import { resolveIssuanceOperation, finlandInvoiceIssuanceEntryActsInDb, finlandEInvoiceReceiveEntryActsInDb } from './issuanceRegistry.js';
import { resolveInvoiceIssuanceInbound } from './finland/invoiceIssuanceRoute.js';
import { buildIssuanceArtifacts, formatInvoiceNumber } from './finland/invoiceIssuance.js';
import { maybeStartInvoiceIssuance, maybeReceiveEInvoiceMedia, maybeRunOwnerInvoiceCommand } from './channels/inboundCore.js';
import { recordOwnerMileageExpenseInDb } from './ownerMileageExpense.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
test('real PG: country issuance, quote conversion, settlement and expense replay use existing named writers', {
  skip: pgUrl ? false : 'DONNA_PG_TEST_URL not set — invoice/expense lifecycle INCOMPLETE'
}, async (t) => {
  const name = `donna_jn_expense_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const closed = []; pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
  db.__setFirmDbPoolForTests(pool);
  t.after(async () => { db.__resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed); await admin.query(`drop database "${name}"`); await admin.end(); });
  await pool.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
  const root = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(root)).filter(f => f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, root), 'utf8'));
  const firmId = 'wave7'; const actorId = 'fixture-owner';
  const authorityBasis = { source: 'owner_whatsapp_invoice_confirmation', providerMessageId: 'fixture-message' };
  await pool.query("insert into firms (id,name,slug) values ($1,'Wave 7','wave7')", [firmId]);
  for (const [country, currency] of [['fi','EUR'],['gb','GBP'],['us','USD'],['sg','SGD'],['ae','AED'],['au','AUD'],['zz','ZZZ'],['unknown','USD']]) {
    await pool.query(`insert into clients (id,firm_id,company_name,jurisdiction,profile) values ($1,$2,'Fixture',$3,$4)`,
      [country,firmId,country === 'unknown' ? null : country,{ jurisdiction: country === 'unknown' ? null : country, currency, accounting_system: 'none', accounting_basis: 'accrual' }]);
  }
  for (const flag of ['FINLAND_INVOICING','FINLAND_QUOTES','FINLAND_EINVOICE_RECEIVE']) await pool.query(
    "insert into client_capability_config (id,firm_id,flag_key,stage,source) values ($2,$1,$2,'auto','manual')", [firmId,flag]);
  for (const clientId of ['fi','gb','us','sg','ae','au','zz','unknown']) {
    assert.equal(await finlandInvoiceIssuanceEntryActsInDb({ firmId,clientId }), clientId === 'fi');
    assert.equal(await finlandEInvoiceReceiveEntryActsInDb({ firmId,clientId }), clientId === 'fi');
  }
  // Drive the real channel admission consumers with persisted country gates.
  // A firm-wide flag cannot reach a foreign intake, claim, media download or model.
  for (const country of ['gb','us','sg','ae','au','zz','unknown']) {
    const args = { firmId,anchor: { status: 'unanchored',bindings: [{ client_id: country }] },
      message: { id: `entry-${country}` },text: 'Create an invoice',config: { allowsClient: () => true },
      deps: { invoiceIssuanceFlagActs: db.finlandInvoicingWhatsAppFlagActsInDb,
        invoiceIssuanceEntryActs: finlandInvoiceIssuanceEntryActsInDb,
        einvoiceReceiveFlagActs: db.finlandEInvoiceReceiveWhatsAppFlagActsInDb,
        einvoiceReceiveEntryActs: finlandEInvoiceReceiveEntryActsInDb,
        createIssuedInvoiceDraft: () => assert.fail('foreign draft'),
        claimInboundMessage: () => assert.fail('foreign claim'),downloadMedia: () => assert.fail('foreign media'),
        runOwnerInvoiceCommand: () => assert.fail('mutual-exclusion gate bypassed') } };
    assert.equal(await maybeStartInvoiceIssuance(args),null);
    assert.equal(await maybeReceiveEInvoiceMedia({ ...args,descriptor: { kind: 'document' } }),null);
    assert.equal(await maybeRunOwnerInvoiceCommand(args),null,'raw live FI gate still excludes a second issuance lifecycle');
  }
  const clientId = 'fi';
  const quote = await db.createIssuedQuoteDraftInDb({ firmId,clientId,actorId,draft: { quote: { quoteNumber: 'T2026001',total: 100 } },validUntil: '2026-10-05' });
  await db.markIssuedQuoteSentInDb({ firmId,clientId,quoteId: quote.id,actorId,authorityBasis,transmitReceipt: { message_id: 'quote-delivery' } });
  const create = resolveIssuanceOperation({ jurisdiction: 'fi', operation: 'createIssuedInvoiceDraftInDb' });
  const invoice = await create({ firmId,clientId,actorId,buildDraft: ({ sequence }) => {
    const draft = buildIssuanceArtifacts({
      invoiceNumber: formatInvoiceNumber({ sequence,date: '2026-09-05' }),date: '2026-09-05',timestamp: '2026-09-05T10:00:00Z',
      sellerContext: { name: 'Fixture',businessId: '0737546-2',iban: 'FI2112345600000785' },
      intent: { buyer_name: 'Buyer',buyer_business_id: '0201256-6',buyer_email: 'fixture@example.invalid',lines: [{ description: 'Service',quantity: 1,unit_price: 100 }] }
    });
    assert.equal(draft.ok,true); return { draft: { ...draft.artifacts,from_quote_id: quote.id } };
  } });
  assert.equal(invoice.invoice_number,1); assert.equal(quote.quote_number,1);
  const posted = await db.postSalesInvoiceJournalFromDb({ firmId,clientId,invoice: invoice.draft.invoice,authorityBasis,actorId });
  await db.markIssuedInvoiceIssuedInDb({ firmId,clientId,invoiceId: invoice.id,arJournalId: posted.ledger_journal_id,actorId,authorityBasis,transmitReceipt: { message_id: 'invoice-delivery' } });
  assert.equal((await db.getIssuedQuoteByIdInDb({ firmId,clientId,quoteId: quote.id })).status,'converted');
  await assert.rejects(db.markIssuedInvoiceIssuedInDb({ firmId,clientId,invoiceId: invoice.id,actorId,authorityBasis }), e => e.code === 'ISSUED_INVOICE_NOT_PENDING');
  const reference = invoice.draft.finvoice.invoiceDetails.referenceNumber || invoice.draft.finvoice.paymentDetails.referenceNumber;
  await pool.query(`insert into transactions (id,firm_id,client_id,transaction_date,description,structured_reference,money_in,money_out,currency,status) values ('payment',$1,$2,'2026-09-06','Invoice payment',$3,100,0,'EUR','needs_review')`, [firmId,clientId,reference]);
  const report = await db.getFinlandIssuedInvoicesFromDb({ firmId,clientId,readAt: '2026-09-07T12:00:00Z' });
  assert.equal(report.issued_invoices.invoices[0].matched_payment_count,1);
  assert.equal(report.issued_invoices.invoices[0].settlement.open_amount,0);
  const pending = await db.createIssuedInvoiceDraftInDb({ firmId,clientId,actorId,draft: { invoice: { total: 10 } } });
  const ask = await db.createInvoiceIssuanceEvidenceRequestInDb({ firmId,clientId,actorId,question: 'Confirm this invoice?',requestPayload: { invoice_issuance: { phase: 'confirm_request',invoice_id: pending.id } } });
  const before = (await pool.query('select * from issued_invoices where id=$1',[invoice.id])).rows[0];
  await db.updateClientProfileInDb({ firmId,clientId,profilePatch: { jurisdiction: 'gb' },actorId });
  assert.equal(await finlandInvoiceIssuanceEntryActsInDb({ firmId,clientId }),false);
  assert.equal(await db.finlandInvoicingWhatsAppFlagActsInDb({ firmId,clientId }),true,'historical reply flag is retained');
  assert.deepEqual((await pool.query('select * from issued_invoices where id=$1',[invoice.id])).rows[0],before);
  // New country facts cannot rewrite historical lifecycle receipts. Cancellation
  // still belongs to the original operation, including a draft made before repair.
  const cancelled = await resolveInvoiceIssuanceInbound({ firmId,clientId,actorId,ask,replyText: 'ei',message: { id: 'cancel-reply' },
    flagActs: await db.finlandInvoicingWhatsAppFlagActsInDb({ firmId,clientId }),
    getInvoiceImpl: db.getIssuedInvoiceByIdInDb,cancelImpl: db.cancelIssuedInvoiceInDb,
    resolveAsk: ({ askId,resolutionNote }) => db.resolveClientEvidenceRequestInDb({ firmId,evidenceRequestId: askId,resolutionNote,actorId,actorType: 'client' }) });
  assert.equal(cancelled.action,'cancelled');
  assert.equal((await pool.query('select status from client_evidence_requests where id=$1',[ask.id])).rows[0].status,'replied');
  assert.equal((await pool.query("select count(*)::int as n from client_evidence_requests where client_id=$1 and status='open'",[clientId])).rows[0].n,0);
  await db.updateClientProfileInDb({ firmId,clientId: 'fi',profilePatch: { jurisdiction: 'fi' },actorId });
  for (const country of ['fi','gb','us']) {
    const currency = { fi: 'EUR',gb: 'GBP',us: 'USD' }[country];
    for (const [code,label,type,balance] of [['6105','Mileage expense','expense','debit'],['2300','Due to owner','liability','credit']]) {
      await pool.query(`insert into ledger_accounts (id,firm_id,client_id,code,name,account_type,normal_balance,currency,status) values ($1,$2,$3,$4,$5,$6,$7,$8,'active')`, [ledgerRecordId('account',firmId,country,code),firmId,country,code,label,type,balance,currency]);
    }
    const args = { firmId,clientId: country,actorId,sourceMessageId: `mileage-${country}`,action: { miles: 100,purpose: 'Site visit',date: '2026-09-05',confidence: 'confirmed' } };
    let result;
    if (country === 'us') {
      // Provisioning holds the entity key before client rows. Prove mileage
      // waits at that key without taking the row and inverting the lock order.
      const provision = await pool.connect();
      let pending;
      try {
        await provision.query('begin');
        await provision.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`entity-readiness:${firmId}:${country}`]);
        pending = recordOwnerMileageExpenseInDb(args);
        let waiting = false;
        for (let attempt = 0; attempt < 500 && !waiting; attempt += 1) {
          // Refresh activity inside this transaction: the first snapshot can
          // precede the mileage connection reaching its advisory lock.
          await provision.query('select pg_stat_clear_snapshot()');
          const observed = await provision.query(`select 1 from pg_stat_activity
            where datname=current_database() and wait_event_type='Lock'
              and query like 'select pg_advisory_xact_lock(%'
              and pg_backend_pid()=any(pg_blocking_pids(pid))`);
          waiting = observed.rows.length > 0;
          if (!waiting) await new Promise(resolve => setTimeout(resolve,10));
        }
        assert.ok(waiting,'mileage waits on the entity key');
        await provision.query('select id from clients where firm_id=$1 and id=$2 for update nowait',[firmId,country]);
      } finally {
        await provision.query('rollback'); provision.release();
        if (pending) result = await pending;
      }
    } else result = await recordOwnerMileageExpenseInDb(args);
    assert.equal(result.status,'booked');
    assert.equal(result.computation.jurisdiction,country.toUpperCase());
    const journal = (await pool.query('select * from ledger_journals where id=$1',[result.ledger_journal_id])).rows[0];
    const lines = (await pool.query('select * from ledger_lines where journal_id=$1 order by line_no',[result.ledger_journal_id])).rows;
    assert.equal(lines.reduce((n,l) => n + Number(l.debit) - Number(l.credit),0),0);
    await db.updateClientProfileInDb({ firmId,clientId: country,profilePatch: { jurisdiction: 'ae' },actorId });
    const replay = await recordOwnerMileageExpenseInDb({ ...args,action: { ...args.action,miles: 999,date: '2027-01-01' } });
    assert.equal(replay.replay,true); assert.deepEqual(replay.computation,result.computation);
    assert.deepEqual((await pool.query('select * from ledger_journals where id=$1',[result.ledger_journal_id])).rows[0],journal);
    assert.deepEqual((await pool.query('select * from ledger_lines where journal_id=$1 order by line_no',[result.ledger_journal_id])).rows,lines);
    assert.equal((await recordOwnerMileageExpenseInDb({ ...args,sourceMessageId: `new-${country}` })).reason,'unsupported_jurisdiction');
  }
  // The opposite arrival order: mileage owns readiness, then a named profile
  // update owns the client row and waits in its real dependency trigger.
  await db.updateClientProfileInDb({ firmId,clientId: 'us',profilePatch: { jurisdiction: 'us' },actorId });
  const updater = await pool.connect();
  const updaterPid = (await updater.query('select pg_backend_pid() as pid')).rows[0].pid;
  let update;
  try {
    const raced = await recordOwnerMileageExpenseInDb({ firmId,clientId: 'us',actorId,
      sourceMessageId: 'mileage-before-profile-update',
      action: { miles: 100,purpose: 'Site visit',date: '2026-09-05',confidence: 'confirmed' },
      deps: { withFirmDbClient: async run => {
        const writer = await pool.connect();
        try {
          return await run({ query: async (sql,params) => {
            const result = await writer.query(sql,params);
            if (sql.startsWith('select pg_advisory_xact_lock(') && !update) {
              update = db.updateClientProfileInDb({ firmId,clientId: 'us',actorId,
                profilePatch: { jurisdiction: 'ae' },dbClient: updater }).then(() => null,error => error);
              let waiting = false;
              for (let attempt = 0; attempt < 500 && !waiting; attempt += 1) {
                waiting = (await pool.query("select 1 from pg_locks where pid=$1 and locktype='advisory' and not granted",[updaterPid])).rows.length > 0;
                if (!waiting) await new Promise(resolve => setTimeout(resolve,10));
              }
              assert.ok(waiting,'the named profile writer waits on mileage readiness');
              await writer.query("set local lock_timeout='250ms'");
            }
            return result;
          } });
        } finally { writer.release(); }
      } }
    });
    assert.equal(raced.status,'needs_clarification');
    assert.equal(raced.reason,'unsupported_jurisdiction');
    assert.equal((await pool.query("select count(*)::int as n from ledger_journals where source_id='owner_mileage:mileage-before-profile-update'")).rows[0].n,0,
      'admission retries against the committed country before any journal is written');
  } finally {
    const error = update ? await update : null;
    updater.release();
    if (error) throw error;
  }
  assert.equal((await pool.query("select jurisdiction from clients where id='us'")).rows[0].jurisdiction,'AE');
});
