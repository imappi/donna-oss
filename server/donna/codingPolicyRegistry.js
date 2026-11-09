// Named composition root. Adding a jurisdiction registers its owned coding
// definition here; it does not change the shared resolution/coding algorithms.
import { SG_CODING_POLICY, resolveSgCodingPolicy } from './singapore/codingPolicy.js';
import { FI_CODING_POLICY } from './finland/codingPolicy.js';
import { GB_CODING_POLICY } from './gb/codingPolicy.js';
import { AE_CODING_POLICY } from './ae/codingPolicy.js';
import { US_CODING_POLICY } from './us/codingPolicy.js';
import { AU_CODING_POLICY } from './au/codingPolicy.js';

// Entries are enumerable getters, not values captured at evaluation time:
// several policy modules reach this registry back through outbound/packs.js ->
// countryCapabilities.js, so when one of them is the first module a process
// imports, its own binding is still uninitialised while this module evaluates.
// Reading the binding on lookup keeps every module on that cycle importable
// first while readers (index, Object.keys/entries, spread) see the same keys
// and values as before.
export const CODING_POLICY_REGISTRY = Object.freeze({
  get sg() { return resolveSgCodingPolicy; }, get fi() { return FI_CODING_POLICY; },
  get gb() { return GB_CODING_POLICY; }, get ae() { return AE_CODING_POLICY; },
  get us() { return US_CODING_POLICY; }, get au() { return AU_CODING_POLICY; }
});
// Legacy display constants remain explicit SG exports, never routing defaults.
export { SG_CODING_POLICY };
