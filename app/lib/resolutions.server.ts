// Carrying out an approved claim: refund, replacement order, store credit,
// or a cost recorded by hand. Money moves at most once per claim:
//   1. lock — a ClaimResolution row (PROCESSING) and Claim.resolutionLock,
//      taken with a conditional update, so a double click or two staff
//      members can't both refund;
//   2. Shopify — refundCreate carries @idempotent(key: <resolution id>), so
//      a retried request can't refund twice either;
//   3. finish (DONE, Claim.resolvedAt) or fail (FAILED, lock released).
// A resolved claim can't be reopened (app.claims.$id.tsx checks resolvedAt).
import prisma from "../db.server";
import {
  allocateRefund,
  formatClaimNumber,
  type ClaimItem,
  type ResolutionKind,
} from "./claims";
import { claimStatusUrl, getOrder, storeProfile } from "./claims.server";
import { claimResolvedEmail, sendEmail } from "./email.server";
import { claimLocale, DICTS, fill, formatMoney } from "./i18n";
import type { AdminGraphql } from "./setup.server";

type UserError = { field?: string[] | null; message: string };

async function gql<T>(admin: AdminGraphql, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await admin.graphql(query, variables ? { variables } : undefined);
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data as T;
}

function check(errors: UserError[] | undefined, what: string) {
  if (errors?.length) throw new Error(`${what}: ${errors.map((e) => e.message).join("; ")}`);
}

export class ResolutionError extends Error {}

const STUCK_MS = 5 * 60_000;

// ---- Refund preview ----

export interface RefundPreview {
  /** Items + their tax, presentment currency. */
  amount: number;
  currency: string;
  /** The same in the shop currency (what it costs the merchant). */
  shopAmount: number;
  shopCurrency: string;
  sources: { parentId: string; gateway: string; label: string; max: number }[];
}

/** What Shopify would refund for the claimed items (no restock — they're lost or damaged). */
export async function refundPreview(admin: AdminGraphql, orderId: string, items: ClaimItem[]): Promise<RefundPreview> {
  const data = await gql<{
    order: {
      suggestedRefund: {
        amountSet: { shopMoney: { amount: string; currencyCode: string }; presentmentMoney: { amount: string; currencyCode: string } };
        suggestedTransactions: {
          gateway: string | null;
          formattedGateway: string | null;
          accountNumber: string | null;
          parentTransaction: { id: string } | null;
          maximumRefundableSet: { presentmentMoney: { amount: string } } | null;
          amountSet: { presentmentMoney: { amount: string } };
        }[];
      };
    } | null;
  }>(
    admin,
    `#graphql
    query SpRefundPreview($id: ID!, $lines: [RefundLineItemInput!]) {
      order(id: $id) {
        suggestedRefund(refundLineItems: $lines, suggestFullRefund: false) {
          amountSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
          suggestedTransactions {
            gateway formattedGateway accountNumber
            parentTransaction { id }
            maximumRefundableSet { presentmentMoney { amount } }
            amountSet { presentmentMoney { amount } }
          }
        }
      }
    }`,
    {
      id: `gid://shopify/Order/${orderId}`,
      lines: items.map((i) => ({ lineItemId: i.lineItemId, quantity: i.quantity, restockType: "NO_RESTOCK" })),
    },
  );
  const s = data.order?.suggestedRefund;
  if (!s) throw new ResolutionError("The order can't be found in Shopify.");
  return {
    amount: Number(s.amountSet.presentmentMoney.amount),
    currency: s.amountSet.presentmentMoney.currencyCode,
    shopAmount: Number(s.amountSet.shopMoney.amount),
    shopCurrency: s.amountSet.shopMoney.currencyCode,
    sources: s.suggestedTransactions
      .filter((t) => t.parentTransaction && t.gateway)
      .map((t) => ({
        parentId: t.parentTransaction!.id,
        gateway: t.gateway!,
        label: [t.formattedGateway ?? t.gateway, t.accountNumber].filter(Boolean).join(" "),
        max: Number(t.maximumRefundableSet?.presentmentMoney.amount ?? t.amountSet.presentmentMoney.amount),
      })),
  };
}

// ---- Lock / finish / fail ----

