import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

// The app has no public landing page: "/" always goes into the app, whose
// home is the dashboard. /app authenticates — inside the Shopify admin
// that's the embedded session; anywhere else it falls through to
// /auth/login.
export const loader = ({ request }: LoaderFunctionArgs) => {
  throw redirect(`/app${new URL(request.url).search}`);
};
