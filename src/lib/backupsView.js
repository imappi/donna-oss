// Display projections for the Data & storage backups card. Pure functions
// over the /desktop-backups payload — the card renders persisted state (the
// packages on disk, the configured cron), never an invented "Today 03:00".

// The cron default and its common shapes, humanized; anything unrecognized
// renders as the raw expression (mono) rather than a wrong guess.
export const humanizeBackupCron = (cron) => {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(String(cron || '').trim());
  if (!match) return cron || '';
  const minute = String(match[1]).padStart(2, '0');
  const hour = String(match[2]).padStart(2, '0');
  return `Daily, ${hour}:${minute}`;
};

export const formatBackupTime = (iso) => {
  if (!iso) return '';
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '';
  const today = new Date();
  const sameDay = when.toDateString() === today.toDateString();
  const time = when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Today ${time}`;
  return `${when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
};

const REASON_LABELS = {
  daily: 'scheduled',
  manual: 'manual',
  'pre-migration': 'pre-migration'
};

// "Today 01:30 · scheduled · 214 documents" — or the honest empty/broken
// states. The last backup shown is the newest package whose manifest still
// checksums; a package that doesn't is not a backup to count on.
export const describeLastBackup = (backups) => {
  const usable = (backups || []).find((entry) => entry.manifest_ok);
  if (!usable) return { label: 'None yet', detail: '', ok: false };
  const parts = [
    formatBackupTime(usable.created_at),
    REASON_LABELS[usable.reason] || usable.reason || null,
    usable.blob_count != null ? `${usable.blob_count} document${usable.blob_count === 1 ? '' : 's'}` : null
  ].filter(Boolean);
  return { label: parts[0] || usable.name, detail: parts.slice(1).join(' · '), ok: true };
};
