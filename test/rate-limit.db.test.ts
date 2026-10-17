// The lookup rate limiter against a real Postgres. Skipped unless
// TEST_DATABASE_URL is set (see resolutions.db.test.ts).
import { beforeAll, describe, expect, test } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("rate limits (database)", () => {
  let rl: typeof import("../app/lib/rate-limit.server");
  let prisma: typeof import("../app/db.server").default;
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DATABASE_URL_UNPOOLED = url;
    prisma = (await import("../app/db.server")).default;
    rl = await import("../app/lib/rate-limit.server");
  });

  test("allows up to the limit in a window, then refuses; a new window starts over", async () => {
    const key = `test:${Date.now()}`;
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await rl.allow(key, 3, 60_000));
    expect(results).toEqual([true, true, true, false, false]);
    await prisma.rateLimit.update({ where: { key }, data: { resetAt: new Date(Date.now() - 1000) } });
    expect(await rl.allow(key, 3, 60_000)).toBe(true);
    expect((await prisma.rateLimit.findUnique({ where: { key } }))?.count).toBe(1);
  });
});
