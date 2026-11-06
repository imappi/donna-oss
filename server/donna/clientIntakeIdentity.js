import { createHash } from 'node:crypto';

const scopedId = (kind, firmId, id) => `${kind}-${createHash('sha256')
  .update(JSON.stringify([firmId, id])).digest('hex')}`;

// A company identifier describes the business, not ownership of its book.
// Preserve a firm's legacy book on re-intake; new books get firm-scoped IDs.
// The existing writer still refuses any attempt to reassign a persisted ID.
export const resolveFirmIntakeIdentity = async ({ firmId, profile, queue = [], withFirmDbClientFn }) => {
  if (!profile?.id) return { profile, queue }; // Existing writer owns validation.
  const legacyExists = await withFirmDbClientFn(async (client) => {
    const result = await client.query(
      'select id from clients where firm_id = $1 and id = $2 limit 1',
      [firmId, profile.id]
    );
    return result.rows.length > 0;
  });
  if (legacyExists) return { profile, queue };
  const clientId = scopedId('client', firmId, profile.id);
  return {
    profile: { ...profile, id: clientId },
    queue: queue.map((item) => item?.id ? {
      ...item,
      id: scopedId('queue', firmId, item.id),
      client_id: clientId
    } : item)
  };
};
