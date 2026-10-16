// GET /app/claims/export?days=30 — claims CSV. Fetched by the Claims page
// (App Bridge adds the session token to same-origin fetches) and saved as
// a file in the browser.
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { claimsCsv, parsePeriod } from "../lib/program.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const days = parsePeriod(new URL(request.url).searchParams.get("days"));
  const csv = await claimsCsv(session.shop, days);
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response("﻿" + csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="claims-${days || "all"}d-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
};
