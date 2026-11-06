import { DEFAULT_FIRM_ID, assertSeedTargetAllowed, refreshTransactionIntelInDb, withFirmDbClient } from '../server/donna/firmDb.js';
import { getFirmSeedSnapshot } from '../server/donna/firmSeeds.js';

const isoFromMillis = (value) => {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) && numeric > 0 ? new Date(numeric).toISOString() : null;
};

const main = async () => {
  // Refuse to seed demo data into a non-local database unless explicitly forced
  // (--force / DONNA_ALLOW_SEED=true). Guards against clobbering production.
  const { host, forced } = assertSeedTargetAllowed();
  console.log(`[seed] target database host: ${host}${forced ? ' (forced)' : ''}`);
  const snapshot = await getFirmSeedSnapshot();
  const firm = snapshot.firm || {};

  await withFirmDbClient(async (client) => {
  const queryFirmDb = (text, params = []) => client.query(text, params);
  await queryFirmDb('begin');
  try {
    await queryFirmDb(
      `insert into firms (id, name, slug, jurisdiction, default_currency, metadata)
       values ($1, $2, $3, $4, $5, $6::jsonb)
       on conflict (id) do update set
         name = excluded.name,
         slug = excluded.slug,
         jurisdiction = excluded.jurisdiction,
         default_currency = excluded.default_currency,
         metadata = excluded.metadata,
         updated_at = now()`,
      [
        firm.id || DEFAULT_FIRM_ID,
        firm.name || 'Donna Firms Demo',
        firm.slug || 'donna-demo',
        firm.jurisdiction || 'SG',
        firm.defaultCurrency || 'SGD',
        JSON.stringify(firm.metadata || { seed: true })
      ]
    );

    for (const member of snapshot.members || []) {
      await queryFirmDb(
        `insert into firm_members (id, firm_id, user_id, email, name, role, status, access_level, metadata)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         on conflict (id) do update set
           email = excluded.email,
           name = excluded.name,
           role = excluded.role,
           status = excluded.status,
           access_level = excluded.access_level,
           metadata = excluded.metadata,
           updated_at = now()`,
        [
          member.id,
          member.firm_id || DEFAULT_FIRM_ID,
          member.user_id || null,
          member.email,
          member.name,
          member.role || 'member',
          member.status || 'active',
          member.access_level || 'staff',
          JSON.stringify(member.metadata || {})
        ]
      );
    }

    for (const collaborator of snapshot.collaborators || []) {
      await queryFirmDb(
        `insert into firm_collaborators (
          id, firm_id, user_id, email, name, vendor_company, country, role, status, access_level,
          starts_at, ends_at, nda_signed_at, data_processing_agreement_id, metadata
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
        on conflict (id) do update set
          email = excluded.email,
          name = excluded.name,
          vendor_company = excluded.vendor_company,
          country = excluded.country,
          role = excluded.role,
          status = excluded.status,
          access_level = excluded.access_level,
          starts_at = excluded.starts_at,
          ends_at = excluded.ends_at,
          nda_signed_at = excluded.nda_signed_at,
          data_processing_agreement_id = excluded.data_processing_agreement_id,
          metadata = excluded.metadata,
          updated_at = now()`,
        [
          collaborator.id,
          collaborator.firm_id || DEFAULT_FIRM_ID,
          collaborator.user_id || null,
          collaborator.email,
          collaborator.name,
          collaborator.vendor_company || null,
          collaborator.country || null,
          collaborator.role || 'bookkeeper',
          collaborator.status || 'active',
          collaborator.access_level || 'client_scoped',
          collaborator.starts_at || null,
          collaborator.ends_at || null,
          collaborator.nda_signed_at || null,
          collaborator.data_processing_agreement_id || null,
          JSON.stringify(collaborator.metadata || {})
        ]
      );
    }

    for (const client of snapshot.clients || []) {
      await queryFirmDb(
        `insert into clients (
          id, firm_id, company_name, uen, entity_type, incorporation_date, stage, next_deadline, status, profile
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
        on conflict (id) do update set
          company_name = excluded.company_name,
          uen = excluded.uen,
          entity_type = excluded.entity_type,
          incorporation_date = excluded.incorporation_date,
          stage = excluded.stage,
          next_deadline = excluded.next_deadline,
          status = excluded.status,
          profile = excluded.profile,
          updated_at = now()`,
        [
          client.id,
          DEFAULT_FIRM_ID,
          client.companyName || client.name || client.id,
          client.uen || null,
          client.entityType || null,
          client.incorporationDate || null,
          client.stage || null,
          client.nextDeadline || null,
          client.status || 'active',
          JSON.stringify(client)
        ]
      );
    }

    for (const document of snapshot.documents || []) {
      await queryFirmDb(
        `insert into documents (id, firm_id, client_id, filename, document_type, status, uploaded_at, payload, parse_status, parse_completed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'completed', now())
         on conflict (id) do update set
           filename = excluded.filename,
           document_type = excluded.document_type,
           status = excluded.status,
           uploaded_at = excluded.uploaded_at,
           payload = excluded.payload,
           parse_status = excluded.parse_status,
           parse_completed_at = excluded.parse_completed_at,
           updated_at = now()`,
        [
          document.id,
          DEFAULT_FIRM_ID,
          document.client_id,
          document.filename || document.document_label || document.id,
          document.document_type || 'unknown',
          document.status || 'received',
          isoFromMillis(document.uploaded_at),
          JSON.stringify(document)
        ]
      );
    }

    for (const transaction of snapshot.transactions || []) {
      await queryFirmDb(
        `insert into transactions (
          id, firm_id, client_id, document_id, transaction_date, description, money_in, money_out, currency, status, payload
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
        on conflict (id) do update set
          document_id = excluded.document_id,
          transaction_date = excluded.transaction_date,
          description = excluded.description,
          money_in = excluded.money_in,
          money_out = excluded.money_out,
          currency = excluded.currency,
          status = excluded.status,
          payload = excluded.payload,
          updated_at = now()`,
        [
          transaction.id,
          DEFAULT_FIRM_ID,
          transaction.client_id,
          transaction.document_id || null,
          transaction.date || null,
          transaction.description || null,
          Number(transaction.money_in || 0),
          Number(transaction.money_out || 0),
          transaction.account_currency || transaction.currency || null,
          transaction.status || 'needs_review',
          JSON.stringify(transaction)
        ]
      );
    }

    for (const rule of snapshot.accountingRules || []) {
      await queryFirmDb(
        `insert into accounting_rules (id, firm_id, client_id, status, trigger_hash, payload)
         values ($1, $2, $3, $4, $5, $6::jsonb)
         on conflict (id) do update set
           client_id = excluded.client_id,
           status = excluded.status,
           trigger_hash = excluded.trigger_hash,
           payload = excluded.payload,
           updated_at = now()`,
        [
          rule.id,
          DEFAULT_FIRM_ID,
          rule.client_id || null,
          rule.status || 'suggested',
          rule.trigger_hash || null,
          JSON.stringify(rule)
        ]
      );
    }

    for (const item of snapshot.queue || []) {
      await queryFirmDb(
        `insert into queue_items (id, firm_id, client_id, queue_label, status, payload, created_at)
         values ($1, $2, $3, $4, $5, $6::jsonb, coalesce($7::timestamptz, now()))
         on conflict (id) do update set
           client_id = excluded.client_id,
           queue_label = excluded.queue_label,
           status = excluded.status,
           payload = excluded.payload,
           updated_at = now()`,
        [
          item.id,
          DEFAULT_FIRM_ID,
          item.client_id || null,
          item.queue_label || null,
          item.status || 'open',
          JSON.stringify(item),
          isoFromMillis(item.created_at)
        ]
      );
    }

    for (const item of snapshot.history || []) {
      await queryFirmDb(
        `insert into history_items (id, firm_id, client_id, payload, happened_at)
         values ($1, $2, $3, $4::jsonb, $5)
         on conflict (id) do update set
           client_id = excluded.client_id,
           payload = excluded.payload,
           happened_at = excluded.happened_at`,
        [
          item.id,
          DEFAULT_FIRM_ID,
          item.client_id || null,
          JSON.stringify(item),
          isoFromMillis(item.time)
        ]
      );
    }

    await queryFirmDb('commit');
    console.log(`Seeded ${snapshot.clients.length} clients and ${snapshot.queue.length} queue items.`);
  } catch (error) {
    await queryFirmDb('rollback');
    throw error;
  }
  });

  const clientIds = (snapshot.clients || []).map((client) => client.id).filter(Boolean);
  if (clientIds.length) {
    await refreshTransactionIntelInDb({ firmId: firm.id || DEFAULT_FIRM_ID, clientIds });
  }
};

main().catch((error) => {
  console.error(error.message || error);
  if (error.code === 'ERR_MODULE_NOT_FOUND') {
    console.error('Install the Postgres driver with `npm install pg` before seeding.');
  }
  process.exit(1);
});
