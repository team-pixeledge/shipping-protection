// Billing: usage-based plans through Shopify's Billing API (./plan.ts).
//   - The merchant approves a plan (a capped usage subscription) before
//     using the admin (app/routes/app.tsx sends them to /app/plan).
//   - Each protected order is recorded by orders/create; the plan's free
//     orders each billing cycle cost nothing, then its price per order, as
//     a usage record, up to its cap.
//   - Development stores get test charges (no money moves).
//   - Shop.plan mirrors the active plan (syncPlan) for feature gates.
// Managed Pricing must be OFF in the Partner Dashboard for this to work.
import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { decideCharge, isPlanId, PLANS, planFromBillingName, type PlanId } from "./plan";
import { syncProtection, type AdminGraphql } from "./setup.server";

async function gql<T>(admin: AdminGraphql, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await admin.graphql(query, variables ? { variables } : undefined);
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data as T;
}

export interface ActivePlan {
  subscriptionId: string;
  name: string;
  plan: PlanId;
  test: boolean;
  currentPeriodEnd: string | null;
  usageLineItemId: string;
  cappedAmount: number;
  balanceUsed: number;
}

/** The app's active usage subscription, or null. */
export async function activePlan(admin: AdminGraphql): Promise<ActivePlan | null> {
  const data = await gql<{
    currentAppInstallation: {
      activeSubscriptions: {
        id: string;
        name: string;
        status: string;
        test: boolean;
        currentPeriodEnd: string | null;
        lineItems: {
          id: string;
          plan: { pricingDetails: { cappedAmount?: { amount: string }; balanceUsed?: { amount: string } } };
        }[];
      }[];
    };
  }>(
    admin,
    `#graphql
    query SpActivePlan {
      currentAppInstallation {
        activeSubscriptions {
          id name status test currentPeriodEnd
          lineItems {
            id
            plan { pricingDetails { ... on AppUsagePricing { cappedAmount { amount } balanceUsed { amount } } } }
          }
        }
      }
    }`,
  );
  for (const sub of data.currentAppInstallation.activeSubscriptions) {
    if (sub.status !== "ACTIVE") continue;
    const usage = sub.lineItems.find((l) => l.plan.pricingDetails.cappedAmount);
    const plan = planFromBillingName(sub.name);
    if (!usage || !plan) continue;
    return {
      subscriptionId: sub.id,
      name: sub.name,
      plan,
      test: sub.test,
      currentPeriodEnd: sub.currentPeriodEnd,
      usageLineItemId: usage.id,
      cappedAmount: Number(usage.plan.pricingDetails.cappedAmount!.amount),
      balanceUsed: Number(usage.plan.pricingDetails.balanceUsed?.amount ?? 0),
    };
  }
  return null;
}

/**
 * Reads the active plan from Shopify and mirrors it on the shop row
 * (Shop.plan), which feature gates read. Returns the plan (null = none).
 */
export async function syncPlan(admin: AdminGraphql, shop: string): Promise<ActivePlan | null> {
  const plan = await activePlan(admin);
  const row = await prisma.shop.findUnique({ where: { shop }, select: { plan: true, settings: true, syncedVersion: true } });
  const next = plan?.plan ?? null;
  if (row && row.plan !== next) {
    await prisma.shop.update({ where: { shop }, data: { plan: next } });
    // Plan features live in the store's config (market prices, exact
    // pricing, the checkout toggle): push it again so the storefront and
    // checkout follow the new plan. A failure shows on Home as usual.
    if (row.settings !== null && row.syncedVersion > 0) {
      await syncProtection(admin, shop).catch((err) =>
        console.error(`[billing] resync after plan change on ${shop}:`, err instanceof Error ? err.message : err),
      );
    }
  }
  return plan;
}

/** The shop's plan as last synced (no API call) — for webhooks and the daily job. */
export async function shopPlan(shop: string): Promise<PlanId | null> {
  const row = await prisma.shop.findUnique({ where: { shop }, select: { plan: true } });
  return isPlanId(row?.plan) ? row.plan : null;
}

/** Is this a development store (test charges)? */
export async function isDevStore(admin: AdminGraphql): Promise<boolean> {
  if (process.env.BILLING_TEST === "true") return true;
  try {
    const data = await gql<{ shop: { plan: { partnerDevelopment: boolean } } }>(
      admin,
      `#graphql
      query SpShopPlan { shop { plan { partnerDevelopment } } }`,
    );
    return data.shop.plan.partnerDevelopment;
  } catch {
    return false;
  }
}

/** The billing cycle a subscription is in, as [start, end). Cycles are 30 days. */
export function cycleOf(periodEnd: string | null, now = new Date()) {
  const end = periodEnd ? new Date(periodEnd) : new Date(now.getTime() + 30 * 86_400_000);
  return { start: new Date(end.getTime() - 30 * 86_400_000), end };
}

