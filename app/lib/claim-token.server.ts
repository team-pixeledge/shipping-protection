// Signed tokens for the storefront claims page. App proxies don't forward
// cookies, so the state between steps travels in these instead:
//   order — the customer proved who they are for this order (2 hours)
//   claim — the link to one claim's status page, sent by email (180 days)
//   file  — a short-lived link to one evidence file, for the admin
// HMAC-SHA256 with the app secret; tied to the shop, so one store's token is
// worthless on another.
import { createHmac, timingSafeEqual } from "node:crypto";

export type TokenPurpose = "order" | "claim" | "file";

export interface TokenPayload {
  p: TokenPurpose;
  shop: string;
  id: string;
  /** For "order": the email the customer verified with. */
  email?: string;
  exp: number; // ms since epoch
}

export const TOKEN_TTL: Record<TokenPurpose, number> = {
  order: 2 * 3600_000,
  claim: 180 * 86_400_000,
  file: 15 * 60_000,
};

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");

function secret(override?: string) {
  const s = override ?? process.env.SHOPIFY_API_SECRET;
  if (!s) throw new Error("SHOPIFY_API_SECRET is not set");
  return s;
}

export function signToken(
  data: Omit<TokenPayload, "exp"> & { exp?: number },
  opts: { secret?: string; now?: number } = {},
): string {
  const payload: TokenPayload = { ...data, exp: data.exp ?? (opts.now ?? Date.now()) + TOKEN_TTL[data.p] };
  const body = b64(JSON.stringify(payload));
  const sig = createHmac("sha256", secret(opts.secret)).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/** The payload, or null if the token is forged, expired, or for another purpose or shop. */
export function verifyToken(
  token: string | null | undefined,
  purpose: TokenPurpose,
  shop: string,
  opts: { secret?: string; now?: number } = {},
): TokenPayload | null {
  if (!token || token.length > 2000) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret(opts.secret)).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload.p !== purpose || payload.shop !== shop) return null;
  if (typeof payload.exp !== "number" || payload.exp < (opts.now ?? Date.now())) return null;
  return payload;
}

/**
 * The shop a token claims to be for, unverified — only to pick the shop to
 * pass to verifyToken (which checks the signature over the whole payload).
 */
export function tokenShop(token: string | null | undefined): string | null {
  try {
    const shop = JSON.parse(Buffer.from((token ?? "").split(".")[0], "base64url").toString("utf8")).shop;
    return typeof shop === "string" ? shop : null;
  } catch {
    return null;
  }
}
