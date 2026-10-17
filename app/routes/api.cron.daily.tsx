import type { LoaderFunctionArgs } from "react-router";
import { timingSafeEqual } from "node:crypto";
import { runDaily } from "../lib/daily.server";

// Vercel Cron calls this once a day (vercel.json) with
// "Authorization: Bearer $CRON_SECRET". Anyone else gets a 401.
export const config = { maxDuration: 300 };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const secret = process.env.CRON_SECRET;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  if (!secret || given.length !== want.length || !timingSafeEqual(given, want)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const report = await runDaily();
  console.log("[cron] daily:", JSON.stringify(report));
  return Response.json(report);
};
