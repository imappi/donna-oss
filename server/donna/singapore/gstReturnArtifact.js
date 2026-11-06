// SG-6: a read-only review artifact, not a gst_returns filing workflow row.
// The registered firm report route consumes this adapter; future B8 packaging
// can include its serialized bytes without introducing another tax calculation.
import { withFirmDbClient } from '../db/pool.js';
import { requireClientInFirm } from '../db/clients.js';
import { GST_F5_BOXES } from './gstCodes.js';
import { assertGstF5Foots, resolveGstPeriod } from './gstReturn.js';
import { getSingaporeGstReturnFromDb } from './statutoryDb.js';
import { readSingaporeGstSourceReadiness } from './gstSourceReadiness.js';

export const buildSingaporeGstDraftArtifact = ({ firmId, clientId, computed, sourceReadiness }) => {
  assertGstF5Foots(computed.gstReturn);
  const sourceBlockers = sourceReadiness
    ? [...new Set(sourceReadiness.concerns.flatMap(item => item.reasons))].map(reason => `local_source:${reason}`)
    : ['local_source:observation_missing'];
  return {
    // Preserve the entire source envelope, including readiness, assumptions,
    // blockers, individual boxes and unconfirmed provenance. No new totals.
    // Spread BEFORE the fixed labels so a future compute key cannot override them.
    ...computed,
    artifact_type: 'singapore_gst_f5_draft',
    schema_version: 2,
    title: 'GST F5 draft — firm review',
    firm_id: firmId,
    client_id: clientId,
    jurisdiction: 'SG',
    currency: 'SGD',
    as_of: computed.provenance.readAt,
    scope: 'draft_for_firm_review',
    filing: { submitted: false, channel: null },
    calculation_review: computed.review,
    source_readiness: sourceReadiness ?? null,
    review: { ...computed.review,
      status: computed.review.status === 'ready' && !sourceBlockers.length ? 'ready' : 'needs_review',
      blockers: [...computed.review.blockers, ...sourceBlockers] },
    box_definitions: GST_F5_BOXES,
    limitations: [
      'Draft for qualified firm review; the firm reviews and files externally.',
      'Computation readiness is not statutory verification or filing readiness.',
      'A nil calculation means no taxable posted input was counted; unfinished or undated local sources may remain.',
      'GST is not yet coded or split at posting in Singapore books, so a nil or partial figure is not a return; the period is blocked while posted activity carries no GST code.',
      'Box 13 is the sum of revenue-type ledger lines as posted; it may include exempt or out-of-scope income (for example interest) and the firm confirms its basis before filing.',
      'Qualified professional review is still pending; this artifact does not establish client reliance.'
    ]
  };
};

export const singaporeGstDraftFilename = artifact =>
  `donna-sg-gst-f5-draft-${artifact.period.key}.json`;

export const getSingaporeGstDraftArtifactFromDb = async ({
  firmId, clientId, period, readAt,
  withFirmDbClientFn = withFirmDbClient
} = {}) => {
  if (!firmId || !clientId || !readAt) {
    throw Object.assign(new Error('Firm, client and read time are required for a GST draft artifact.'), { statusCode: 400 });
  }
  const resolved = resolveGstPeriod(period);
  return withFirmDbClientFn(async client => {
    // Identity, denomination and calculation describe ONE database snapshot.
    // No lock, filing row, ask, grant, posting or model call is created here.
    await client.query('begin isolation level repeatable read read only');
    try {
      await requireClientInFirm({ client, firmId, clientId });
      // Jurisdiction, SGD denomination and ledger identity are refused by the
      // reader itself (statutoryDb.js — the one owner), so the filing lane that
      // reuses it is guarded identically.
      const computed = await getSingaporeGstReturnFromDb({
        firmId, clientId, period: resolved.key, readAt,
        withFirmDbClientFn: fn => fn(client)
      });
      const sourceReadiness = await readSingaporeGstSourceReadiness({
        client, firmId, clientId, period: resolved, readAt
      });
      const artifact = buildSingaporeGstDraftArtifact({ firmId, clientId, computed, sourceReadiness });
      await client.query('commit');
      return artifact;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};
