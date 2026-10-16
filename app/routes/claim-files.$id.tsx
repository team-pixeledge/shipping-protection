// GET /claim-files/:id?t=… — one evidence file, streamed from the private
// Blob store. The admin can't send its session token with an <img>, so the
// claim page hands out short-lived signed links instead (claim-token "file",
// 15 minutes). Only images and PDFs are ever stored; nosniff + a strict CSP
// keep a mislabelled upload from running as a page on our domain.
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { openBlob } from "../lib/blob.server";
import { tokenShop, verifyToken } from "../lib/claim-token.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const t = new URL(request.url).searchParams.get("t");
  const shop = tokenShop(t);
  const proof = shop ? verifyToken(t, "file", shop) : null;
  if (!proof || proof.id !== params.id) return new Response("Not found", { status: 404 });

  const file = await prisma.claimFile.findFirst({ where: { id: params.id, claim: { shop: proof.shop } } });
  const blob = file ? await openBlob(file.pathname).catch(() => null) : null;
  if (!file || !blob || blob.statusCode !== 200) return new Response("Not found", { status: 404 });

  const disposition = new URL(request.url).searchParams.get("download") ? "attachment" : "inline";
  const name = file.name.replace(/[^\w.-]+/g, "_");
  return new Response(blob.stream, {
    headers: {
      "Content-Type": file.contentType,
      "Content-Length": String(file.size),
      "Content-Disposition": `${disposition}; filename="${name}"`,
      "Cache-Control": "private, max-age=600",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      "Referrer-Policy": "no-referrer",
    },
  });
};
