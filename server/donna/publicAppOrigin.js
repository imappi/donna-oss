const clean = (value) => String(value ?? '').trim();

// PUBLIC_APP_URL is canonical. The other names are ordered legacy aliases;
// both outbound mail and owner-portal links consume this one resolver.
export const publicAppOrigin = (env = process.env) =>
  clean(env.PUBLIC_APP_URL) ||
  clean(env.OUTBOUND_PUBLIC_BASE_URL) ||
  clean(env.APP_BASE_URL) ||
  clean(env.MARKETING_PUBLIC_BASE_URL) ||
  '';
