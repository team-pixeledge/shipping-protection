// What each plan switches on, applied in one place per feature. Settings are
// stored as the merchant chose them (a downgrade loses nothing; upgrading
// again brings them back) and clamped here when used. Pure: no I/O.
import { DEFAULT_CLAIM_SETTINGS, type ClaimSettings } from "./claims";
import { hasFeature, type PlanId } from "./plan";

/** Flags every plan gets (the claims page's own checks). The rest are "risk"/"tracking". */
export const BASIC_FLAGS = ["NO_PROTECTION", "MARKED_DELIVERED", "NOT_MARKED_DELIVERED", "NO_TRACKING", "OUTSIDE_POLICY"];

/** Claim settings as the plan may use them: limits, evidence rules and the delivery window need "claimRules". */
export function effectiveClaimSettings(s: ClaimSettings, plan: PlanId | null): ClaimSettings {
  if (hasFeature(plan, "claimRules")) return s;
  const d = DEFAULT_CLAIM_SETTINGS;
  return {
    ...s,
    windowFrom: d.windowFrom,
    evidenceForLostStolen: d.evidenceForLostStolen,
    maxValuePerOrder: d.maxValuePerOrder,
    maxValuePerCustomer: d.maxValuePerCustomer,
  };
}

/** Review flags the plan shows: all with "risk", the basic ones otherwise. */
export const gateFlags = (flags: string[], plan: PlanId | null) =>
  hasFeature(plan, "risk") ? flags : flags.filter((f) => BASIC_FLAGS.includes(f));
