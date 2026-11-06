#!/usr/bin/env node

// The official PostgreSQL service used by CI is plain Postgres, while
// migration 010 targets Supabase's storage schema. The desktop host already
// creates this exact compatibility stub before migrating; CI does the same so
// every migration and every real-PG test runs on the pinned host dependency.

import process from 'node:process';
import { pathToFileURL } from 'node:url';

import pg from 'pg';

const { Client } = pg;

export const prepareCiHostPostgres = async ({ databaseUrl = process.env.DATABASE_URL } = {}) => {
  if (!databaseUrl) throw new Error('DATABASE_URL is required; CI PostgreSQL was not provisioned.');
  const parsed = new URL(databaseUrl);
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`Refusing to prepare a non-local PostgreSQL host (${parsed.hostname}).`);
  }
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`
      create schema if not exists storage;
      create table if not exists storage.buckets (
        id text primary key, name text, public boolean,
        file_size_limit bigint, allowed_mime_types text[]);
      create table if not exists storage.objects (
        id uuid default gen_random_uuid() primary key,
        bucket_id text references storage.buckets(id), name text, metadata jsonb);
    `);
  } finally {
    await client.end();
  }
};

const main = async () => {
  await prepareCiHostPostgres();
  console.log('Prepared the pinned CI PostgreSQL storage schema.');
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
