// The stored record of a replay demo (migration 205): one insert per start of
// `npm run demo:fi`, read by the health route so every screen can say
// "Demo: recorded model outputs". The writer is called only by
// scripts/demo_fi.mjs; nothing in the runtime writes it.

import { randomUUID } from 'node:crypto';

export const recordProviderReplaySession = async ({ withFirmDbClientFn, replay, firmId, clientId }) => {
  if (!replay || replay.mode !== 'replay') throw new Error('recordProviderReplaySession needs the active replay');
  return withFirmDbClientFn(async (client) => {
    const result = await client.query(
      `insert into provider_replay_sessions
         (id, pack, scope_firm_id, scope_client_id, recordings_digest, recordings_recorded_at, recorded_models, recorded_answers)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       returning id, started_at`,
      [
        `replay-${randomUUID()}`,
        replay.pack || 'unknown',
        firmId,
        clientId,
        replay.recordings_digest || 'unknown',
        replay.recorded_at || null,
        JSON.stringify(replay.models || {}),
        Number(replay.entries) || 0
      ]
    );
    return result.rows[0];
  });
};

// The latest session on this book, or null (a normal book, or a database
// that predates migration 205). Never throws: the health route calls it.
export const readLatestProviderReplaySession = async ({ queryFn }) => {
  try {
    const result = await queryFn(
      `select id, started_at, pack, scope_firm_id, scope_client_id, recordings_digest, recordings_recorded_at, recorded_models, recorded_answers
         from provider_replay_sessions order by started_at desc limit 1`
    );
    const row = result.rows?.[0];
    if (!row) return null;
    return {
      id: row.id,
      started_at: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at,
      pack: row.pack,
      client_id: row.scope_client_id,
      recorded_at: row.recordings_recorded_at || null,
      recorded_models: row.recorded_models || {},
      recorded_answers: row.recorded_answers
    };
  } catch {
    return null;
  }
};
