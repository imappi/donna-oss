const refuse = (code, message) => { throw Object.assign(new Error(message), { code, statusCode: 403 }); };

// Factual answers need a current scoped human identity, never posting authority.
// Lock identity/assignment rows so a revocation cannot pass between check/write.
export const assertAeFactualReplyActor = async ({ client, firmId, clientId, actorId }) => {
  const deny = () => refuse('AE_FACTUAL_REPLY_ACTOR_REQUIRED', 'A current authorized human for this client must supply the factual answer.');
  if (!actorId || ['system', 'unknown', 'workspace', 'access-token'].includes(actorId)) deny();
  const members = (await client.query(`select * from firm_members where firm_id=$1
    and (id=$2 or user_id=$2 or lower(email)=lower($2)) for share`, [firmId, actorId])).rows;
  const writable = row => row.status === 'active' && !['viewer', 'read_only'].includes(row.access_level) && !['viewer', 'read_only'].includes(row.role);
  if (members.length) {
    if (members.length !== 1 || !writable(members[0])) deny();
    return { actorId: members[0].id, actorType: 'member' };
  }
  const collaborators = (await client.query(`select *, (starts_at is null or starts_at <= now())
    and (ends_at is null or ends_at > now()) as within_engagement from firm_collaborators
    where firm_id=$1 and (id=$2 or user_id=$2 or lower(email)=lower($2)) for share`, [firmId, actorId])).rows;
  if (collaborators.length !== 1 || !writable(collaborators[0]) || !collaborators[0].within_engagement) deny();
  const row = collaborators[0];
  const assignments = (await client.query(`select * from client_assignments where firm_id=$1 and client_id=$2
    and principal_type='firm_collaborator' and principal_id=$3 and assignment_kind='capability'
    and status='active' and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now()) for share`,
  [firmId, clientId, row.id])).rows;
  if (!assignments.some(assignment => !['viewer', 'read_only'].includes(assignment.role)
    && !['viewer', 'read_only'].includes(assignment.access_level))) deny();
  return { actorId: row.id, actorType: 'client' };
};
