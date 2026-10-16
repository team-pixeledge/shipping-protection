// Against a real Postgres (the local docker DB): the money-moves-once
// guarantees. Skipped unless TEST_DATABASE_URL is set, e.g.
//   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55451/shipping_protection npx vitest run test/resolutions.db.test.ts
import { beforeAll, beforeEach, describe, expect, test } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const SHOP = "resolve-test.myshopify.com";

describe.skipIf(!url)("resolutions (database)", () => {
  let prisma: typeof import("../app/db.server").default;
  let mod: typeof import("../app/lib/resolutions.server");
  let program: typeof import("../app/lib/program.server");

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DATABASE_URL_UNPOOLED = url;
    process.env.SHOPIFY_API_SECRET = "test";
    prisma = (await import("../app/db.server")).default;
    mod = await import("../app/lib/resolutions.server");
    program = await import("../app/lib/program.server");
  });

  beforeEach(async () => {
    await prisma.shop.deleteMany({ where: { shop: SHOP } });
    await prisma.shop.create({ data: { shop: SHOP, currency: "EUR", settings: {} } });
    await prisma.claim.create({
      data: {
        id: "claim-r1",
        shop: SHOP,
        number: 1001,
        orderId: "5001",
        orderName: "#1001",
        type: "DAMAGED",
        status: "APPROVED",
        resolution: "REFUND",
        email: "jane@example.com",
        description: "Broken",
        items: [{ lineItemId: "gid://shopify/LineItem/1", title: "Vase", quantity: 2, amount: 49 }],
        amount: 49,
        currency: "EUR",
        protected: true,
        flags: [],
        shipments: [],
      },
    });
  });

  /** A fake Admin API: answers by operation name, records every call. */
  function fakeAdmin(handlers: Record<string, (vars: Record<string, unknown>) => unknown>) {
    const calls: { op: string; query: string; vars: Record<string, unknown> }[] = [];
    return {
      calls,
      admin: {
        graphql: async (query: string, opts?: { variables?: Record<string, unknown> }) => {
          const op = query.match(/(?:query|mutation)\s+(\w+)/)?.[1] ?? "?";
          calls.push({ op, query, vars: opts?.variables ?? {} });
          const h = handlers[op];
          if (!h) throw new Error(`unexpected ${op}`);
          return new Response(JSON.stringify({ data: h(opts?.variables ?? {}) }));
        },
      } as never,
    };
  }

  test("two simultaneous resolutions: exactly one goes through", async () => {
    const { admin } = fakeAdmin({});
    const results = await Promise.allSettled([
      mod.resolveClaim(admin, SHOP, "claim-r1", { type: "MANUAL", cost: 10, note: "Sent a voucher" }),
      mod.resolveClaim(admin, SHOP, "claim-r1", { type: "MANUAL", cost: 10, note: "Sent a voucher" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rows = await prisma.claimResolution.findMany({ where: { claimId: "claim-r1" } });
    expect(rows.filter((r) => r.status === "DONE")).toHaveLength(1);
    const claim = await prisma.claim.findUniqueOrThrow({ where: { id: "claim-r1" } });
    expect(claim.resolvedAt).not.toBeNull();
    await expect(
      mod.resolveClaim(admin, SHOP, "claim-r1", { type: "MANUAL", cost: 1, note: "" }),
    ).rejects.toThrow(/already been resolved/);
  });

  const preview = () => ({
    order: {
      suggestedRefund: {
        amountSet: { shopMoney: { amount: "52.00", currencyCode: "EUR" }, presentmentMoney: { amount: "52.00", currencyCode: "EUR" } },
        suggestedTransactions: [
          {
            gateway: "shopify_payments",
            formattedGateway: "Shopify Payments",
            accountNumber: "•••• 4242",
            parentTransaction: { id: "gid://shopify/OrderTransaction/9" },
            maximumRefundableSet: { presentmentMoney: { amount: "60.00" } },
            amountSet: { presentmentMoney: { amount: "52.00" } },
          },
        ],
      },
    },
  });

  test("refund: idempotency key, items not restocked, cost from Shopify's answer", async () => {
    const { admin, calls } = fakeAdmin({
      SpRefundPreview: preview,
      SpRefund: () => ({
        refundCreate: {
          refund: { id: "gid://shopify/Refund/77", totalRefundedSet: { shopMoney: { amount: "52.00", currencyCode: "EUR" } } },
          userErrors: [],
        },
      }),
    });
    await mod.resolveClaim(admin, SHOP, "claim-r1", { type: "REFUND", amount: null, notify: false });
    const call = calls.find((c) => c.op === "SpRefund")!;
    expect(call.query).toContain("@idempotent(key: $key)");
    const row = await prisma.claimResolution.findFirstOrThrow({ where: { claimId: "claim-r1" } });
    expect(call.vars.key).toBe(`claim-refund-${row.id}`);
    const input = call.vars.input as { refundLineItems: { restockType: string }[]; transactions: { amount: string }[] };
    expect(input.refundLineItems[0].restockType).toBe("NO_RESTOCK");
    expect(input.transactions).toEqual([expect.objectContaining({ amount: "52.00", kind: "REFUND" })]);
    expect(row).toMatchObject({ status: "DONE", shopifyId: "gid://shopify/Refund/77" });
    expect(Number(row.amount)).toBe(52);
    // Customer sees what they got; the cost note stays internal.
    const events = await prisma.claimEvent.findMany({ where: { claimId: "claim-r1", kind: "RESOLVED" } });
    expect(events.find((e) => !e.internal)?.message).toMatch(/refunded €52.00/);
  });

  test("a custom amount refunds money only and is capped", async () => {
    const { admin, calls } = fakeAdmin({
      SpRefundPreview: preview,
      SpRefund: () => ({
        refundCreate: {
          refund: { id: "gid://shopify/Refund/78", totalRefundedSet: { shopMoney: { amount: "20.00", currencyCode: "EUR" } } },
          userErrors: [],
        },
      }),
    });
    await expect(mod.resolveClaim(admin, SHOP, "claim-r1", { type: "REFUND", amount: 80, notify: false })).rejects.toThrow(
      /at most/,
    );
    await mod.resolveClaim(admin, SHOP, "claim-r1", { type: "REFUND", amount: 20, notify: false });
    const input = calls.filter((c) => c.op === "SpRefund").at(-1)!.vars.input as Record<string, unknown>;
    expect(input.refundLineItems).toBeUndefined();
  });

  test("Shopify refuses: FAILED, lock released, can try again", async () => {
    let refuse = true;
    const { admin } = fakeAdmin({
      SpRefundPreview: preview,
      SpRefund: () =>
        refuse
          ? { refundCreate: { refund: null, userErrors: [{ field: null, message: "Payment gateway error" }] } }
          : {
              refundCreate: {
                refund: { id: "gid://shopify/Refund/79", totalRefundedSet: { shopMoney: { amount: "52.00", currencyCode: "EUR" } } },
                userErrors: [],
              },
            },
    });
    await expect(mod.resolveClaim(admin, SHOP, "claim-r1", { type: "REFUND", amount: null, notify: false })).rejects.toThrow(
      /Payment gateway error/,
    );
    let claim = await prisma.claim.findUniqueOrThrow({ where: { id: "claim-r1" } });
    expect(claim.resolutionLock).toBeNull();
    expect(claim.resolvedAt).toBeNull();
    refuse = false;
    await mod.resolveClaim(admin, SHOP, "claim-r1", { type: "REFUND", amount: null, notify: false });
    claim = await prisma.claim.findUniqueOrThrow({ where: { id: "claim-r1" } });
    expect(claim.resolvedAt).not.toBeNull();
    const rows = await prisma.claimResolution.findMany({ where: { claimId: "claim-r1" }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.status)).toEqual(["FAILED", "DONE"]);
  });

  test("only approved claims, and program results add up", async () => {
    await prisma.claim.update({ where: { id: "claim-r1" }, data: { status: "OPEN" } });
    const { admin } = fakeAdmin({});
    await expect(mod.resolveClaim(admin, SHOP, "claim-r1", { type: "MANUAL", cost: 5, note: "" })).rejects.toThrow(
      /Only approved/,
    );
    await prisma.claim.update({ where: { id: "claim-r1" }, data: { status: "APPROVED" } });
    await mod.resolveClaim(admin, SHOP, "claim-r1", { type: "MANUAL", cost: 12.5, note: "" });
    await prisma.orderRecord.createMany({
      data: [
        { shop: SHOP, orderId: "1", orderName: "#1", protected: true, fee: 3, currency: "EUR", orderedAt: new Date() },
        { shop: SHOP, orderId: "2", orderName: "#2", protected: true, fee: 2.5, currency: "EUR", orderedAt: new Date() },
        { shop: SHOP, orderId: "3", orderName: "#3", protected: false, fee: 0, currency: "EUR", orderedAt: new Date() },
      ],
    });
    const r = await program.programResults(SHOP, 30);
    expect(r).toMatchObject({ orders: 3, protectedOrders: 2, fees: 5.5, claimCost: 12.5, net: -7 });
    expect(r.costBy.MANUAL).toEqual({ count: 1, amount: 12.5 });
    const csv = await program.claimsCsv(SHOP, 30);
    expect(csv.split("\r\n")[1]).toContain("C-1001,#1001");
    expect(csv).toContain(",MANUAL,");
  });
});
