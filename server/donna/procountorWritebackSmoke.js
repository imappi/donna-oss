// Procountor writeback smoke classifier. Pure helper used by the future live
// validation CLI; mirrors the QBO smoke harness while the connector remains a
// capability trial (clientAxes.available=false).
export const classifyProcountorWritebackSmoke = ({ dryRun, execute, verify, retry } = {}) => {
  const dryRunOk = dryRun?.xero_writeback?.status === 'preview' || dryRun?.xero_writeback?.dry_run === true;
  const executeOk = execute?.xero_writeback?.status === 'synced' && Boolean(execute?.xero_writeback?.procountor_journal_entry_id || execute?.xero_writeback?.journal_id);
  const counts = verify?.procountor_mirror_verification?.counts || {};
  const verifyOk = (counts.ok ?? counts.mirror_ok ?? 0) > 0 && (counts.drift ?? counts.mirror_drift ?? 0) === 0 && (counts.missing ?? counts.mirror_missing ?? 0) === 0;
  const retryOk = !retry || (retry?.xero_mirror_retry?.counts?.errors || 0) === 0;
  return {
    status: dryRunOk && executeOk && verifyOk && retryOk ? 'passed' : 'failed',
    checks: { dry_run: dryRunOk, execute: executeOk, verify: verifyOk, retry: retryOk }
  };
};
