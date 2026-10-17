// Usage billing against a real Postgres and a fake Shopify. Skipped unless
// TEST_DATABASE_URL is set (see resolutions.db.test.ts).
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { cycleCost, decideCharge, PLAN } from "../app/lib/plan";

describe("plan maths", () => {
  test("free allowance, per-order price, cap", () => {
    expect(decideCharge(0)).toBe("FREE");
    expect(decideCharge(PLAN.freeOrders - 1)).toBe("FREE");
    expect(decideCharge(PLAN.freeOrders)).toBe("CHARGE");
    expect(cycleCost(25)).toBe(0);
    expect(cycleCost(100)).toBeCloseTo(2.5);
    expect(cycleCost(1_000_000)).toBe(PLAN.cap);
  });
});

const url = process.env.TEST_DATABASE_URL;
const SHOP = "billing-test.myshopify.com";
const END = "2026-11-10T00:00:00Z";

describe.skipIf(!url)("usage billing (database)", () => {
  let prisma: typeof import("../app/db.server").default;
  let billing: typeof import("../app/lib/billing.server");

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DATABASE_URL_UNPOOLED = url;
    prisma = (await import("../app/db.server")).default;
    billing = await import("../app/lib/billing.server");
  });

  beforeEach(async () => {
    await prisma.shop.deleteMany({ where: { shop: SHOP } });
    await prisma.shop.create({ data: { shop: SHOP } });
  });

  /** A fake Admin API: one active usage subscription; records usage mutations. */
  function fakeAdmin(
    opts: { plan?: boolean; used?: number; cap?: number; refuse?: string } = {},
  ) {
    const records: { key: string; amount: string }[] = [];
    const admin = {
      graphql: async (
        query: string,
        o?: { variables?: Record<string, unknown> },
      ) => {
        if (query.includes("SpActivePlan")) {
          const subs =
            opts.plan === false
              ? []
              : [
                  {
                    id: "gid://shopify/AppSubscription/1",
                    name: PLAN.name,
                    status: "ACTIVE",
                    test: true,
                    currentPeriodEnd: END,
                    lineItems: [
                      {
                        id: "gid://shopify/AppSubscriptionLineItem/9",
                        plan: {
                          pricingDetails: {
                            cappedAmount: {
                              amount: String(opts.cap ?? PLAN.cap),
                            },
                            balanceUsed: { amount: String(opts.used ?? 0) },
                          },
                        },
                      },
                    ],
                  },
                ];
          return Response.json({
            data: { currentAppInstallation: { activeSubscriptions: subs } },
          });
        }
        if (query.includes("SpUsage")) {
          const v = o!.variables as { key: string; price: { amount: string } };
          if (opts.refuse)
            return Response.json({
              data: {
                appUsageRecordCreate: {
                  appUsageRecord: null,
                  userErrors: [{ message: opts.refuse }],
                },
              },
            });
          records.push({ key: v.key, amount: v.price.amount });
          return Response.json({
            data: {
              appUsageRecordCreate: {
                appUsageRecord: { id: `rec-${v.key}` },
                userErrors: [],
              },
            },
          });
        }
        throw new Error(`unexpected query ${query.slice(0, 40)}`);
      },
    };
    return { admin, records };
  }

  test("the first orders of a cycle are free, then each is charged once", async () => {
    const { admin, records } = fakeAdmin();
    await prisma.usageCharge.createMany({
      data: Array.from({ length: PLAN.freeOrders - 1 }, (_, i) => ({
        shop: SHOP,
        orderId: `old-${i}`,
        orderName: `#${i}`,
        status: "FREE",
        amount: 0,
        periodEnd: new Date(END),
      })),
    });
    const last = await billing.billProtectedOrder(admin, SHOP, {
      id: "100",
      name: "#100",
    });
    expect(last?.status).toBe("FREE");
    const paid = await billing.billProtectedOrder(admin, SHOP, {
      id: "101",
      name: "#101",
    });
    expect(paid?.status).toBe("CHARGED");
    expect(records).toEqual([
      { key: "sp-order-101", amount: PLAN.pricePerOrder.toFixed(2) },
    ]);
    // A webhook retry for the same order charges nothing more.
    await billing.billProtectedOrder(admin, SHOP, { id: "101", name: "#101" });
    expect(records).toHaveLength(1);
  });

  test("orders arriving together can't share the last free slot", async () => {
    const { admin } = fakeAdmin();
    await prisma.usageCharge.createMany({
      data: Array.from({ length: PLAN.freeOrders - 1 }, (_, i) => ({
        shop: SHOP,
        orderId: `old-${i}`,
        orderName: `#${i}`,
        status: "FREE",
        amount: 0,
        periodEnd: new Date(END),
      })),
    });
    const rows = await Promise.all(
      ["a", "b", "c"].map((id) =>
        billing.billProtectedOrder(admin, SHOP, { id, name: id }),
      ),
    );
    expect(rows.map((r) => r?.status).sort()).toEqual([
      "CHARGED",
      "CHARGED",
      "FREE",
    ]);
  });

  test("no plan, the cap, and Shopify refusing", async () => {
    expect(
      (
        await billing.billProtectedOrder(
          fakeAdmin({ plan: false }).admin,
          SHOP,
          { id: "1", name: "#1" },
        )
      )?.status,
    ).toBe("NO_PLAN");
    await prisma.usageCharge.createMany({
      data: Array.from({ length: PLAN.freeOrders }, (_, i) => ({
        shop: SHOP,
        orderId: `old-${i}`,
        orderName: `#${i}`,
        status: "FREE",
        amount: 0,
        periodEnd: new Date(END),
      })),
    });
    const capped = fakeAdmin({ used: PLAN.cap });
    expect(
      (
        await billing.billProtectedOrder(capped.admin, SHOP, {
          id: "2",
          name: "#2",
        })
      )?.status,
    ).toBe("CAPPED");
    expect(capped.records).toEqual([]);
    const refused = fakeAdmin({ refuse: "Something went wrong" });
    const row = await billing.billProtectedOrder(refused.admin, SHOP, {
      id: "3",
      name: "#3",
    });
    expect(row).toMatchObject({
      status: "FAILED",
      error: "Something went wrong",
    });
    // A failed row is retried on the next delivery of the webhook.
    const ok = fakeAdmin();
    expect(
      (
        await billing.billProtectedOrder(ok.admin, SHOP, {
          id: "3",
          name: "#3",
        })
      )?.status,
    ).toBe("CHARGED");
  });
});
