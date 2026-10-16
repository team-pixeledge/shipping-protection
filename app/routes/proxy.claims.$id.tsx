// Storefront: /apps/safeship/claims/:id?t=… — a claim's status page, from
// the link in the customer's emails. The token is the only access check
// (app proxies drop cookies); it's bound to this claim and this shop.
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { uploadsConfigured } from "../lib/blob.server";
import { verifyToken } from "../lib/claim-token.server";
import { evidencePrefix, OPEN_STATUSES, type ClaimItem, type ClaimStatus, type ClaimType, type Resolution } from "../lib/claims";
import { customerReply } from "../lib/claims.server";
import { statusPage, unavailablePage } from "../lib/portal-pages";
import { proxyContext, verifiedFiles } from "../lib/proxy.server";

async function load(request: Request, id: string | undefined, token: string | null) {
  const ctx = await proxyContext(request);
  const proof = verifyToken(token, "claim", ctx.shop);
  const claim =
    proof && id && proof.id === id ? await prisma.claim.findFirst({ where: { id, shop: ctx.shop } }) : null;
  return { ctx, claim, token: token ?? "" };
}

async function render(
  { ctx, claim, token }: Awaited<ReturnType<typeof load>> & { claim: NonNullable<Awaited<ReturnType<typeof load>>["claim"]> },
  notice: { ok?: string; error?: string } = {},
) {
  const events = await prisma.claimEvent.findMany({
    where: { claimId: claim.id, internal: false },
    orderBy: { createdAt: "asc" },
  });
  return ctx.render(
    statusPage({
      ...ctx.opts,
      number: claim.number,
      orderName: claim.orderName,
      type: claim.type as ClaimType,
      status: claim.status as ClaimStatus,
      resolution: claim.resolution as Resolution | null,
      items: claim.items as unknown as ClaimItem[],
      amount: Number(claim.amount),
      currency: claim.currency,
      createdAt: claim.createdAt.toISOString(),
      events: events.map((e) => ({ ...e, at: e.createdAt.toISOString() })),
      token,
      claimId: claim.id,
      uploads: uploadsConfigured(),
      uploadPrefix: evidencePrefix(claim.shop, claim.orderId),
      ...notice,
    }),
  );
}

const notFound = (ctx: Awaited<ReturnType<typeof proxyContext>>) =>
  ctx.render(
    unavailablePage(ctx.opts, "This link isn't valid any more. Use the link in your most recent email, or contact the store."),
    404,
  );

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const l = await load(request, params.id, new URL(request.url).searchParams.get("t"));
  if (!l.claim || !l.ctx.row) return notFound(l.ctx);
  return render({ ...l, claim: l.claim });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const form = await request.formData();
  const l = await load(request, params.id, String(form.get("token") ?? ""));
  if (!l.claim || !l.ctx.admin) return notFound(l.ctx);
  const claim = l.claim;
  if (!OPEN_STATUSES.includes(claim.status as ClaimStatus)) {
    return render({ ...l, claim }, { error: "This claim is closed. Please contact the store." });
  }
  const message = String(form.get("message") ?? "").trim().slice(0, 3000);
  const files = uploadsConfigured() ? await verifiedFiles(form, claim.shop, claim.orderId) : [];
  if (!message && !files.length) return render({ ...l, claim }, { error: "Write a message or add a file." });

  const updated = await customerReply(l.ctx.admin, { shop: claim.shop, claimId: claim.id, message, files });
  return render({ ...l, claim: updated }, { ok: "Sent — the store will be in touch." });
};
