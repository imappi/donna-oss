// Named composition root. Registration never derives posting capabilities from coding support.
import { FI_POSTING_POLICY } from './finland/postingPolicy.js';
import { GB_POSTING_POLICY } from './gb/postingPolicy.js';
import { SG_POSTING_POLICY } from './singapore/postingPolicy.js';
import { AE_POSTING_POLICY } from './ae/postingPolicy.js';
import { US_POSTING_POLICY } from './us/postingPolicy.js';
import { AU_POSTING_POLICY } from './au/postingPolicy.js';

export const POSTING_POLICY_REGISTRY = Object.freeze({
  fi: FI_POSTING_POLICY, gb: GB_POSTING_POLICY, sg: SG_POSTING_POLICY,
  ae: AE_POSTING_POLICY, us: US_POSTING_POLICY, au: AU_POSTING_POLICY
});
