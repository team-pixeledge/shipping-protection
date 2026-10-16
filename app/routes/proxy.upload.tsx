// Storefront: POST /apps/safeship/upload — issues a Vercel Blob client token
// so the browser uploads evidence straight to the private store (the bytes
// never pass through the proxy or this server). Only for a customer holding
// a valid order token (filing) or claim token (replying to an open claim),
// and only under that order's prefix.
import type { ActionFunctionArgs } from "react-router";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import prisma from "../db.server";
import { uploadsConfigured } from "../lib/blob.server";
import { verifyToken } from "../lib/claim-token.server";
import { MAX_UPLOAD_BYTES, OPEN_STATUSES, pathnameAllowed, UPLOAD_TYPES, type ClaimStatus } from "../lib/claims";
import { proxyContext } from "../lib/proxy.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const ctx = await proxyContext(request);
  if (!ctx.available || !uploadsConfigured()) return Response.json({ error: "Uploads aren't available" }, { status: 404 });
  const { shop } = ctx;

  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }
  // Only token requests: no completion callback is registered, so an
  // "upload completed" event here would be forged.
  if (body?.type !== "blob.generate-client-token") return Response.json({ error: "Bad request" }, { status: 400 });

  try {
    const json = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        let orderId = verifyToken(clientPayload, "order", shop)?.id;
        if (!orderId) {
          const claimId = verifyToken(clientPayload, "claim", shop)?.id;
          const claim = claimId ? await prisma.claim.findFirst({ where: { id: claimId, shop } }) : null;
          if (claim && OPEN_STATUSES.includes(claim.status as ClaimStatus)) orderId = claim.orderId;
        }
        if (!orderId || !pathnameAllowed(pathname, shop, orderId)) throw new Error("Not allowed");
        return {
          allowedContentTypes: UPLOAD_TYPES,
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
          addRandomSuffix: true,
          validUntil: Date.now() + 10 * 60_000,
        };
      },
    });
    return Response.json(json);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Upload refused" }, { status: 400 });
  }
};
