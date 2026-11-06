// Named composition root. Adding a jurisdiction registers its owned coding
// definition here; it does not change the shared resolution/coding algorithms.
import { SG_CODING_POLICY, resolveSgCodingPolicy } from './singapore/codingPolicy.js';
import { FI_CODING_POLICY } from './finland/codingPolicy.js';
import { GB_CODING_POLICY } from './gb/codingPolicy.js';
import { AE_CODING_POLICY } from './ae/codingPolicy.js';
import { US_CODING_POLICY } from './us/codingPolicy.js';
import { AU_CODING_POLICY } from './au/codingPolicy.js';

export const CODING_POLICY_REGISTRY = Object.freeze({
  sg: resolveSgCodingPolicy, fi: FI_CODING_POLICY, gb: GB_CODING_POLICY,
  ae: AE_CODING_POLICY, us: US_CODING_POLICY, au: AU_CODING_POLICY
});
// Legacy display constants remain explicit SG exports, never routing defaults.
export { SG_CODING_POLICY };
