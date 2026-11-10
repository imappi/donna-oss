// FI-21 (2026-10-15), proven on real PostgreSQL through the real HTTP routes:
//   firm self-provision → hosted Finnish Oy creation → the book is born with
//   the coded Finnish statutory chart (codes, Finnish names, canonical roles)
//   → the coder's menu is still the pack palette → the real batch coder and
//   the named journal writers post palette-named codings onto the coded rows
//   (bank line, ALV split, document allocation) → the annual-return mapping
//   resolves every born P&L code → Singapore, US and UK births through the
//   same route keep their existing charts.
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { handleDonnaApiRequest } from './api.js';
import { __endFirmDbPoolForTests, batchSuggestTransactionCodingInDb } from './firmDb.js';
import { setClientFlagStage } from './clientConfig.js';
import { fallbackAccountsForPack, loadOutboundPack } from './outbound/packs.js';
import { FI_CODING_POLICY } from './finland/codingPolicy.js';
import { getDonnaLedgerAccountsForClient, __donnaChartMenuAccounts } from './db/ledger.js';
import { accountOptionsForClient } from './transactionLlm.js';
import { requireCodingPolicyForClient } from './codingPolicy.js';
import { buildAnnualReturnFromReadModel } from './finland/annualReturn.js';
import { resolveAccount, resolveStatutoryGroup } from './finland/tilikartta.js';
import { FI_OY_BIRTH_CHART } from './finland/provisioningPolicy.js';
import { US_HOSTED_PILOT_FLAG } from './cloudPilotConfig.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const USER = { id: 'user-fi21', email: 'kirjanpitaja@fi21.example', jwt: 'fi21-jwt' };

const requestJson = async ({ url, token, body }) => {
  const encoded = body ? JSON.stringify(body) : '';
  const req = Readable.from([Buffer.from(encoded)]);
  req.method = body ? 'POST' : 'GET'; req.url = url;
  req.headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(encoded)) };
  let responseBody = ''; let resolveEnded;
  const ended = new Promise((resolve) => { resolveEnded = resolve; });
  const res = { statusCode: 200, setHeader: () => {}, end: (value = '') => { responseBody = Buffer.isBuffer(value) ? value.toString('utf8') : String(value); resolveEnded(); } };
  await handleDonnaApiRequest(req, res);
  await ended;
  return { statusCode: res.statusCode, body: responseBody ? JSON.parse(responseBody) : null };
};

