import { physicalQualificationFixture } from './physicalQualificationFixture.js';
import { setClientFlagStage } from '../clientConfig.js';

// Reuse the fully migrated, local-only physical fixture. Identity tokens and
// object storage are synthetic; no customer activation or stock writer is added.
export async function captureQualificationFixture() {
  const fixture = await physicalQualificationFixture();
  try {
    await fixture.pool.query(`insert into firm_collaborators(id,firm_id,user_id,email,name,status) values
      ('capture-worker','qualification-firm','worker-user','worker@qualification.invalid','Synthetic worker','active'),
      ('capture-other','qualification-firm','other-user','other@qualification.invalid','Other worker','active');
      insert into client_assignments(id,firm_id,client_id,principal_type,principal_id,role) values
      ('capture-assignment','qualification-firm','qualification-client','firm_collaborator','capture-worker','junior'),
      ('other-assignment','qualification-firm','qualification-client','firm_collaborator','capture-other','junior');`);
    const client = await fixture.pool.connect();
    try { await setClientFlagStage(client, { ...fixture.a, flagKey: 'PHYSICAL_CAPTURE_ACCESS', stage: 'canary', reason: 'Disposable delegated browser qualification' }); }
    finally { client.release(); }
    return fixture;
  } catch (error) { await fixture.dispose(); throw error; }
}
