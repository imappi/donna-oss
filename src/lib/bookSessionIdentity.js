import { getAuthSession, getBearerToken } from './accessToken.js';

// A UI identity hint, never an authorization verdict. OAuth hash captures can
// precede the user object; their subject still survives ordinary token rotation.
export const getBookPrincipalId = () => {
  const session = getAuthSession();
  let userId = session?.user?.id;
  if (!userId && session?.access_token) {
    try {
      const payload = session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      userId = JSON.parse(atob(payload)).sub;
    } catch { /* Opaque operator credentials have no persistent user identity. */ }
  }
  return typeof userId === 'string' && userId ? userId : null;
};

export const getBookSessionIdentity = () => {
  const userId = getBookPrincipalId();
  return userId ? `user:${userId}` : `credential:${getBearerToken()}`;
};
