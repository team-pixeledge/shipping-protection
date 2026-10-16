// Claim evidence in a private Vercel Blob store (BLOB_READ_WRITE_TOKEN).
// Customers upload straight from the browser with a client token issued by
// app/routes/proxy.upload.tsx; nothing is public — the admin reads files
// through app/routes/claim-files.$id.tsx.
import { del, get, head, list } from "@vercel/blob";
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