async function lock(shop: string, claimId: string, type: ResolutionKind, currency: string) {
  return prisma.$transaction(async (tx) => {
    const claim = await tx.claim.findFirst({ where: { id: claimId, shop } });
    if (!claim) throw new ResolutionError("Claim not found.");
    if (claim.status !== "APPROVED") throw new ResolutionError("Only approved claims can be resolved.");
    if (claim.resolvedAt) throw new ResolutionError("This claim has already been resolved.");
    if (claim.resolutionLock) {
      const running = await tx.claimResolution.findUnique({ where: { id: claim.resolutionLock } });
      if (running && running.status === "PROCESSING") {
        throw new ResolutionError(
          Date.now() - running.createdAt.getTime() > STUCK_MS
            ? "An earlier attempt didn't finish. Check the order in Shopify, then clear it below before trying again."
            : "This claim is being resolved right now. Reload in a moment.",
        );
      }
    }
    const row = await tx.claimResolution.create({ data: { claimId, type, amount: 0, currency } });
    const got = await tx.claim.updateMany({
      where: { id: claimId, shop, status: "APPROVED", resolvedAt: null, resolutionLock: claim.resolutionLock },
      data: { resolutionLock: row.id },
    });
    if (got.count !== 1) throw new ResolutionError("Someone else is resolving this claim. Reload and check.");
    return { claim, row };
  });
}

async function finish(
  claimId: string,
  rowId: string,
  type: ResolutionKind,
  data: { amount: number; currency: string; shopifyId?: string | null; shopifyName?: string | null; note?: string | null },
  summary: string,
  customerText: string,
) {
  await prisma.$transaction([
    prisma.claimResolution.update({
      where: { id: rowId },
      data: { ...data, status: "DONE", completedAt: new Date() },
    }),
    prisma.claim.update({
      where: { id: claimId },
      data: {
        resolvedAt: new Date(),
        resolution: type === "MANUAL" ? undefined : type,
      },
    }),
    // Staff see the details (costs included); the customer sees only what they get.
    prisma.claimEvent.create({ data: { claimId, actor: "MERCHANT", kind: "RESOLVED", internal: true, message: summary } }),
    ...(customerText
      ? [prisma.claimEvent.create({ data: { claimId, actor: "MERCHANT", kind: "RESOLVED", message: customerText } })]
      : []),
  ]);
}

async function fail(claimId: string, rowId: string, error: string) {
  await prisma.$transaction([
    prisma.claimResolution.update({ where: { id: rowId }, data: { status: "FAILED", error: error.slice(0, 1000) } }),
    prisma.claim.updateMany({ where: { id: claimId, resolutionLock: rowId }, data: { resolutionLock: null } }),
    prisma.claimEvent.create({
      data: { claimId, actor: "SYSTEM", kind: "NOTE", internal: true, message: `Resolution failed: ${error.slice(0, 500)}` },
    }),
  ]);
}

/** The merchant checked Shopify and says an interrupted attempt didn't go through. */
export async function clearStuck(shop: string, claimId: string) {
  const claim = await prisma.claim.findFirst({ where: { id: claimId, shop } });
  if (!claim?.resolutionLock || claim.resolvedAt) return;
  const row = await prisma.claimResolution.findUnique({ where: { id: claim.resolutionLock } });
  if (!row || row.status !== "PROCESSING" || Date.now() - row.createdAt.getTime() < STUCK_MS) {
    throw new ResolutionError("Nothing to clear.");
  }
  await fail(claimId, row.id, "Interrupted; cleared by staff after checking Shopify.");
}

// ---- The actions ----

export type ResolveInput =
  | { type: "REFUND"; amount?: number | null; notify: boolean }
  | { type: "REPLACEMENT"; cost: number }
  | { type: "STORE_CREDIT"; amount: number }
  | { type: "MANUAL"; cost: number; note: string };