/**
 * Bills one protected order (orders/create). Safe to call twice for the same
 * order: the row is the record, and Shopify gets the same idempotency key.
 * Never throws for billing problems — an order is never lost because a
 * charge failed; the row says FAILED and the error.
 */
export async function billProtectedOrder(admin: AdminGraphql, shop: string, order: { id: string; name: string }) {
  const existing = await prisma.usageCharge.findUnique({ where: { shop_orderId: { shop, orderId: order.id } } });
  if (existing && existing.status !== "FAILED") return existing;

  let plan: ActivePlan | null;
  try {
    plan = await activePlan(admin);
  } catch (err) {
    return save(shop, order, { status: "FAILED", error: errorText(err) });
  }
  if (!plan) return save(shop, order, { status: "NO_PLAN" });

  const cycle = cycleOf(plan.currentPeriodEnd);
  // One shop at a time, so two orders arriving together can't both take the
  // last free slot.
  const decision = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing:${shop}`}))`;
    const used = await tx.usageCharge.count({
      where: { shop, periodEnd: cycle.end, status: { in: ["FREE", "CHARGED", "CAPPED"] }, NOT: { orderId: order.id } },
    });
    const d = decideCharge(PLANS[plan.plan], used);
    if (d === "FREE") {
      await upsert(tx, shop, order, { status: "FREE", periodEnd: cycle.end, test: plan.test });
    }
    return d;
  });
  if (decision === "FREE") return prisma.usageCharge.findUnique({ where: { shop_orderId: { shop, orderId: order.id } } });

  const price = PLANS[plan.plan].pricePerOrder;
  if (plan.balanceUsed + price > plan.cappedAmount + 1e-9) {
    return save(shop, order, { status: "CAPPED", periodEnd: cycle.end, test: plan.test });
  }
  try {
    const data = await gql<{
      appUsageRecordCreate: { appUsageRecord: { id: string } | null; userErrors: { message: string }[] };
    }>(
      admin,
      `#graphql
      mutation SpUsage($id: ID!, $price: MoneyInput!, $description: String!, $key: String) {
        appUsageRecordCreate(subscriptionLineItemId: $id, price: $price, description: $description, idempotencyKey: $key) {
          appUsageRecord { id }
          userErrors { field message }
        }
      }`,
      {
        id: plan.usageLineItemId,
        price: { amount: price.toFixed(2), currencyCode: PLANS[plan.plan].currency },
        description: `Protected order ${order.name}`,
        key: `sp-order-${order.id}`,
      },
    );
    const errs = data.appUsageRecordCreate.userErrors;
    if (errs.length) {
      const msg = errs.map((e) => e.message).join("; ");
      // Shopify refuses usage over the cap; that's the cap doing its job.
      const capped = /cap|exceed/i.test(msg);
      return save(shop, order, { status: capped ? "CAPPED" : "FAILED", periodEnd: cycle.end, test: plan.test, error: msg });
    }
    return save(shop, order, {
      status: "CHARGED",
      amount: price,
      periodEnd: cycle.end,
      test: plan.test,
      usageRecordId: data.appUsageRecordCreate.appUsageRecord?.id ?? null,
    });
  } catch (err) {
    return save(shop, order, { status: "FAILED", periodEnd: cycle.end, test: plan.test, error: errorText(err) });
  }
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

type Row = {
  status: string;
  amount?: number;
  periodEnd?: Date | null;
  test?: boolean;
  usageRecordId?: string | null;
  error?: string | null;
};

function upsert(tx: Prisma.TransactionClient | typeof prisma, shop: string, order: { id: string; name: string }, r: Row) {
  const data = {
    orderName: order.name,
    status: r.status,
    amount: r.amount ?? 0,
    periodEnd: r.periodEnd ?? null,
    test: r.test ?? false,
    usageRecordId: r.usageRecordId ?? null,
    error: r.error ?? null,
  };
  return tx.usageCharge.upsert({
    where: { shop_orderId: { shop, orderId: order.id } },
    create: { shop, orderId: order.id, ...data },
    update: data,
  });
}

const save = (shop: string, order: { id: string; name: string }, r: Row) => upsert(prisma, shop, order, r);

/** This cycle's numbers for the plan page. */
export async function usageThisCycle(shop: string, plan: ActivePlan | null) {
  const cycle = cycleOf(plan?.currentPeriodEnd ?? null);
  const rows = await prisma.usageCharge.groupBy({
    by: ["status"],
    where: plan ? { shop, periodEnd: cycle.end } : { shop, createdAt: { gte: cycle.start } },
    _count: true,
    _sum: { amount: true },
  });
  const n = (s: string) => rows.find((r) => r.status === s)?._count ?? 0;
  return {
    cycle,
    free: n("FREE"),
    charged: n("CHARGED"),
    capped: n("CAPPED"),
    failed: n("FAILED"),
    noPlan: n("NO_PLAN"),
    amount: Number(rows.find((r) => r.status === "CHARGED")?._sum.amount ?? 0),
  };
}
