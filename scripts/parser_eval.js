#!/usr/bin/env node
// Parser eval baseline — measures extraction quality across test clients.
//
// Reports:
//   - Field fill rate (vendor_name, document_date, total_amount, currency)
//   - Candidate source breakdown (llm_extraction, filename, llm_repair)
//   - Parse status distribution (completed, failed, skipped)
//   - Match rate delta vs previous run (when --compare baseline is given)
//
// Usage:
//   node scripts/parser_eval.js
//   node scripts/parser_eval.js --client=honeybee-hills-apiary
//   node scripts/parser_eval.js --save
//   node scripts/parser_eval.js --compare data/evals/parser_baseline_honeybee-hills-apiary.json

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { queryFirmDb } from '../server/donna/firmDb.js';

const FIRM_ID = process.env.FIRM_ID || 'donna-demo-firm';

const ALL_CLIENTS = [
  'honeybee-hills-apiary',
  'alex-morgan-personal',
  'cactus-blossom-cafe',
  'jasons-rental-llc',
  'lone-star-apiaries'
];

const CRITICAL_FIELDS = ['vendor_name', 'document_date', 'total_amount', 'currency'];

const parseArgs = () => {
  const args = { client: null, save: false, compare: null };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--client=')) args.client = arg.slice('--client='.length);
    if (arg === '--save') args.save = true;
    if (arg.startsWith('--compare=')) args.compare = arg.slice('--compare='.length);
  }
  return args;
};

const fetchDocuments = async (clientId) => {
  const result = await queryFirmDb(
    `select id, client_id, document_type, filename, parse_status,
            vendor_name, customer_name, document_date, total_amount,
            currency, tax_amount, reference_number, extraction_confidence,
            parse_summary, parse_error
       from documents
      where firm_id = $1 and client_id = $2
      order by created_at`,
    [FIRM_ID, clientId]
  );
  return result.rows;
};

const fetchMatchStats = async (clientId) => {
  const result = await queryFirmDb(
    `select
       count(*)::int as total_matches,
       count(*) filter (where status in ('confirmed', 'auto_matched'))::int as confirmed,
       count(*) filter (where status = 'suggested')::int as suggested,
       count(*) filter (where status = 'rejected')::int as rejected
     from reconciliation_matches
     where firm_id = $1 and client_id = $2`,
    [FIRM_ID, clientId]
  );
  return result.rows[0] || { total_matches: 0, confirmed: 0, suggested: 0, rejected: 0 };
};

const analyzeClient = async (clientId) => {
  const documents = await fetchDocuments(clientId);
  const matchStats = await fetchMatchStats(clientId);

  const statusCounts = { completed: 0, failed: 0, skipped: 0, processing: 0, pending: 0, other: 0 };
  const typeCounts = {};
  const fieldFills = {};
  const candidateSourceCounts = { llm_extraction: 0, filename: 0, llm_repair: 0 };
  const warningCounts = {};

  for (const field of CRITICAL_FIELDS) {
    fieldFills[field] = { filled: 0, null: 0 };
  }

  for (const doc of documents) {
    const status = doc.parse_status || 'other';
    statusCounts[status] = (statusCounts[status] || 0) + 1;

    const type = doc.document_type || 'unknown';
    typeCounts[type] = (typeCounts[type] || 0) + 1;

    if (status !== 'completed') continue;

    for (const field of CRITICAL_FIELDS) {
      if (doc[field] != null && doc[field] !== '') {
        fieldFills[field].filled += 1;
      } else {
        fieldFills[field].null += 1;
      }
    }

    const summary = doc.parse_summary || {};
    for (const candidateField of ['vendor_candidates', 'date_candidates', 'amount_candidates']) {
      const candidates = Array.isArray(summary[candidateField]) ? summary[candidateField] : [];
      for (const c of candidates) {
        const source = c?.source || 'unknown';
        candidateSourceCounts[source] = (candidateSourceCounts[source] || 0) + 1;
      }
    }

    const warnings = Array.isArray(summary.warnings) ? summary.warnings : [];
    for (const w of warnings) {
      warningCounts[w] = (warningCounts[w] || 0) + 1;
    }
  }

  const completed = statusCounts.completed;
  const fillRates = {};
  for (const field of CRITICAL_FIELDS) {
    const { filled } = fieldFills[field];
    fillRates[field] = completed > 0 ? Number((filled / completed).toFixed(4)) : 0;
  }

  return {
    client_id: clientId,
    total_documents: documents.length,
    status: statusCounts,
    types: typeCounts,
    field_fills: fieldFills,
    fill_rates: fillRates,
    candidate_sources: candidateSourceCounts,
    warnings: warningCounts,
    matches: matchStats
  };
};