export async function resolveClaim(admin: AdminGraphql, shop: string, claimId: string, input: ResolveInput) {
  const shopRow = await prisma.shop.findUniqueOrThrow({ where: { shop } });
  const { claim, row } = await lock(shop, claimId, input.type, shopRow.currency);
  const n = formatClaimNumber(claim.number);
  const items = claim.items as unknown as ClaimItem[];
  const money = (a: number, c: string) => new Intl.NumberFormat("en", { style: "currency", currency: c }).format(a);

  try {
    let done: Parameters<typeof finish>[3];
    let summary: string;
    let customerText: string;
    // What the customer reads (event + email) is in the claim's language.
    const lang = claimLocale(claim.locale);
    const t = DICTS[lang];

    if (input.type === "REFUND") {
      const preview = await refundPreview(admin, claim.orderId, items);
      if (!preview.sources.length || !(preview.amount > 0)) {
        throw new ResolutionError("Shopify has nothing left to refund on this order for these items.");
      }
      const custom = input.amount != null && Math.round(input.amount * 100) !== Math.round(preview.amount * 100);
      const amount = custom ? input.amount! : preview.amount;
      if (custom && amount > preview.amount) {
        throw new ResolutionError(`You can refund at most ${money(preview.amount, preview.currency)} for these items.`);
      }
      const transactions = allocateRefund(preview.sources, amount);
      if (!transactions) throw new ResolutionError("That amount is more than the order's payments can refund.");
      const res = await gql<{
        refundCreate: {
          refund: { id: string; totalRefundedSet: { shopMoney: { amount: string; currencyCode: string } } } | null;
          userErrors: UserError[];
        };
      }>(
        admin,
        `#graphql
        mutation SpRefund($input: RefundInput!, $key: String!) {
          refundCreate(input: $input) @idempotent(key: $key) {
            refund { id totalRefundedSet { shopMoney { amount currencyCode } } }
            userErrors { field message }
          }
        }`,
        {
          key: `claim-refund-${row.id}`,
          input: {
            orderId: `gid://shopify/Order/${claim.orderId}`,
            currency: preview.currency,
            notify: input.notify,
            note: `Shipping protection claim ${n}`,
            // A custom amount is money only; the full amount refunds the items too.
            ...(custom
              ? {}
              : {
                  refundLineItems: items.map((i) => ({
                    lineItemId: i.lineItemId,
                    quantity: i.quantity,
                    restockType: "NO_RESTOCK",
                  })),
                }),
            transactions: transactions.map((t) => ({
              orderId: `gid://shopify/Order/${claim.orderId}`,
              parentId: t.parentId,
              gateway: t.gateway,
              kind: "REFUND",
              amount: t.amount.toFixed(2),
            })),
          },
        },
      );
      check(res.refundCreate.userErrors, "Shopify refused the refund");
      const refund = res.refundCreate.refund!;
      const cost = Number(refund.totalRefundedSet.shopMoney.amount);
      done = { amount: cost, currency: refund.totalRefundedSet.shopMoney.currencyCode, shopifyId: refund.id };
      summary = `Refunded ${money(amount, preview.currency)}${custom ? " (custom amount)" : ""} on ${claim.orderName}.`;
      customerText = fill(t.mailRefunded, { amount: formatMoney(amount, preview.currency, lang) });
    } else if (input.type === "REPLACEMENT") {
      const order = await getOrder(admin, claim.orderId);
      if (!order) throw new ResolutionError("The order can't be found in Shopify.");
      const lines = items.map((i) => {
        const l = order.lines.find((x) => x.id === i.lineItemId);
        if (!l?.variantId) throw new ResolutionError(`“${i.title}” no longer exists as a product variant. Create the replacement in Shopify.`);
        return { variantId: l.variantId, quantity: i.quantity };
      });
      const created = await gql<{
        draftOrderCreateFromOrder: { draftOrder: { id: string; presentmentCurrencyCode: string } | null; userErrors: UserError[] };
      }>(
        admin,
        `#graphql
        mutation SpReplacementDraft($orderId: ID!) {
          draftOrderCreateFromOrder(orderId: $orderId) {
            draftOrder { id presentmentCurrencyCode }
            userErrors { field message }
          }
        }`,
        { orderId: `gid://shopify/Order/${claim.orderId}` },
      );
      check(created.draftOrderCreateFromOrder.userErrors, "Creating the replacement draft");
      const draft = created.draftOrderCreateFromOrder.draftOrder!;
      await prisma.claimResolution.update({ where: { id: row.id }, data: { shopifyId: draft.id } });
      const updated = await gql<{ draftOrderUpdate: { userErrors: UserError[] } }>(
        admin,
        `#graphql
        mutation SpReplacementUpdate($id: ID!, $input: DraftOrderInput!) {
          draftOrderUpdate(id: $id, input: $input) { userErrors { field message } }
        }`,
        {
          id: draft.id,
          input: {
            lineItems: lines,
            appliedDiscount: { valueType: "PERCENTAGE", value: 100, title: `Claim ${n}` },
            shippingLine: {
              title: "Replacement shipping",
              priceWithCurrency: { amount: "0.00", currencyCode: draft.presentmentCurrencyCode },
            },
            tags: ["Shipping protection replacement"],
            note: `Replacement for ${claim.orderName} — shipping protection claim ${n}.`,
          },
        },
      );
      check(updated.draftOrderUpdate.userErrors, "Preparing the replacement");
      const completed = await gql<{
        draftOrderComplete: { draftOrder: { order: { id: string; name: string } | null } | null; userErrors: UserError[] };
      }>(
        admin,
        `#graphql
        mutation SpReplacementComplete($id: ID!) {
          draftOrderComplete(id: $id) {
            draftOrder { order { id name } }
            userErrors { field message }
          }
        }`,
        { id: draft.id },
      );
      check(completed.draftOrderComplete.userErrors, "Completing the replacement order");
      const newOrder = completed.draftOrderComplete.draftOrder?.order;
      if (!newOrder) throw new ResolutionError("Shopify didn't create the replacement order.");
      done = {
        amount: input.cost,
        currency: shopRow.currency,
        shopifyId: newOrder.id,
        shopifyName: newOrder.name,
      };
      summary = `Replacement order ${newOrder.name} created (cost recorded: ${money(input.cost, shopRow.currency)}).`;
      customerText = fill(t.mailReplacement, { replacement: newOrder.name });
    } else if (input.type === "STORE_CREDIT") {
      if (!(input.amount > 0)) throw new ResolutionError("Enter an amount above 0.");
      const order = await getOrder(admin, claim.orderId);
      if (!order?.customerId) throw new ResolutionError("This order has no customer account, so store credit can't be issued.");
      const res = await gql<{
        storeCreditAccountCredit: {
          storeCreditAccountTransaction: { id: string; amount: { amount: string; currencyCode: string } } | null;
          userErrors: UserError[];
        };
      }>(
        admin,
        `#graphql
        mutation SpStoreCredit($id: ID!, $credit: StoreCreditAccountCreditInput!) {
          storeCreditAccountCredit(id: $id, creditInput: $credit) {
            storeCreditAccountTransaction { id amount { amount currencyCode } }
            userErrors { field message }
          }
        }`,
        {
          id: `gid://shopify/Customer/${order.customerId}`,
          credit: { creditAmount: { amount: input.amount.toFixed(2), currencyCode: shopRow.currency }, notify: false },
        },
      );
      check(res.storeCreditAccountCredit.userErrors, "Shopify refused the store credit");
      const credit = res.storeCreditAccountCredit.storeCreditAccountTransaction!;
      done = { amount: Number(credit.amount.amount), currency: credit.amount.currencyCode, shopifyId: credit.id };
      summary = `Store credit of ${money(input.amount, shopRow.currency)} issued.`;
      customerText = fill(t.mailStoreCredit, { amount: formatMoney(input.amount, shopRow.currency, lang) });
    } else {
      if (!(input.cost >= 0)) throw new ResolutionError("Enter the cost (0 if there was none).");
      done = { amount: input.cost, currency: shopRow.currency, note: input.note || null };
      summary = `Recorded as handled outside the app (cost ${money(input.cost, shopRow.currency)})${input.note ? `: ${input.note}` : "."}`;
      customerText = "";
    }

    await finish(claim.id, row.id, input.type, done, summary, customerText);
    await tagOrder(admin, claim.orderId);
    if (customerText) await emailCustomer(admin, claim, input.type, customerText);
    return { summary };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await fail(claim.id, row.id, message);
    throw err instanceof ResolutionError ? err : new ResolutionError(message);
  }
}

