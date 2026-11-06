// Test-only composition overlay: edit only named registrations, never runtime
// algorithms. No dependency injection is added to a production writer for this proof.
const fixtureUrl = new URL('./implementations.mjs', import.meta.url).href;
const registrations = {
  'closePolicyRegistry.js': ['CLOSE_POLICY_REGISTRY', 'fixtureClose', '{ ...BASE_REGISTRATION, nz: fixtureClose }'],
  'clientLifecycleRegistry.js': ['CLIENT_LIFECYCLE_REGISTRY', 'fixtureLifecycle', '{ ...BASE_REGISTRATION, nz: fixtureLifecycle }'],
  'provisioningPolicyRegistry.js': ['PROVISIONING_POLICY_REGISTRY', 'fixtureProvisioning', '{ ...BASE_REGISTRATION, nz: fixtureProvisioning }'],
  'codingPolicyRegistry.js': ['CODING_POLICY_REGISTRY', 'fixtureCoding', '{ ...BASE_REGISTRATION, nz: fixtureCoding }'],
  'postingPolicyRegistry.js': ['POSTING_POLICY_REGISTRY', 'fixturePosting', '{ ...BASE_REGISTRATION, nz: fixturePosting }'],
  'profileValidationRegistry.js': ['PROFILE_VALIDATION_REGISTRY', 'fixtureProfile', 'createProfileValidationRegistry({ ...BASE_REGISTRATION.countries, nz: fixtureProfile })'],
  'sellerRegistrationRegistry.js': ['SELLER_REGISTRATION_REGISTRY', 'fixtureSeller', 'createSellerRegistrationRegistry({ ...BASE_REGISTRATION, nz: fixtureSeller })']
};
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const name = url.slice(url.lastIndexOf('/') + 1);
  const registration = registrations[name];
  if (!registration || !url.endsWith(`/server/donna/${name}`)) return result;
  const [binding, fixture, expression] = registration;
  const source = result.source.toString();
  const anchor = `export const ${binding} =`;
  if (source.split(anchor).length !== 2) throw new Error(`Composition fixture lost its exact registration anchor: ${name}`);
  return { ...result, source: `import { ${fixture} } from ${JSON.stringify(fixtureUrl)};\n`
    + source.replace(anchor, 'const BASE_REGISTRATION =')
    + `\nexport const ${binding} = Object.freeze(${expression});\n` };
}