const printClientReport = (report) => {
  const { client_id, total_documents, status, fill_rates, candidate_sources, matches, warnings } = report;

  console.log(`\n── ${client_id} (${total_documents} docs) ──`);
  console.log(`  Status: ${status.completed} completed, ${status.failed} failed, ${status.skipped} skipped, ${status.pending + status.processing} pending/processing`);

  console.log('  Fill rates (completed docs):');
  for (const [field, rate] of Object.entries(fill_rates)) {
    const pct = (rate * 100).toFixed(0);
    const bar = '█'.repeat(Math.round(rate * 20)) + '░'.repeat(20 - Math.round(rate * 20));
    console.log(`    ${field.padEnd(18)} ${bar} ${pct}%`);
  }

  const totalCandidates = Object.values(candidate_sources).reduce((a, b) => a + b, 0);
  if (totalCandidates > 0) {
    console.log(`  Candidate sources: ${JSON.stringify(candidate_sources)}`);
  }

  const repairCount = (warnings.repaired_vendor_name || 0) +
    (warnings.repaired_document_date || 0) +
    (warnings.repaired_total_amount || 0);
  if (repairCount > 0) {
    console.log(`  Repairs: ${repairCount} fields repaired by LLM repair loop`);
  }

  const filenameCount = (warnings.vendor_from_filename || 0) +
    (warnings.date_from_filename || 0) +
    (warnings.amount_from_filename || 0);
  if (filenameCount > 0) {
    console.log(`  Filename fallback: ${filenameCount} fields filled from filename`);
  }

  console.log(`  Matches: ${matches.confirmed} confirmed, ${matches.suggested} suggested, ${matches.rejected} rejected`);
};

const compareWithBaseline = (current, baseline) => {
  console.log('\n── Delta vs baseline ──');

  for (const field of CRITICAL_FIELDS) {
    const curr = current.fill_rates[field] || 0;
    const prev = baseline.fill_rates?.[field] || 0;
    const delta = curr - prev;
    const sign = delta >= 0 ? '+' : '';
    console.log(`  ${field.padEnd(18)} ${(prev * 100).toFixed(0)}% → ${(curr * 100).toFixed(0)}% (${sign}${(delta * 100).toFixed(0)}pp)`);
  }

  const currTotal = current.matches?.confirmed || 0;
  const prevTotal = baseline.matches?.confirmed || 0;
  if (currTotal !== prevTotal) {
    console.log(`  Confirmed matches: ${prevTotal} → ${currTotal} (${currTotal > prevTotal ? '+' : ''}${currTotal - prevTotal})`);
  }
};

async function main() {
  const { client, save, compare } = parseArgs();
  const clients = client ? [client] : ALL_CLIENTS;

  console.log(`[parser_eval] firm=${FIRM_ID}, clients=${clients.join(', ')}`);

  const reports = [];
  for (const clientId of clients) {
    try {
      const report = await analyzeClient(clientId);
      reports.push(report);
      printClientReport(report);
    } catch (err) {
      console.error(`  Error analyzing ${clientId}: ${err.message}`);
    }
  }

  if (reports.length > 1) {
    console.log('\n── Aggregate ──');
    const totals = { docs: 0, completed: 0, failed: 0 };
    const aggFills = {};
    for (const field of CRITICAL_FIELDS) aggFills[field] = { filled: 0, total: 0 };

    for (const r of reports) {
      totals.docs += r.total_documents;
      totals.completed += r.status.completed;
      totals.failed += r.status.failed;
      for (const field of CRITICAL_FIELDS) {
        aggFills[field].filled += r.field_fills[field]?.filled || 0;
        aggFills[field].total += (r.field_fills[field]?.filled || 0) + (r.field_fills[field]?.null || 0);
      }
    }

    console.log(`  Total: ${totals.docs} docs, ${totals.completed} completed, ${totals.failed} failed`);
    for (const field of CRITICAL_FIELDS) {
      const { filled, total } = aggFills[field];
      const rate = total > 0 ? (filled / total * 100).toFixed(0) : 0;
      console.log(`  ${field.padEnd(18)} ${filled}/${total} = ${rate}%`);
    }
  }

  if (compare && reports.length === 1) {
    try {
      const baselinePath = resolvePath(process.cwd(), compare);
      const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
      compareWithBaseline(reports[0], baseline.report || baseline);
    } catch (err) {
      console.error(`  Could not load baseline: ${err.message}`);
    }
  }

  if (save) {
    const evalsDir = resolvePath(process.cwd(), 'data', 'evals');
    mkdirSync(evalsDir, { recursive: true });

    for (const report of reports) {
      const fixture = {
        meta: {
          client_id: report.client_id,
          firm_id: FIRM_ID,
          generated_at: new Date().toISOString(),
          eval_type: 'parser'
        },
        report
      };

      const outPath = resolvePath(evalsDir, `parser_baseline_${report.client_id}.json`);
      writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n');
      console.log(`\nSaved parser baseline to ${outPath}`);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Parser eval failed:', err.message || err);
  process.exit(1);
});