/** Best effort: makes resolved claims findable in the Orders list. */
async function tagOrder(admin: AdminGraphql, orderId: string) {
  try {
    await admin.graphql(
      `#graphql
      mutation SpClaimTag($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
      { variables: { id: `gid://shopify/Order/${orderId}`, tags: ["Shipping protection claim"] } },
    );
  } catch (err) {
    console.warn("[resolutions] tag:", err instanceof Error ? err.message : err);
  }
}

async function emailCustomer(
  admin: AdminGraphql,
  claim: { id: string; number: number; orderName: string; email: string; shop: string; locale: string },
  _type: ResolutionKind,
  text: string,
) {
  try {
    const shopRow = await prisma.shop.findUniqueOrThrow({ where: { shop: claim.shop } });
    const store = await storeProfile(admin);
    const lang = claimLocale(claim.locale);
    const mail = claimResolvedEmail({
      storeName: store.name,
      number: claim.number,
      orderName: claim.orderName,
      statusUrl: claimStatusUrl(claim.shop, shopRow.portalPath, claim.id, lang),
      lang,
      text,
    });
    const sent = await sendEmail({
      storeName: store.name,
      to: claim.email,
      replyTo: store.contactEmail ?? store.email,
      ...mail,
      idempotencyKey: `claim-resolved-${claim.id}`,
    });
    await prisma.claimEvent.create({
      data: {
        claimId: claim.id,
        actor: "SYSTEM",
        kind: "EMAIL",
        internal: true,
        message: sent.ok ? `Resolution email sent to ${claim.email}` : `Resolution email not sent to ${claim.email}: ${sent.error}`,
      },
    });
  } catch (err) {
    console.error("[resolutions] email:", err instanceof Error ? err.message : err);
  }
}
