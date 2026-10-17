import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { PLAN } from "../lib/plan";

/** Pages a merchant can open before approving the plan. */
const OPEN_WITHOUT_PLAN = ["/app/plan"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing, session, redirect } = await authenticate.admin(request);
  const path = new URL(request.url).pathname;
  if (!OPEN_WITHOUT_PLAN.includes(path)) {
    const row = await prisma.shop.findUnique({ where: { shop: session.shop }, select: { billingTest: true } });
    const { hasActivePayment } = await billing.check({ plans: [PLAN.name], isTest: row?.billingTest ?? false });
    if (!hasActivePayment) throw redirect("/app/plan");
  }
  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app" {...({ rel: "home" } as object)}>
          Home
        </s-link>
        <s-link href="/app/claims">Claims</s-link>
        <s-link href="/app/shipments">Shipments</s-link>
        <s-link href="/app/settings">Settings</s-link>
        <s-link href="/app/plan">Plan &amp; pricing</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
