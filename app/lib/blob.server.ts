// Claim evidence in a private Vercel Blob store (BLOB_READ_WRITE_TOKEN).
// Customers upload straight from the browser with a client token issued by
// app/routes/proxy.upload.tsx; nothing is public — the admin reads files
// through app/routes/claim-files.$id.tsx.
import { del, get, head, list } from "@vercel/blob";
import prisma from "../db.server";
import { evidencePrefix } from "./claims";

export const uploadsConfigured = () => !!process.env.BLOB_READ_WRITE_TOKEN;

/** Size and type of an uploaded file, or null if it isn't there. */
export async function blobInfo(pathname: string) {
  try {
    const h = await head(pathname);
    return { size: h.size, contentType: h.contentType };
  } catch {
    return null;
  }
}

export async function openBlob(pathname: string) {
  return get(pathname, { access: "private" });
}

/** Best effort: a failed delete is logged, never thrown (redaction must finish). */
export async function deleteBlobs(pathnames: string[]) {
  if (!pathnames.length || !uploadsConfigured()) return;
  try {
    for (let i = 0; i < pathnames.length; i += 500) await del(pathnames.slice(i, i + 500));
  } catch (err) {
    console.error("[blob] delete failed:", err instanceof Error ? err.message : err);
  }
}

/** Every evidence file of a shop (or of one of its orders), uploaded or orphaned. */
export async function deleteBlobPrefix(shop: string, orderId?: string) {
  if (!uploadsConfigured()) return;
  const prefix = orderId ? evidencePrefix(shop, orderId) : `claims/${shop}/`;
  try {
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, cursor, limit: 1000 });
      await deleteBlobs(page.blobs.map((b) => b.pathname));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  } catch (err) {
    console.error("[blob] list failed:", err instanceof Error ? err.message : err);
  }
}

/** Uploads younger than this may still be attached by a claim being filled in. */
export const ORPHAN_AFTER_MS = 24 * 3600_000;

/** Pure: the listed blobs that no claim references and are old enough to go. */
export function orphanedBlobs(
  blobs: { pathname: string; uploadedAt: Date }[],
  attached: Set<string>,
  now: number,
): string[] {
  return blobs.filter((b) => !attached.has(b.pathname) && now - b.uploadedAt.getTime() > ORPHAN_AFTER_MS).map((b) => b.pathname);
}

/**
 * Evidence uploaded on the claims page but never attached to a claim (the
 * customer gave up, or removed the file before submitting). Deleted after a
 * day, so the store only holds files that belong to a claim.
 */
export async function cleanupOrphanUploads(deadline: number) {
  if (!uploadsConfigured()) return { skipped: "no blob store" };
  let checked = 0;
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: "claims/", cursor, limit: 1000 });
    const names = page.blobs.map((b) => b.pathname);
    const attached = new Set(
      (await prisma.claimFile.findMany({ where: { pathname: { in: names } }, select: { pathname: true } })).map(
        (f) => f.pathname,
      ),
    );
    const gone = orphanedBlobs(page.blobs, attached, Date.now());
    await deleteBlobs(gone);
    checked += names.length;
    deleted += gone.length;
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor && Date.now() < deadline);
  return { checked, deleted, finished: !cursor };
}
