// The SafeShip plan, in one place: the billing config (shopify.server.ts),
// the charge decision (billing.server.ts) and the plan page all read it.
// Change prices here; existing subscribers keep the terms they approved
// until they approve new ones.

export const PLAN = {
  /** The subscription's name in Shopify (and the billing config key). */
  name: "SafeShip Usage",
  currency: "USD",
  /** Charged per protected order after the free ones. */
  pricePerOrder: 0.05,
  /** Protected orders per billing cycle that cost nothing. */
  freeOrders: 50,
  /** The most a merchant can be charged in one 30-day cycle. */
  cap: 299,
} as const;

export const PLAN_TERMS = `First ${PLAN.freeOrders} protected orders each 30-day cycle free, then $${PLAN.pricePerOrder.toFixed(
  2,
)} per protected order. Never more than $${PLAN.cap} per cycle.`;

/** Free or charged, given how many protected orders the cycle already counted. */
export const decideCharge = (usedThisCycle: number): "FREE" | "CHARGE" =>
  usedThisCycle < PLAN.freeOrders ? "FREE" : "CHARGE";

/** What a cycle with this many protected orders costs. */
export const cycleCost = (protectedOrders: number) =>
  Math.min(PLAN.cap, Math.max(0, protectedOrders - PLAN.freeOrders) * PLAN.pricePerOrder);
