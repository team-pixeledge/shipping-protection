import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { ensureShop } from "./lib/shop.server";
import { PLAN, PLAN_TERMS } from "./lib/plan";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  // One usage plan (app/lib/plan.ts): amount is the cycle's cap; each
  // protected order past the free ones is a usage record (billing.server.ts).
  billing: {
    [PLAN.name]: {
      lineItems: [
        {
          interval: BillingInterval.Usage,
          amount: PLAN.cap,
          currencyCode: PLAN.currency,
          terms: PLAN_TERMS,
        },
      ],
    },
  },
  future: {
    expiringOfflineAccessTokens: true,
  },
  hooks: {
    // Only records the shop. Nothing is created in the store until the
    // merchant saves Settings — installing changes nothing on the storefront.
    afterAuth: async ({ session, admin }) => {
      const res = await admin.graphql(`#graphql
        query SpShopCurrency { shop { currencyCode plan { partnerDevelopment } } }`);
      const json = (await res.json()) as {
        data?: { shop: { currencyCode: string; plan: { partnerDevelopment: boolean } } };
      };
      await ensureShop(session.shop, json.data?.shop.currencyCode, {
        billingTest: process.env.BILLING_TEST === "true" || !!json.data?.shop.plan.partnerDevelopment,
      });
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