test('real HTTP + PG: a fresh hosted Oy is born with the coded Finnish statutory chart; coding, posting and handoff resolve it; other markets unchanged',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — FI-21 birth lifecycle not exercised' }, async () => {
    const dbName = `donna_fi21_${Date.now().toString(36)}_${process.pid}`;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const scratchUrl = new URL(PG_URL); scratchUrl.pathname = `/${dbName}`;
    const seed = new pg.Client({ connectionString: scratchUrl.toString() });
    await seed.connect();
    const envKeys = ['DATABASE_URL', 'DATABASE_POOL_MAX', 'DONNA_DESKTOP_BLOB_DIR', 'DONNA_ACCESS_TOKEN', 'DONNA_DEFAULT_FIRM_ID',
      'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'DONNA_AUTH_ALLOWED_EMAILS', 'STRIPE_SECRET_KEY',
      'VERCEL', 'VERCEL_PROJECT_ID', 'VERCEL_ENV', 'VERCEL_DEPLOYMENT_ID', 'VERCEL_GIT_COMMIT_SHA', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENAI_MODEL'];
    const priorEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    const realFetch = globalThis.fetch;
    try {
      await seed.query('create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);');
      for (const file of (await readdir(path.join(ROOT, 'db', 'migrations'))).filter((f) => f.endsWith('.sql')).sort()) {
        await seed.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
        await seed.query('insert into schema_migrations(version) values($1) on conflict do nothing', [file.slice(0, -4)]);
      }
      await seed.query("insert into firms(id,name,slug) values('firm-default','Default','default-firm')");
      Object.assign(process.env, {
        DATABASE_URL: scratchUrl.toString(), DATABASE_POOL_MAX: '2', DONNA_ACCESS_TOKEN: 'unused', DONNA_DEFAULT_FIRM_ID: 'firm-default',
        SUPABASE_URL: 'https://auth.fi21.invalid', SUPABASE_ANON_KEY: 'anon', DONNA_AUTH_ALLOWED_EMAILS: 'nobody@example.test',
        VERCEL: '1', VERCEL_PROJECT_ID: 'fixture-project', VERCEL_ENV: 'preview', VERCEL_DEPLOYMENT_ID: 'fixture-deployment',
        VERCEL_GIT_COMMIT_SHA: 'fixture-source', ANTHROPIC_API_KEY: 'fixture-only', OPENAI_API_KEY: 'fixture-only',
        // 2026-11-10: both keys put the text lanes on Claude; this file's stub
        // answers the OpenAI coder, so it pins the text lanes to OpenAI.
        OPENAI_MODEL: 'gpt-5.4'
      });
      delete process.env.DONNA_DESKTOP_BLOB_DIR; delete process.env.SUPABASE_PUBLISHABLE_KEY; delete process.env.STRIPE_SECRET_KEY;
      let coderFetch = null;
      globalThis.fetch = async (url, options = {}) => {
        if (String(url) === 'https://auth.fi21.invalid/auth/v1/user') {
          const token = String(options.headers?.Authorization || '').replace(/^Bearer\s+/i, '');
          return token === USER.jwt ? { ok: true, json: async () => ({ id: USER.id, email: USER.email }) } : { ok: false, json: async () => null };
        }
        if (coderFetch && String(url) === 'https://api.openai.com/v1/responses') return coderFetch(options);
        throw new Error(`Network disabled in proof: ${url}`);
      };
      const api = (url, body) => requestJson({ url, body, token: USER.jwt });

      // 1. Ordinary self-provision, then the hosted Finnish Oy birth route.
      const firm = await api('/api/donna/firms/self-provision', { workspace: 'firm', firm_name: 'Tilitoimisto FI21 Oy', owner_name: 'Kaisa Kirjanpitäjä' });
      assert.equal(firm.statusCode, 201, JSON.stringify(firm.body));
      const firmId = firm.body.firm_id; const memberId = firm.body.member_id;
      const created = await api('/api/donna/firms/clients', { id_scope: 'firm', profile: { id: 'leipomo-fi21', companyName: 'Leipomo Testi Oy', uen: '3224455-8', jurisdiction: 'FI', entityType: 'fi-oy', defaultCurrency: 'EUR',
        // The Oy posts ALV, so its record says it is ALV-registered.
        alv_registration: { status: 'registered', registered_from: '2020-01-01' } } });
      assert.equal(created.statusCode, 200, JSON.stringify(created.body));
      const clientId = created.body.created_client_id;

      // 2. The born chart: every row coded, Finnish statutory names, the
      //    statutory group recorded, roles where lookups need them.
      const chart = (await seed.query(`select code,name,account_type,normal_balance,canonical_role,currency,payload
        from ledger_accounts where firm_id=$1 and client_id=$2 order by code`, [firmId, clientId])).rows;
      assert.equal(chart.length, FI_OY_BIRTH_CHART.accounts.length);
      assert.ok(chart.every((row) => /^\d{4}$/.test(row.code)), 'every born account carries a code');
      assert.equal(new Set(chart.map((row) => row.code)).size, chart.length);
      assert.ok(chart.every((row) => row.payload.source === 'market_birth_chart' && row.payload.birth_chart === 'fi_oy_tilikartta'));
      const byCode = Object.fromEntries(chart.map((row) => [row.code, row]));
      for (const [code, name, role] of [['3000', 'Myynti', 'revenue.operating'], ['7000', 'Vuokrakulut', 'expense.rent'],
        ['1700', 'Myyntisaamiset', 'asset.accounts_receivable'], ['2870', 'Ostovelat', 'liability.accounts_payable'],
        ['2939', 'Suoritettava arvonlisävero', 'liability.sales_tax_payable'], ['2940', 'Vähennettävä arvonlisävero', null],
        ['2000', 'Osakepääoma', 'equity.share_capital'], ['2251', 'Edellisten tilikausien voitto (tappio)', 'equity.retained_earnings'],
        ['2762', 'Lainat osakkailta', 'liability.director_loan'], ['1990', 'Selvittelytili', 'control.suspense']]) {
        assert.equal(byCode[code]?.name, name, code); assert.equal(byCode[code].canonical_role, role, `${code} role`);
      }
      for (const row of chart) {
        if (row.payload.statutory_group) assert.ok(resolveStatutoryGroup(row.payload.statutory_group), `${row.code} group`);
      }
      assert.equal(byCode['1990'].account_type, 'unknown', 'suspense is placed by role, as the palette seed placed it');
      assert.equal(byCode['1910'], undefined, 'no bank row: the bank leg keeps its per-currency account');
      // Singleton role lookups stay unambiguous.
      for (const role of ['revenue.operating', 'asset.accounts_receivable', 'liability.accounts_payable', 'liability.sales_tax_payable', 'equity.retained_earnings', 'control.suspense']) {
        assert.equal(chart.filter((row) => row.canonical_role === role).length, 1, role);
      }
      // Every palette entry an Oy codes against has exactly one coded home, carrying the palette's role.
      const palette = fallbackAccountsForPack(loadOutboundPack('fi'))
        .filter(({ name }) => !FI_CODING_POLICY.loadAccountPalette({ entityType: 'fi-oy' }).excludedAccountNames.includes(name));
      for (const { name, role } of palette) {
        const homes = chart.filter((row) => row.payload.palette_name === name);
        assert.equal(homes.length, 1, name); assert.equal(homes[0].canonical_role, role, `${name} role`);
      }
      const receipts = (await seed.query("select actor_type,metadata from audit_events where client_id=$1 and action='ledger.chart.palette_seeded'", [clientId])).rows;
      assert.equal(receipts.length, 1);
      assert.deepEqual(receipts[0].metadata.birth_chart, { id: 'fi_oy_tilikartta', version: 1 });
      const prepared = (await seed.query("select metadata from audit_events where client_id=$1 and action='pilot.prepared'", [clientId])).rows[0];
      assert.equal(prepared.metadata.chart.seeded, true); assert.equal(prepared.metadata.chart.birth_chart.id, 'fi_oy_tilikartta');

      // 3. The coder's menu is the pack palette plus the statutory rows it
      //    does not name — never a Finnish and an English name for one account.
      const accounts = await getDonnaLedgerAccountsForClient({ client: seed, firmId, clientId });
      const profile = { jurisdiction: 'fi', entityType: 'fi-oy', accounting_system: 'none' };
      const policy = requireCodingPolicyForClient(profile);
      const menu = accountOptionsForClient(__donnaChartMenuAccounts(accounts, { ...profile, codingPolicy: policy }), { ...profile, codingPolicy: policy });
      for (const { name } of palette) assert.ok(menu.includes(name), name);
      assert.ok(!menu.includes('Vuokrakulut') && menu.includes('Rent'));
      assert.ok(menu.includes('Myyntisaamiset') && menu.includes('Ostovelat'), 'statutory rows the palette does not name are offered by their chart name');
      assert.equal(new Set(menu).size, menu.length);

      // 4. Real coder + real writers on the born book. The fixture has no
      //    verified cloud host, so its readiness admission and the first-line
      //    trial coder are paused for this book; the strong coder is stubbed.
      for (const flagKey of ['ENTITY_READINESS_ADMISSION', 'JEV_RECONCILIATION']) {
        await setClientFlagStage(seed, { firmId, clientId, flagKey, stage: 'off', source: 'manual', reason: 'fixture_no_verified_host', actorType: 'firm_member', actorId: memberId });
      }
      const tx = (id, amount, date = '2026-02-27') => seed.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,money_in,currency,status,payload)
        values($1,$2,$3,$5,$1,$4,0,'EUR','needs_review','{}')`, [id, firmId, clientId, amount, date]);
      const doc = async (id, filename, total, tax, components) => {
        await seed.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,document_date,payload)
          values($1,$2,$3,$4,'supplier_bill','completed',$5,$6,'EUR','2026-02-27','{}')`, [id, firmId, clientId, filename, total, tax]);
        for (const [index, [description, amount]] of components.entries()) {
          await seed.query(`insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload) values($1,$2,$3,$4,$5,$6,$7,'{}')`,
            [`${id}-${index}`, firmId, clientId, id, index + 1, description, amount]);
        }
        const bank = id.replace(/-doc$/, '');
        await seed.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload)
          values($1,$2,$3,$4,'supplier_bill',$5,$6,1,'auto_matched','fixture','{}')`, [`match-${bank}`, firmId, clientId, bank, id, total]);
      };
      await tx('rent', 1450); await doc('rent-doc', 'Vuokralasku.pdf', 1450, 0, [['Vuokra helmikuu', 1450]]);
      await tx('withholding', 332.88); await doc('withholding-doc', 'Ennakonpidatys.pdf', 332.88, null, [['Payroll withholding and health-insurance remittance', 332.88]]);
      await tx('paper', 125.5); await doc('paper-doc', 'Toimistotarvikkeet.pdf', 125.5, 25.5, [['Kopiopaperi', 125.5]]);
      await tx('loan', 412.35); await doc('loan-doc', 'Lainalaskelma.pdf', 412.35, null, [['Korko', 67.98], ['Lyhennys', 344.37]]);
      const seenMenus = [];
      coderFetch = async (options) => {
        const request = JSON.parse(options.body); const input = JSON.parse(request.input);
        seenMenus.push(request.text.format.schema.properties.suggestions.items.properties.proposed_account.enum);
        const base = { confidence: 'high', evidence_required: false, auto_explain_limit: 0, reasoning: 'fixture verdict grounded in the supplied source',
          posting_requirement: 'single_account', document_allocations: [], ask_client_question: '' };
        const suggestions = input.transactions.map((row) => ({ transaction_id: row.id, ...base,
          ...(row.id === 'rent' ? { proposed_account: 'Rent', tax_treatment: 'Veroton toiminta (ALV-vapaa)' }
            : row.id === 'paper' ? { proposed_account: 'Office expenses', tax_treatment: 'ALV 25,5 %' }
            : row.id === 'withholding' ? { proposed_account: 'Payroll withholding and employer health-insurance payable', tax_treatment: 'Ei ALV-käsittelyä' }
              : { proposed_account: 'Loan payable', tax_treatment: 'Ei ALV-käsittelyä', posting_requirement: 'document_allocation',
                document_allocations: [{ line_handle: 'line_1', account: 'Interest expense' }, { line_handle: 'line_2', account: 'Loan payable' }] }) }));
        return { ok: true, status: 200, json: async () => ({ id: 'fixture-response', output_text: JSON.stringify({ suggestions, group_summary: [] }) }) };
      };
      await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
      assert.ok(seenMenus.length && seenMenus.every((names) => names.includes('Rent') && !names.includes('Vuokrakulut')), 'the coder still speaks the palette');
      const posted = async (source) => (await seed.query(`select l.account_code,l.account_name,a.code,a.name,l.debit,l.credit
        from ledger_lines l join ledger_accounts a on a.id=l.account_id join ledger_journals j on j.id=l.journal_id
        where j.firm_id=$1 and j.client_id=$2 and j.source_id=$3 order by l.line_no`, [firmId, clientId, source])).rows
        .map((row) => [row.account_code, row.account_name, row.code, Number(row.debit), Number(row.credit)]);
      assert.deepEqual(await posted('rent'), [['7000', 'Vuokrakulut', '7000', 1450, 0], [null, 'Business Checking · EUR', null, 0, 1450]]);
      // ALV split: the net base on the born expense row, the input VAT on 2940.
      assert.deepEqual(await posted('paper'), [['7740', 'Toimistotarvikkeet ja -kulut', '7740', 100, 0],
        ['2940', 'Vähennettävä arvonlisävero', '2940', 25.5, 0], [null, 'Business Checking · EUR', null, 0, 125.5]]);
      assert.deepEqual(await posted('withholding'), [['2945', 'Ennakonpidätys- ja sosiaaliturvamaksuvelat', '2945', 332.88, 0], [null, 'Business Checking · EUR', null, 0, 332.88]]);
      assert.deepEqual(await posted('loan'), [['9200', 'Korkokulut', '9200', 67.98, 0], ['2620', 'Lainat rahoituslaitoksilta', '2620', 344.37, 0], [null, 'Business Checking · EUR', null, 0, 412.35]]);
      // No code-less English duplicate was minted beside a born row.
      const after = (await seed.query('select code,name from ledger_accounts where firm_id=$1 and client_id=$2', [firmId, clientId])).rows;
      assert.deepEqual(after.filter((row) => !row.code).map((row) => row.name), ['Business Checking · EUR']);
      assert.equal(after.length, chart.length + 1);

      // 5. The handoff mapping works from the codes: every born P&L account
      //    resolves to a statutory income-statement line in the annual return.
      const pl = chart.filter((row) => ['revenue', 'expense'].includes(row.account_type));
      assert.ok(pl.length > 20);
      const annual = buildAnnualReturnFromReadModel({ taxYear: 2026,
        profitAndLoss: { rows: pl.map((row) => ({ code: row.code, name: row.name, revenue: row.account_type === 'revenue' ? 1 : 0, expense: row.account_type === 'expense' ? 1 : 0 })) } });
      assert.deepEqual(annual.unmappedIncomeStatementRows, []);
      for (const row of pl) assert.equal(resolveAccount(row.code)?.statutory_group, row.payload.statutory_group, row.code);

      // 6. Neighbouring markets through the same route keep their charts:
      //    SG review and US accounting births seed the code-less pack palette
      //    exactly as before; a UK company gets no hosted chart.
      const legacyPalette = (packId) => fallbackAccountsForPack(loadOutboundPack(packId))
        .map(({ name, role }) => ({ code: null, name, canonical_role: role, source: 'pack_palette_seed' }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const chartOf = async (id) => (await seed.query(`select code,name,canonical_role,payload->>'source' as source
        from ledger_accounts where firm_id=$1 and client_id=$2 order by name`, [firmId, id])).rows;
      const sg = await api('/api/donna/firms/clients', { id_scope: 'firm', profile: { id: 'kopi-fi21', companyName: 'Kopi Test Pte Ltd', jurisdiction: 'SG', entityType: 'sg-pte', defaultCurrency: 'SGD', accountingCurrency: 'SGD', accounting_system: 'none', accounting_view: 'management_books' } });
      assert.equal(sg.statusCode, 200, JSON.stringify(sg.body));
      assert.deepEqual((await chartOf(sg.body.created_client_id)).sort((a, b) => a.name.localeCompare(b.name)), legacyPalette('sg'));
      await setClientFlagStage(seed, { firmId, clientId: null, flagKey: US_HOSTED_PILOT_FLAG, stage: 'auto', source: 'manual', reason: 'fixture_us_pilot', actorType: 'firm_member', actorId: memberId });
      const us = await api('/api/donna/firms/clients', { id_scope: 'firm', profile: { id: 'diner-fi21', companyName: 'Diner Test LLC', jurisdiction: 'US', entityType: 'us-llc', defaultCurrency: 'USD', accountingCurrency: 'USD', accounting_system: 'none', accounting_view: 'management_books' } });
      assert.equal(us.statusCode, 200, JSON.stringify(us.body));
      assert.deepEqual((await chartOf(us.body.created_client_id)).sort((a, b) => a.name.localeCompare(b.name)), legacyPalette('us'));
      const gb = await api('/api/donna/firms/clients', { id_scope: 'firm', profile: { id: 'cafe-fi21', companyName: 'Cafe Test Ltd', jurisdiction: 'GB', entityType: 'gb-ltd', defaultCurrency: 'GBP' } });
      assert.equal(gb.statusCode, 200, JSON.stringify(gb.body));
      assert.deepEqual(await chartOf(gb.body.created_client_id), []);
    } finally {
      globalThis.fetch = realFetch;
      await __endFirmDbPoolForTests();
      for (const key of envKeys) { if (priorEnv[key] === undefined) delete process.env[key]; else process.env[key] = priorEnv[key]; }
      await seed.end().catch(() => {});
      await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()', [dbName]).catch(() => {});
      await admin.query(`drop database if exists "${dbName}"`).catch(() => {});
      await admin.end().catch(() => {});
    }
  });
