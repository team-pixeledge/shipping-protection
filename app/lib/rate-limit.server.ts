// Fixed-window counters in Postgres (serverless instances share no memory).
// One atomic statement per hit: a window that has run out starts over.
// All times are the database's own clock (now()): mixing it with the app
// server's clock made windows reset early when the two disagreed.
import prisma from "../db.server";

/** Counts a hit; false once `limit` hits were made in the current window. */
export async function allow(key: string, limit: number, windowMs: number): Promise<boolean> {
  const ms = Math.round(windowMs);
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimit" ("key", "count", "resetAt")
    VALUES (${key}, 1, (now() AT TIME ZONE 'UTC') + ${ms} * interval '1 millisecond')
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "RateLimit"."resetAt" < (now() AT TIME ZONE 'UTC') THEN 1 ELSE "RateLimit"."count" + 1 END,
      "resetAt" = CASE WHEN "RateLimit"."resetAt" < (now() AT TIME ZONE 'UTC')
        THEN (now() AT TIME ZONE 'UTC') + ${ms} * interval '1 millisecond'
        ELSE "RateLimit"."resetAt" END
    RETURNING "count"`;
  return (rows[0]?.count ?? 1) <= limit;
}

/** The shopper's IP as the proxy reports it (first X-Forwarded-For hop), if any. */
export function clientIp(request: Request): string | null {
  const first = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  return /^[\d.:a-fA-F]{3,45}$/.test(first) ? first : null;
}

const WINDOW = 15 * 60_000;

/**
 * Order lookups on the claims page: a guess needs an order number AND its
 * email, so these limits only slow down someone trying many combinations.
 * Per order number, per shopper IP (when known) and per shop overall.
 */
export async function lookupAllowed(shop: string, orderName: string, ip: string | null) {
  const checks = [
    allow(`lookup:${shop}:order:${orderName}`, 8, WINDOW),
    allow(`lookup:${shop}:all`, 600, WINDOW),
    ...(ip ? [allow(`lookup:${shop}:ip:${ip}`, 20, WINDOW)] : []),
  ];
  return (await Promise.all(checks)).every(Boolean);
}
