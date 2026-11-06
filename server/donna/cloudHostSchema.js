// Shared read-only cloud schema inventory; catalog parity alone is not readiness.
export const PILOT_REQUIRED_COLUMNS = Object.freeze({
  clients: ['firm_id', 'jurisdiction', 'entity_type', 'profile'],
  documents: ['firm_id', 'client_id', 'parse_status', 'parse_run_id', 'parse_event_sent_at', 'parse_stage', 'convergence_state'],
  transactions: ['firm_id', 'client_id', 'currency', 'coding_state', 'convergence_state'],
  ledger_journals: ['firm_id', 'client_id', 'journal_date', 'status'],
  ledger_lines: ['firm_id', 'client_id', 'journal_id', 'tax_type'],
  client_capability_config: ['firm_id', 'client_id', 'flag_key', 'stage', 'source', 'valid_to'],
  firm_collaborators: ['firm_id', 'user_id', 'access_level', 'status'],
  client_assignments: ['firm_id', 'client_id', 'principal_id', 'assignment_kind', 'ends_at'],
  client_evidence_requests: ['firm_id', 'client_id', 'status', 'audience'],
  loop_event_inbox: ['firm_id', 'status'], loop_event_outbox: ['firm_id', 'status'],
  runtime_host_readiness: ['host_id', 'runtime_host', 'status'],
  entity_readiness_sagas: ['firm_id', 'client_id', 'state', 'ready_dependency_digest']
});

export const compareHostedPilotSchema = ({ expected, applied, columns, allowedHistorical = [] }) => {
  const actual = new Set(applied);
  const available = new Set(columns.map(row => `${row.table_name}.${row.column_name}`));
  const missingMigrations = expected.filter(version => !actual.has(version));
  const unexpectedMigrations = applied.filter(version => !expected.includes(version) && !allowedHistorical.includes(version));
  const missingColumns = Object.entries(PILOT_REQUIRED_COLUMNS).flatMap(([table, names]) =>
    names.filter(name => !available.has(`${table}.${name}`)).map(name => `${table}.${name}`));
  return { status: missingMigrations.length || unexpectedMigrations.length || missingColumns.length ? 'FAIL' : 'PASS',
    expected_migration_count: expected.length, applied_migration_count: applied.length,
    missing_migrations: missingMigrations, unexpected_migrations: unexpectedMigrations, missing_columns: missingColumns };
};

