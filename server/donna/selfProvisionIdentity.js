import { createHash } from 'node:crypto';

// Shared by provisioning and recovery: recovery cannot select another book.
export const selfProvisionId = (prefix, firmId, email) =>
  `${prefix}-${createHash('sha256').update(`${firmId}|${email}`).digest('hex').slice(0, 24)}`;
