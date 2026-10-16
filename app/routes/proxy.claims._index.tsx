// Storefront: /apps/safeship/claims — find the order, then file a claim.
// Step 1 (lookup) proves the customer placed the order: the order number
// plus the order's email, or being signed in as the order's customer. Step 2
// (submit) carries that proof as a signed token (app proxies drop cookies)
// and re-reads the order from Shopify — nothing the browser sends about the
// order, its items or prices is trusted.
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { signToken, verifyToken } from "../lib/claim-token.server";
import { uploadsConfigured } from "../lib/blob.server";
import {
  buildClaimItems,
  claimableLines,
  claimFlags,
  evidencePrefix,
  isClaimType,
  normalizeOrderName,
  orderEligibility,
  sameEmail,
  typeProblem,
  type ClaimOrder,
  type ClaimType,
} from "../lib/claims";
import {
  claimStatusPath,
  createClaim,
  findOrdersByName,
  getOrder,
  notifyNewClaim,
  orderIsProtected,
} from "../lib/claims.server";
import { claimFormPage, ineligiblePage, lookupPage, statusPage, unavailablePage } from "../lib/portal-pages";
import { proxyContext, verifiedFiles } from "../lib/proxy.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await proxyContext(request);
  if (!ctx.available) return ctx.render(unavailablePage(ctx.opts));
  return ctx.render(
    lookupPage({ ...ctx.opts, policy: ctx.claimSettings!.policy, signedIn: !!ctx.customerId }),
  );
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const ctx = await proxyContext(request);
  if (!ctx.available || !ctx.admin) return ctx.render(unavailablePage(ctx.opts));
  const { admin, shop, opts, render } = ctx;
  const settings = ctx.claimSettings!;
  const form = await request.formData();
  const now = new Date();

  const priorClaims = (orderId: string) =>
    prisma.claim.findMany({ where: { shop, orderId }, select: { id: true, status: true } });

  const formFor = (order: ClaimOrder, token: string, email: string, extra: Partial<Parameters<typeof claimFormPage>[0]> = {}) =>
    claimFormPage({
      ...opts,
      orderName: order.name,
      email,
      token,
      lines: claimableLines(order, ctx.row!.productId),
      currency: order.currency,
      uploads: uploadsConfigured(),
      photosForDamage: settings.photosForDamage,
      uploadPrefix: evidencePrefix(shop, order.id),
      ...extra,
    });

  // ---- Step 1: find the order ----
  if (form.get("intent") === "lookup") {
    const typed = String(form.get("order") ?? "").slice(0, 40);
    const email = String(form.get("email") ?? "").trim().slice(0, 254);
    const again = (error: string) =>
      render(lookupPage({ ...opts, policy: settings.policy, signedIn: !!ctx.customerId, error, orderName: typed, email }));
    if (!typed || (!email && !ctx.customerId)) return again("Enter your order number and email.");

    let orders: ClaimOrder[];
    try {
      orders = await findOrdersByName(admin, typed);
    } catch (err) {
      // Most likely: protected customer data (the order's email) not approved yet.
      console.error(`[claims] order lookup on ${shop}:`, err instanceof Error ? err.message : err);
      return again("We can't look up orders right now. Please try again later or contact the store.");
    }
    // One message for "no such order" and "wrong email": no probing for order numbers.
    const order = orders.find(
      (o) =>
        normalizeOrderName(o.name) === normalizeOrderName(typed) &&
        ((email && sameEmail(o.email, email)) || (!!ctx.customerId && o.customerId === ctx.customerId)),
    );
    if (!order) return again("We couldn't find an order with that number and email. Check both and try again.");
    const contact = (email || order.email || "").toLowerCase();
    if (!contact) return again("This order has no email address, so we can't send claim updates. Please contact the store.");

    const isProtected = await orderIsProtected(shop, order);
    const ok = orderEligibility(order, { settings, isProtected, prior: await priorClaims(order.id), now });
    if (!ok.ok) {
      return render(
        ineligiblePage({
          ...opts,
          orderName: order.name,
          reason: ok.reason,
          openClaimUrl: ok.openClaimId ? claimStatusPath(shop, opts.prefix, ok.openClaimId) : undefined,
        }),
      );
    }
    return render(formFor(order, signToken({ p: "order", shop, id: order.id, email: contact }), contact));
  }

  // ---- Step 2: file the claim ----
  const rawToken = String(form.get("token") ?? "");
  const proof = verifyToken(rawToken, "order", shop);
  if (!proof?.email) {
    return render(
      lookupPage({
        ...opts,
        policy: settings.policy,
        signedIn: !!ctx.customerId,
        error: "This page expired. Please find your order again.",
      }),
    );
  }
  const order = await getOrder(admin, proof.id).catch((err) => {
    console.error(`[claims] order ${proof.id} on ${shop}:`, err instanceof Error ? err.message : err);
    return null;
  });
  if (!order) return render(unavailablePage(opts, "We couldn't load this order. Please contact the store."));

  const isProtected = await orderIsProtected(shop, order);
  const ok = orderEligibility(order, { settings, isProtected, prior: await priorClaims(order.id), now });
  if (!ok.ok) {
    return render(
      ineligiblePage({
        ...opts,
        orderName: order.name,
        reason: ok.reason,
        openClaimUrl: ok.openClaimId ? claimStatusPath(shop, opts.prefix, ok.openClaimId) : undefined,
      }),
    );
  }

  const type = String(form.get("type") ?? "");
  const description = String(form.get("description") ?? "").trim().slice(0, 3000);
  const lines = claimableLines(order, ctx.row!.productId);
  const picked: Record<string, number> = {};
  for (const id of form.getAll("line").map(String)) {
    if (!/^\d+$/.test(id)) continue;
    picked[`gid://shopify/LineItem/${id}`] = Number(form.get(`qty_${id}`) ?? 1);
  }
  const { items, amount } = buildClaimItems(lines, picked);
  const files = uploadsConfigured() ? await verifiedFiles(form, shop, order.id) : [];

  const problem = !isClaimType(type)
    ? "Choose what happened to your package."
    : typeProblem(order, type, settings, now) ??
      (!items.length
        ? "Choose at least one affected item."
        : description.length < 10
          ? "Please describe what happened (at least a sentence)."
          : !form.get("confirm")
            ? "Please confirm the information is true."
            : type === "DAMAGED" &&
                settings.photosForDamage &&
                uploadsConfigured() &&
                !files.some((f) => f.contentType.startsWith("image/"))
              ? "Please add at least one photo of the damage."
              : null);
  if (problem) {
    return render(
      formFor(order, rawToken, proof.email, { error: problem, values: { type, description, picked } }),
      422,
    );
  }

  const otherClaims = await prisma.claim.count({ where: { shop, email: proof.email, orderId: { not: order.id } } });
  const claim = await createClaim({
    shop,
    order,
    type: type as ClaimType,
    email: proof.email,
    description,
    items,
    amount,
    isProtected,
    flags: claimFlags(order, type as ClaimType, isProtected, otherClaims),
    files,
  });
  await notifyNewClaim(admin, claim.id);

  const token = signToken({ p: "claim", shop, id: claim.id });
  const events = await prisma.claimEvent.findMany({
    where: { claimId: claim.id, internal: false },
    orderBy: { createdAt: "asc" },
  });
  return render(
    statusPage({
      ...opts,
      replaceUrl: `${opts.prefix}/claims/${claim.id}?t=${encodeURIComponent(token)}`,
      number: claim.number,
      orderName: claim.orderName,
      type: claim.type as ClaimType,
      status: "OPEN",
      resolution: null,
      items,
      amount,
      currency: claim.currency,
      createdAt: claim.createdAt.toISOString(),
      events: events.map((e) => ({ ...e, at: e.createdAt.toISOString() })),
      token,
      claimId: claim.id,
      uploads: uploadsConfigured(),
      uploadPrefix: evidencePrefix(shop, order.id),
      ok: "Thanks — your claim has been filed. We've emailed you a confirmation with a link to this page.",
    }),
  );
};
