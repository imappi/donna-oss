// Country-owned client identification effects. Called inside the named client
// writer's existing transaction; its locks, savepoint and audit contract remain intact.
import { assertFinlandLegalFormNotMutatedAfterPosting, finlandEntityType, isFinlandLegalFormConversion, isFinlandOsakeyhtio } from './entity.js';
import { readFinnishProfileIntakeWithClient, assertFinnishProfileIntakeMutableWithClient } from './profileIntake.js';
import { mintForm5OyQuarantineBlocker } from './statutoryBlocker.js';

export const FI_CLIENT_LIFECYCLE = Object.freeze({
  entityAxis: finlandEntityType,
  profileIntake: Object.freeze({ read: readFinnishProfileIntakeWithClient, assertMutable: assertFinnishProfileIntakeMutableWithClient }),
  async beforeIdentityWrite({ client, firmId, clientId, storedEntityType, incomingEntityType }) {
    if (isFinlandLegalFormConversion(storedEntityType, incomingEntityType)) {
      const posted = await client.query(
        `select 1 from ledger_journals
          where firm_id = $1 and client_id = $2 and status in ('posted', 'closed')
          limit 1`,
        [firmId, clientId]
      );
      assertFinlandLegalFormNotMutatedAfterPosting({
        storedEntityType,
        incomingEntityType,
        hasPostedEntries: posted.rows.length > 0
      });
    }
  },
  async afterIdentityWrite({ client, firmId, clientId, storedEntityType, incomingEntityType }) {
    const becameOsakeyhtio =
      isFinlandOsakeyhtio({ entity_type: incomingEntityType }) &&
      !isFinlandOsakeyhtio({ entity_type: storedEntityType });
    if (becameOsakeyhtio) {
      await client.query('savepoint fi13_form5_quarantine');
      try {
        await mintForm5OyQuarantineBlocker({
          client,
          firmId,
          clientId,
          reason: 'oy_identified_form5_quarantine',
          detail: {
            origin: 'entity_identification',
            quarantine: 'form5_superseded',
            identified_entity_type: 'fi-oy',
            prior_entity_type: storedEntityType || null
          }
        });
        await client.query('release savepoint fi13_form5_quarantine');
      } catch (mintError) {
        try {
          await client.query('rollback to savepoint fi13_form5_quarantine');
        } catch {
          /* savepoint already gone — nothing to unwind */
        }
        console.warn(
          '[finland] form-5 quarantine blocker mint skipped on Oy identification',
          mintError?.message || mintError
        );
      }
    }
  }
});
