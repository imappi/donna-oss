// Node-safe production projection for the owner-facing Actions inventory.
// Keep this module free of JSX and browser dependencies: the EAW parity runner
// consumes the same decision spine as the mounted UI.

export const DONNA_WORKING = 'donna_working';

const DECIDABLE_RISK = new Set([
  'tax_sensitive',
  'owner_personal',
  'contractor_classification'
]);

export const OWNER_SCOPE_OF_BUCKET = Object.freeze({
  operator_blocker: 'for_you',
  confirmable: 'donna',
  client_info_needed: 'waiting',
  donna_working: 'donna',
  auto_cleared: 'done'
});

const KNOWN_SOURCE_KINDS = new Set([
  'reconciliation_match',
  'failed_parse',
  'client_evidence_request',
  'ask_batch_draft',
  'review_item'
]);

export const isUserDecidable = (item) => {
  if (item?.kind === 'failed_parse') return true;
  if (item?.kind === 'ask_batch_draft') return true;
  return DECIDABLE_RISK.has(item?.verdict?.risk_class);
};

// Accounting decisions belong to the period of their persisted transaction or
// document anchor. The only operator-blocker that is deliberately venture-wide
// is a drafted client message: one draft can cover several lines and months, so
// forcing it into one month would invent ownership the receipt does not carry.
export const isPeriodOwnedDecision = (item) => {
  if (!isUserDecidable(item) || item?.kind === 'ask_batch_draft') return false;
  return Boolean(
    item?.transaction_id
    || item?.document_id
    || (item?.kind === 'review_item' && ['transaction', 'document'].includes(item?.item_type) && item?.item_id)
  );
};

export const periodOwnedDecisionItems = (feed, clientId = null) => {
  if (!feed?.buckets) return [];
  return (presentFeedBuckets(feed.buckets).operator_blocker || []).filter((item) => (
    (!clientId || item?.client_id === clientId) && isPeriodOwnedDecision(item)
  ));
};

// Presentation partition over buildFirmFeed's persisted dispositions. Drafts
// are the single owner task for their explicitly covered transaction anchors.
export const presentFeedBuckets = (buckets = {}) => {
  // `confirmable` is a conservative close-engine state, not a human inbox
  // lane. It originated as a backup-bookkeeper queue before the owner model
  // converged on For you / Waiting / Donna / Done. Preserve every item and
  // its verdict, but present it under Donna's collapsed workload.
  const out = {
    operator_blocker: [],
    [DONNA_WORKING]: [
      ...(buckets?.confirmable || []),
      ...(buckets?.[DONNA_WORKING] || [])
    ]
  };
  const draftCoveredTransactionIds = new Set(
    (buckets?.operator_blocker || [])
      .filter((item) => item?.kind === 'ask_batch_draft')
      .flatMap((item) => item.covered_transaction_ids || [])
      .filter(Boolean)
  );
  for (const key of Object.keys(buckets || {})) {
    if (!Object.prototype.hasOwnProperty.call(OWNER_SCOPE_OF_BUCKET, key)) {
      throw new Error(`owner projection: unrecognised feed bucket ${key}`);
    }
    if (key === 'operator_blocker' || key === 'confirmable' || key === DONNA_WORKING) continue;
    out[key] = (buckets[key] || []).slice();
  }
  for (const item of buckets?.operator_blocker || []) {
    if (
      item?.kind !== 'ask_batch_draft'
      && item?.transaction_id
      && draftCoveredTransactionIds.has(item.transaction_id)
    ) continue;
    (isUserDecidable(item) ? out.operator_blocker : out[DONNA_WORKING]).push(item);
  }
  return out;
};

const usableIdentityPart = (value) =>
  (typeof value === 'string' || typeof value === 'number')
  && String(value).trim().length > 0;

/**
 * Identity-preserving owner-facing projection of buildFirmFeed output.
 *
 * `canonical_identity` is `${source_kind}:${source_id}`. Both components are
 * persisted feed provenance, never array position or presentation order.
 * Invalid, duplicate, or unclassified parity-population rows fail closed.
 */
export const projectEntityOwnerInventory = (feed, clientId = null) => {
  if (!feed?.buckets) return [];
  const inventory = [];
  const identities = new Set();
  const presented = presentFeedBuckets(feed.buckets);

  for (const [bucket, items] of Object.entries(presented)) {
    const ownerState = OWNER_SCOPE_OF_BUCKET[bucket];
    if (!ownerState) throw new Error(`owner projection: ambiguous owner classification for bucket ${bucket}`);
    if (!Array.isArray(items)) throw new Error(`owner projection: bucket ${bucket} is not an array`);
    for (const item of items) {
      if (clientId && item?.client_id !== clientId) continue;
      const allowedDispositions = bucket === DONNA_WORKING
        ? new Set(['operator_blocker', 'confirmable'])
        : new Set([bucket]);
      if (!allowedDispositions.has(item?.verdict?.disposition)) {
        throw new Error(
          `owner projection: ambiguous owner classification for ${item?.kind ?? '<missing>'} in ${bucket}`
        );
      }
      if (!KNOWN_SOURCE_KINDS.has(item?.kind)) {
        throw new Error(`owner projection: unrecognised source kind ${item?.kind ?? '<missing>'}`);
      }
      if (!usableIdentityPart(item.source_id)) {
        throw new Error(`owner projection: ${item.kind} lacks a usable source identity`);
      }
      const canonicalIdentity = `${item.kind}:${String(item.source_id).trim()}`;
      if (identities.has(canonicalIdentity)) {
        throw new Error(`owner projection: duplicate canonical identity ${canonicalIdentity}`);
      }
      identities.add(canonicalIdentity);
      inventory.push(Object.freeze({
        canonical_identity: canonicalIdentity,
        owner_state: ownerState,
        owner_bucket: bucket,
        source_kind: item.kind,
        source_id: item.source_id,
        client_id: item.client_id ?? null,
        transaction_id: item.transaction_id ?? null,
        document_id: item.document_id ?? null,
        classification: Object.freeze({
          disposition: item.verdict?.disposition ?? null,
          risk_class: item.verdict?.risk_class ?? null,
          blocks_close: Boolean(item.verdict?.blocks_close),
          presentation_decidable: bucket === 'operator_blocker'
        })
      }));
    }
  }
  return inventory;
};

// Aggregate UI semantics are deliberately a reduction over the inventory.
export const entityOwnerCounts = (feed, clientId = null) =>
  projectEntityOwnerInventory(feed, clientId).reduce((counts, item) => {
    counts[item.owner_state] += 1;
    return counts;
  }, { for_you: 0, waiting: 0, donna: 0, done: 0 });
