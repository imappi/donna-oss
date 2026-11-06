// Serialize a client's close/check lifecycle with opening replacement, including
// when no close-period row exists yet. The caller owns the transaction.
export const lockClientCloseBoundaryWithClient = ({client,firmId,clientId}) =>
  client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`client-close:${firmId}:${clientId}`]);
