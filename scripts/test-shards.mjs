import { createHash } from 'node:crypto';

// Timing changes affect scheduling only; discovery remains the test inventory.
export function planShards(files, durations = {}, count = 4) {
  if (!Number.isInteger(count) || count < 1 || count > 32) throw new Error('Invalid shard count');
  if (new Set(files).size !== files.length) throw new Error('Duplicate discovered test');
  const weight = file => Number.isFinite(durations[file]) && durations[file] > 0 ? durations[file] : 1000;
  const shards = Array.from({ length: count }, () => ({ files: [], estimatedMs: 0 }));
  for (const file of [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b, 'en'))) {
    const target = shards.reduce((best, next) => next.estimatedMs < best.estimatedMs ? next : best);
    target.files.push(file);
    target.estimatedMs += weight(file);
  }
  for (const shard of shards) shard.files.sort();
  return shards;
}

export function parseShard(value = '1/1') {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (!match || index < 1 || count < index || count > 32) throw new Error(`Invalid shard: ${value}`);
  return { index, count };
}

export function inventoryDigest(files) {
  return createHash('sha256').update(JSON.stringify([...files].sort())).digest('hex');
}

export function verifyShardReceipts(plan, receipts, { revision, timezone }) {
  if (receipts.length !== plan.length) throw new Error('Missing or extra shard receipts');
  const inventory = plan.flatMap(shard => shard.files);
  const digest = inventoryDigest(inventory);
  const seen = new Set();
  for (const receipt of receipts) {
    const index = receipt?.shard?.index;
    if (!Number.isInteger(index) || index < 1 || index > plan.length || seen.has(index)) throw new Error('Invalid or duplicate shard receipt');
    seen.add(index);
    if (receipt.shard.count !== plan.length || receipt.status !== 'passed' || receipt.revision !== revision || receipt.timezone !== timezone || receipt.inventoryDigest !== digest) throw new Error('Failed or foreign shard receipt');
    const expected = plan[index - 1].files;
    if (JSON.stringify(receipt.files?.map(row => row.file).sort()) !== JSON.stringify(expected)) throw new Error('Incomplete or duplicate test coverage');
    if (receipt.files.some(row => !['passed', 'expected_failure_matched'].includes(row.outcome) || !Number.isFinite(row.durationMs) || row.durationMs < 0)) throw new Error('Invalid test result');
  }
  return inventory.length;
}
