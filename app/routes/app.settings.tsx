import { useEffect, useMemo, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  buildLadder,
  computeFee,
  fromMinor,
  OPT_IN_REQUIRED_COUNTRIES,
  snapIndex,
  toMinor,
  type CoverageMode,
  type FeeMode,
  type PricingRules,
  type Tier,
} from "../../shared/pricing";
import {
  currencyDecimals,
  DEFAULT_SETTINGS,
  missingOptInCountries,
  parseSettings,
  settingsErrors,
  type Settings,
} from "../lib/settings";
import { removeFromStore } from "../lib/remove.server";
import { syncProtection } from "../lib/setup.server";
import { ensureShop } from "../lib/shop.server";
import { uploadsConfigured } from "../lib/blob.server";
import { emailConfigured } from "../lib/email.server";
import type { ClaimSettings } from "../lib/claims";
import { EMBED_HANDLE, embedStatus } from "../lib/embed.server";
import { listMarkets } from "../lib/markets.server";
import { exactPricingAvailable } from "../lib/cart-transform.server";
import { MAX_MARKET_PRICES } from "../lib/settings";
import { hasFeature, isPlanId } from "../lib/plan";
import { UpgradeNotice } from "../components/Upgrade";
import type { TrackingSettings } from "../lib/tracking";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const [embed, plus] = await Promise.all([
    embedStatus(admin).catch(() => ({ status: "unknown" as const })),
    exactPricingAvailable(admin),
  ]);
  const apiKey = process.env.SHOPIFY_API_KEY || "";
  return {
    embed: embed.status,
    plus,
    features: Object.fromEntries(
      (
        [
          "tracking",
          "claimRules",
          "marketPrices",
          "exactPricing",
          "checkoutToggle",
        ] as const
      ).map((f) => [f, hasFeature(isPlanId(shop.plan) ? shop.plan : null, f)]),
    ) as Record<
      | "tracking"
      | "claimRules"
      | "marketPrices"
      | "exactPricing"
      | "checkoutToggle",
      boolean
    >,
    embedUrl: `shopify://admin/themes/current/editor?context=apps&activateAppId=${apiKey}/${EMBED_HANDLE}`,
    settings: shop.settings ? parseSettings(shop.settings) : DEFAULT_SETTINGS,
    configured: shop.settings !== null && shop.productId !== null,
    currency: shop.currency,
    decimals: currencyDecimals(shop.currency),
    portalUrl: `https://${shop.shop}${shop.portalPath}/claims`,
    emailReady: emailConfigured(),
    uploadsReady: uploadsConfigured(),
  };
};

type MarketRow = {
  id: number;
  name: string;
  currency: string;
  countries: string[];
};
type ActionResult =
  | {
      ok: true;
      intent: string;
      problems?: string[];
      warnings?: string[];
      markets?: MarketRow[];
    }
  | { ok: false; errors: string[] };

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionResult> => {
  const { session, admin } = await authenticate.admin(request);
  await ensureShop(session.shop);
  const body = (await request.json()) as {
    intent?: string;
    settings?: unknown;
  };

  if (body.intent === "markets") {
    try {
      const markets = await listMarkets(admin);
      return {
        ok: true,
        intent: "markets",
        markets: markets.map((m) => ({
          id: m.id,
          name: m.name,
          currency: m.currency,
          countries: m.countries,
        })),
      };
    } catch (err) {
      return {
        ok: false,
        errors: [
          `Couldn't load your markets: ${err instanceof Error ? err.message : String(err)}`,
        ],
      };
    }
  }

  if (body.intent === "remove") {
    const problems = await removeFromStore(admin, session.shop);
    await prisma.shop.update({
      where: { shop: session.shop },
      data: { settings: Prisma.DbNull },
    });
    return { ok: true, intent: "remove", problems };
  }

  // Whitelisted and coerced — never pass the body to Prisma.
  const settings = parseSettings(body.settings);
  const errors = settingsErrors(settings);
  if (errors.length) return { ok: false, errors };

  await prisma.shop.update({
    where: { shop: session.shop },
    data: { settings: settings as object, version: { increment: 1 } },
  });
  try {
    const { warnings } = await syncProtection(admin, session.shop);
    return { ok: true, intent: "save", warnings };
  } catch (err) {
    return {
      ok: false,
      errors: [
        `Saved, but your store couldn't be updated: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
};

/** Sample cart values sized to the currency (¥10 isn't a cart). */
const SCALE: Record<string, number> = {
  JPY: 100,
  KRW: 1000,
  INR: 50,
  HUF: 300,
  IDR: 10000,
  VND: 20000,
  CLP: 800,
  COP: 3000,
  ISK: 100,
  PHP: 50,
  THB: 30,
  TWD: 30,
  CZK: 20,
  RUB: 80,
  MXN: 15,
  ZAR: 15,
  TRY: 30,
  PKR: 250,
  NGN: 1000,
};
const SAMPLES = [10, 25, 50, 100, 250, 500, 1000];

export default function SettingsPage() {
  const loaded = useLoaderData<typeof loader>();
  const [s, setS] = useState<Settings>(loaded.settings);
  const [countries, setCountries] = useState(
    loaded.settings.optInCountries.join(", "),
  );
  const [covTags, setCovTags] = useState(
    loaded.settings.coverage.tags.join(", "),
  );
  const [covTypes, setCovTypes] = useState(
    loaded.settings.coverage.productTypes.join(", "),
  );
  const [covVendors, setCovVendors] = useState(
    loaded.settings.coverage.vendors.join(", "),
  );
  const [tryValue, setTryValue] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const fetcher = useFetcher<ActionResult>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    const d = fetcher.data;
    if (!d) return;
    if (d.ok && d.intent === "save")
      shopify.toast.show("Saved — your store is updated");
    if (d.ok && d.intent === "remove")
      shopify.toast.show("Removed from your store");
  }, [fetcher.data, shopify]);

  const setClaims = (patch: Partial<ClaimSettings>) =>
    setS({ ...s, claims: { ...s.claims, ...patch } });
  const setTracking = (patch: Partial<TrackingSettings>) =>
    setS({ ...s, tracking: { ...s.tracking, ...patch } });
  const days = (
    label: string,
    value: number,
    max: number,
    onChange: (n: number) => void,
    details?: string,
  ) => (
    <s-number-field
      label={label}
      details={details}
      value={String(value)}
      min={0}
      max={max}
      step={1}
      suffix="days"
      onInput={(e) => onChange(Number(e.currentTarget.value) || 0)}
    />
  );
  const setRules = (patch: Partial<PricingRules>) =>
    setS({ ...s, rules: { ...s.rules, ...patch } });
  const setTier = (i: number, patch: Partial<Tier>) =>
    setRules({
      tiers: s.rules.tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)),
    });

  const parsedCountries = countries
    .split(/[\s,]+/)
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  const list = (v: string) => [
    ...new Set(
      v
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
  const current: Settings = {
    ...s,
    optInCountries: parsedCountries,
    coverage: {
      ...s.coverage,
      tags: list(covTags),
      productTypes: list(covTypes),
      vendors: list(covVendors),
    },
  };
  const errors = settingsErrors(current);
  const missing = missingOptInCountries(current);
  const dirty =
    JSON.stringify(current) !== JSON.stringify(loaded.settings) ||
    !loaded.configured;

  const money = (n: number) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: loaded.currency,
    }).format(n);
  const hasErrors = errors.length > 0;
  const ladder = useMemo(
    () => (hasErrors ? [] : buildLadder(s.rules, loaded.decimals)),
    [s.rules, loaded.decimals, hasErrors],
  );
  const charged = (subtotal: number) => {
    const fee = computeFee(s.rules, subtotal);
    if (fee === null || !ladder.length) return null;
    return {
      fee,
      price: fromMinor(
        ladder[snapIndex(ladder, toMinor(fee, loaded.decimals))],
        loaded.decimals,
      ),
    };
  };
  const scale = SCALE[loaded.currency] ?? 1;
  const samples = [
    ...SAMPLES.map((n) => n * scale),
    ...(Number(tryValue) > 0 ? [Number(tryValue)] : []),
  ];
  const usesPercent =
    s.rules.mode === "PERCENT" ||
    (s.rules.mode === "TIERED" &&
      s.rules.tiers.some((t) => t.type === "PERCENT"));

  const num = (v: string) => (v.trim() === "" ? NaN : Number(v));
  const field = (
    label: string,
    value: number,
    onChange: (n: number) => void,
    opts: { suffix?: string; details?: string } = {},
  ) => (
    <s-number-field
      label={label}
      value={Number.isFinite(value) ? String(value) : ""}
      min={0}
      step={0.01}
      suffix={opts.suffix ?? loaded.currency}
      details={opts.details}
      onInput={(e) => onChange(num(e.currentTarget.value))}
    />
  );

  const pickProducts = async () => {
    const picked = (await shopify.resourcePicker({
      type: "product",
      multiple: true,
      filter: { variants: false },
      selectionIds: s.coverage.productIds.map((id) => ({
        id: `gid://shopify/Product/${id}`,
      })),
    })) as { id: string; title: string }[] | undefined;
    if (!picked) return;
    const ids = picked.map((p) => Number(p.id.split("/").pop())).slice(0, 250);
    setS({
      ...s,
      coverage: { ...s.coverage, productIds: ids },
      coverageProductTitles: Object.fromEntries(
        picked.map((p) => [p.id.split("/").pop()!, p.title]),
      ),
    });
  };
  const removeProduct = (id: number) =>
    setS({
      ...s,
      coverage: {
        ...s.coverage,
        productIds: s.coverage.productIds.filter((x) => x !== id),
      },
    });

  const save = () =>
    fetcher.submit({ intent: "save", settings: current } as never, {
      method: "POST",
      encType: "application/json",
    });

  return (
    <s-page heading="Settings">
      <s-button
        slot="primary-action"
        onClick={save}
        disabled={!dirty || errors.length > 0}
        {...(busy ? { loading: true } : {})}
      >
        Save
      </s-button>

      {fetcher.data?.ok &&
        fetcher.data.intent === "save" &&
        (fetcher.data.warnings?.length ?? 0) > 0 && (
          <s-banner tone="warning" heading="Saved, with something to check">
            <s-unordered-list>
              {fetcher.data.warnings!.map((w) => (
                <s-list-item key={w}>{w}</s-list-item>
              ))}
            </s-unordered-list>
          </s-banner>
        )}
      {fetcher.data && !fetcher.data.ok && (
        <s-banner tone="critical" heading="Not saved">
          <s-unordered-list>
            {fetcher.data.errors.map((e) => (
              <s-list-item key={e}>{e}</s-list-item>
            ))}
          </s-unordered-list>
        </s-banner>
      )}
      <SetupGuide
        steps={[
          {
            done: true,
            title: "Approve the plan",
            body: (
              <>
                Done — see <s-link href="/app/plan">Plan &amp; pricing</s-link>{" "}
                for what you pay and the FAQ.
              </>
            ),
          },
          {
            done: loaded.configured,
            title:
              "Choose your pricing and which products are covered, then Save",
            body: "Pricing and “Which products are covered” below. The Preview shows what customers pay for sample carts. Saving creates the hidden Shipping protection product and the checkout rule in your store.",
          },
          {
            done: loaded.embed === "on",
            title: "Turn on the app embed in your theme",
            body: (
              <>
                This shows the protection toggle in the cart drawer and cart
                page.{" "}
                <s-link href={loaded.embedUrl} target="_top">
                  Open the theme editor
                </s-link>
                , switch on &ldquo;Shipping protection&rdquo; and save the
                theme.
                {loaded.embed === "unknown" &&
                  " (We couldn't check your theme — make sure it's on.)"}
              </>
            ),
          },
          {
            done: loaded.configured,
            title: "Decide whether protection starts ticked",
            body: "“Default choice” below. Customers in the EU, EEA, UK and Switzerland always start unticked, as the law there requires.",
          },
          {
            done: s.claims.enabled,
            title: "Turn on the claims page (recommended)",
            body: "Under Claims below. Then add the claims page link to your footer menu, shipping policy and order confirmation email so customers can find it.",
          },
          {
            done: loaded.emailReady,
            title: "Check that claim emails can be sent",
            body: loaded.emailReady
              ? "Claim emails are set up."
              : "Claim emails aren't being sent yet: the app's email service isn't configured. Claims still work; customers just don't get emails.",
          },
          {
            done: false,
            title: "Place a test order",
            body: "Add a product to your cart, check the protection toggle and the price, and complete checkout. The order appears on Home, tagged “Shipping protection”, and its package on Shipments once you fulfil it.",
          },
        ]}
      />

      {!loaded.configured && (
        <s-banner tone="info" heading="Nothing is live yet">
          Saving this page creates the hidden &ldquo;Shipping protection&rdquo;
          product and the checkout rule in your store. Customers see the toggle
          once you also turn on the app embed (see Home).
        </s-banner>
      )}

      <s-section heading="Status">
        <s-checkbox
          label="Offer shipping protection"
          details="Off: customers don't see it, and it's removed from carts that still have it."
          checked={s.enabled}
          onChange={(e) => setS({ ...s, enabled: e.currentTarget.checked })}
        />
      </s-section>

      <s-section heading="Pricing">
        <s-stack direction="block" gap="base">
          <s-select
            label="How the fee is calculated"
            value={s.rules.mode}
            onChange={(e) =>
              setRules({ mode: e.currentTarget.value as FeeMode })
            }
          >
            <s-option value="FIXED">Fixed fee</s-option>
            <s-option value="PERCENT">Percentage of the cart</s-option>
            <s-option value="TIERED">Price tiers by cart value</s-option>
          </s-select>

          {s.rules.mode === "FIXED" &&
            field("Fee", s.rules.fixedFee, (n) => setRules({ fixedFee: n }))}

          {s.rules.mode === "PERCENT" &&
            field(
              "Percentage of the cart subtotal",
              s.rules.percent,
              (n) => setRules({ percent: n }),
              { suffix: "%" },
            )}

          {s.rules.mode === "TIERED" && (
            <s-stack direction="block" gap="small-200">
              <s-text color="subdued">
                Each tier applies from its cart value up to the next tier. Use a
                fixed fee or a percentage per tier.
              </s-text>
              {s.rules.tiers.map((t, i) => (
                <s-grid
                  key={i}
                  gridTemplateColumns="1fr 1fr 1fr auto"
                  gap="small-200"
                  alignItems="end"
                >
                  {field(`Tier ${i + 1}: from cart value`, t.from, (n) =>
                    setTier(i, { from: n }),
                  )}
                  <s-select
                    label="Fee type"
                    value={t.type}
                    onChange={(e) =>
                      setTier(i, {
                        type: e.currentTarget.value as Tier["type"],
                      })
                    }
                  >
                    <s-option value="FIXED">Fixed</s-option>
                    <s-option value="PERCENT">Percentage</s-option>
                  </s-select>
                  {field("Fee", t.value, (n) => setTier(i, { value: n }), {
                    suffix: t.type === "PERCENT" ? "%" : loaded.currency,
                  })}
                  <s-button
                    variant="tertiary"
                    tone="critical"
                    disabled={s.rules.tiers.length <= 1}
                    onClick={() =>
                      setRules({
                        tiers: s.rules.tiers.filter((_, j) => j !== i),
                      })
                    }
                  >
                    Remove
                  </s-button>
                </s-grid>
              ))}
              <s-button
                onClick={() => {
                  const last = s.rules.tiers.at(-1);
                  setRules({
                    tiers: [
                      ...s.rules.tiers,
                      {
                        from: (last?.from ?? 0) + 100 * scale,
                        type: "FIXED",
                        value: last?.value ?? 1,
                      },
                    ],
                  });
                }}
                disabled={s.rules.tiers.length >= 20}
              >
                Add tier
              </s-button>
            </s-stack>
          )}

          {usesPercent && (
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              {field(
                "Minimum fee",
                s.rules.minFee,
                (n) => setRules({ minFee: n }),
                {
                  details: "A percentage fee is never lower than this.",
                },
              )}
              {field(
                "Maximum fee",
                s.rules.maxFee,
                (n) => setRules({ maxFee: n }),
                {
                  details: "…and never higher than this.",
                },
              )}
            </s-grid>
          )}

          {field(
            "Only offer from a cart value of",
            s.rules.minSubtotal,
            (n) => setRules({ minSubtotal: n }),
            {
              details: "0 = always offer it.",
            },
          )}
        </s-stack>
      </s-section>

      {loaded.features.marketPrices ? (
        <MarketPricesSection
          value={s.marketPrices}
          onChange={(marketPrices) => setS({ ...s, marketPrices })}
        />
      ) : (
        <s-section heading="Prices by market (optional)">
          <UpgradeNotice feature="marketPrices">
            Charge a fixed fee in a market&apos;s own currency — for example
            €2.99 in Europe — instead of your pricing converted.
          </UpgradeNotice>
        </s-section>
      )}

      <s-section heading="Exact pricing (Shopify Plus)">
        <s-stack direction="block" gap="base">
          {loaded.plus && !loaded.features.exactPricing ? (
            <UpgradeNotice feature="exactPricing">
              Charge customers exactly the calculated percentage fee, and let
              them add or remove protection inside checkout. Both need a Shopify
              Plus store — yours is one.
            </UpgradeNotice>
          ) : loaded.plus ? (
            <>
              <ScopeGate
                scopes={["write_cart_transforms"]}
                what="adjust cart prices"
              >
                <s-checkbox
                  label="Charge the exact percentage fee"
                  details="Uses a cart transform so customers pay exactly the calculated fee instead of the nearest price point. Fixed fees and market prices are already exact."
                  checked={s.exactPricing}
                  onChange={(e) =>
                    setS({ ...s, exactPricing: e.currentTarget.checked })
                  }
                />
              </ScopeGate>
            </>
          ) : (
            <s-paragraph>
              On Shopify Plus, SafeShip can charge the exact percentage fee
              instead of the nearest of its price points (always within about
              1.5%). Shopify only allows this on Plus.
            </s-paragraph>
          )}
          <s-text type="strong">Checkout toggle</s-text>
          <s-paragraph>
            {loaded.plus
              ? "You can also let customers add or remove protection in checkout itself: in Shopify, open Settings → Checkout → Customize, click Add app block, choose “Shipping protection toggle” and save."
              : "On Shopify Plus, customers can also add or remove protection inside checkout with SafeShip's checkout block. On other plans they choose in the cart."}
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Which products are covered">
        <s-stack direction="block" gap="base">
          <s-select
            label="Protection covers"
            value={s.coverage.mode}
            onChange={(e) =>
              setS({
                ...s,
                coverage: {
                  ...s.coverage,
                  mode: e.currentTarget.value as CoverageMode,
                },
              })
            }
          >
            <s-option value="ALL">All products that ship</s-option>
            <s-option value="ONLY">
              Only products that match the rules below
            </s-option>
            <s-option value="EXCEPT">
              All products that ship, except those that match the rules below
            </s-option>
          </s-select>
          <s-text color="subdued">
            Products that don&apos;t need shipping (digital products, services)
            and gift cards are never covered. The fee is calculated on covered
            products only, and a cart with none isn&apos;t offered protection.
          </s-text>
          {s.coverage.mode !== "ALL" && (
            <s-stack direction="block" gap="base">
              <s-text>A product matches if it has any of these:</s-text>
              <s-text-field
                label="Product tags"
                details="Separated by commas, e.g. fragile, no-protection. Case doesn't matter."
                value={covTags}
                onInput={(e) => setCovTags(e.currentTarget.value)}
              />
              <s-text-field
                label="Product types"
                details="Separated by commas, as set on the product (Product organization → Type)."
                value={covTypes}
                onInput={(e) => setCovTypes(e.currentTarget.value)}
              />
              <s-text-field
                label="Vendors"
                details="Separated by commas."
                value={covVendors}
                onInput={(e) => setCovVendors(e.currentTarget.value)}
              />
              <s-stack direction="block" gap="small-200">
                <s-text>
                  Specific products ({s.coverage.productIds.length})
                </s-text>
                {s.coverage.productIds.length > 0 && (
                  <s-stack direction="inline" gap="small-200">
                    {s.coverage.productIds.map((id) => (
                      <s-clickable-chip
                        key={id}
                        removable
                        onRemove={() => removeProduct(id)}
                      >
                        {s.coverageProductTitles[String(id)] ?? `Product ${id}`}
                      </s-clickable-chip>
                    ))}
                  </s-stack>
                )}
                <s-stack direction="inline" gap="small-200">
                  <s-button onClick={pickProducts}>Choose products</s-button>
                </s-stack>
              </s-stack>
              <s-text color="subdued">
                Collections can&apos;t be used: the cart doesn&apos;t know which
                collections a product is in. Tag the products instead (bulk-edit
                in Products, or Shopify Flow).
              </s-text>
            </s-stack>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Preview">
        {errors.length > 0 ? (
          <s-banner tone="warning">
            <s-unordered-list>
              {errors.map((e) => (
                <s-list-item key={e}>{e}</s-list-item>
              ))}
            </s-unordered-list>
          </s-banner>
        ) : (
          <s-stack direction="block" gap="base">
            <s-table>
              <s-table-header-row>
                <s-table-header>Cart subtotal</s-table-header>
                <s-table-header>Customer pays for protection</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {samples.map((v) => {
                  const c = charged(v);
                  return (
                    <s-table-row key={v}>
                      <s-table-cell>{money(v)}</s-table-cell>
                      <s-table-cell>
                        {c ? money(c.price) : "Not offered"}
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>
            {field("Try a cart value", Number(tryValue), (n) =>
              setTryValue(Number.isFinite(n) ? String(n) : ""),
            )}
            {usesPercent && (
              <s-text color="subdued">
                Percentage fees are charged at the nearest of {ladder.length}{" "}
                price points (within about 1.5%). Shopify only lets Plus stores
                set a cart line&apos;s price directly, so the app keeps one
                variant per price point on the protection product.
              </s-text>
            )}
          </s-stack>
        )}
      </s-section>

      <s-section heading="Default choice">
        <s-stack direction="block" gap="base">
          <s-checkbox
            label="Add protection to the cart automatically (customers can remove it)"
            checked={s.defaultOn}
            onChange={(e) => setS({ ...s, defaultOn: e.currentTarget.checked })}
          />
          <s-text-field
            label="Always unticked for customers in these countries"
            value={countries}
            details="Two-letter country codes, separated by commas. Pre-selected by default: the EU, EEA, UK and Switzerland, where pre-ticked paid extras aren't allowed."
            onInput={(e) => setCountries(e.currentTarget.value)}
          />
          <s-stack direction="inline" gap="small-200">
            <s-button
              onClick={() => setCountries(OPT_IN_REQUIRED_COUNTRIES.join(", "))}
            >
              Reset to EU, EEA, UK and Switzerland
            </s-button>
          </s-stack>
          {missing.length > 0 && (
            <s-banner tone="warning" heading="Check with your legal adviser">
              Customers in {missing.join(", ")} would see protection already
              added. Consumer law there generally requires paid extras to be
              chosen actively.
            </s-banner>
          )}
          <s-text color="subdued">
            Customers whose country isn&apos;t known (some themes don&apos;t set
            it) follow the automatic setting above. Their choice is remembered
            on the cart and saved on the order.
          </s-text>
        </s-stack>
      </s-section>

      <s-section heading="Widget text">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Leave empty to use the built-in text, shown in the customer&apos;s
            language (English, German, French, Spanish, Italian, Dutch, Hindi).
            Text you enter here is shown in every language.
          </s-paragraph>
          <s-text-field
            label="Title"
            value={s.copy.title}
            placeholder="Shipping protection"
            onInput={(e) =>
              setS({ ...s, copy: { ...s.copy, title: e.currentTarget.value } })
            }
          />
          <s-text-field
            label="Description"
            value={s.copy.description}
            placeholder="Cover your order against loss, theft or damage in transit."
            onInput={(e) =>
              setS({
                ...s,
                copy: { ...s.copy, description: e.currentTarget.value },
              })
            }
          />
          <s-url-field
            label="“Learn more” link (optional)"
            value={s.copy.learnMoreUrl}
            details="Your page explaining what's covered and how to make a claim."
            onInput={(e) =>
              setS({
                ...s,
                copy: { ...s.copy, learnMoreUrl: e.currentTarget.value },
              })
            }
          />
        </s-stack>
      </s-section>

      <s-section heading="Tax">
        <s-checkbox
          label="Charge tax on the protection fee"
          details="Whether this fee is taxable depends on where you sell — check with your accountant."
          checked={s.taxable}
          onChange={(e) => setS({ ...s, taxable: e.currentTarget.checked })}
        />
      </s-section>

      <s-section heading="Claims">
        <s-stack direction="block" gap="base">
          <s-checkbox
            label="Let customers file claims on my store"
            details="Customers report a lost, stolen or damaged package; you review it under Claims."
            checked={s.claims.enabled}
            onChange={(e) => setClaims({ enabled: e.currentTarget.checked })}
          />
          {s.claims.enabled && (
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Claims page:{" "}
                <s-link href={loaded.portalUrl} target="_blank">
                  {loaded.portalUrl}
                </s-link>
                . Link to it from your footer menu, shipping policy and order
                emails.
              </s-paragraph>
              {(!loaded.emailReady || !loaded.uploadsReady) && (
                <s-banner
                  tone="warning"
                  heading="Not fully set up on the app's side"
                >
                  {!loaded.emailReady &&
                    "Claim emails aren't being sent yet (no email service configured). "}
                  {!loaded.uploadsReady &&
                    "Customers can't upload photos yet (no file storage configured)."}
                </s-banner>
              )}
              <s-grid
                gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))"
                gap="base"
              >
                <s-number-field
                  label="Claim window (days)"
                  value={String(s.claims.windowDays)}
                  min={1}
                  max={365}
                  step={1}
                  onInput={(e) =>
                    setClaims({
                      windowDays: Number(e.currentTarget.value) || 0,
                    })
                  }
                />
                {loaded.features.claimRules && (
                  <s-select
                    label="Window starts"
                    value={s.claims.windowFrom}
                    onChange={(e) =>
                      setClaims({
                        windowFrom: e.currentTarget
                          .value as ClaimSettings["windowFrom"],
                      })
                    }
                  >
                    <s-option value="SHIPPED">When the order ships</s-option>
                    <s-option value="DELIVERED">
                      When it&apos;s delivered (or ships, if never delivered)
                    </s-option>
                  </s-select>
                )}
                <s-number-field
                  label="Report lost after (days in transit)"
                  details="0 = any time. Stops “lost” claims for packages that are just slow."
                  value={String(s.claims.lostAfterDays)}
                  min={0}
                  max={90}
                  step={1}
                  onInput={(e) =>
                    setClaims({
                      lostAfterDays: Number(e.currentTarget.value) || 0,
                    })
                  }
                />
                <s-number-field
                  label="Claims per order"
                  details="Rejected claims don't count."
                  value={String(s.claims.maxPerOrder)}
                  min={1}
                  max={10}
                  step={1}
                  onInput={(e) =>
                    setClaims({
                      maxPerOrder: Number(e.currentTarget.value) || 1,
                    })
                  }
                />
              </s-grid>
              <s-checkbox
                label="Only orders that bought shipping protection can be claimed"
                checked={s.claims.requireProtection}
                onChange={(e) =>
                  setClaims({ requireProtection: e.currentTarget.checked })
                }
              />
              <s-checkbox
                label="Require a photo for damage claims"
                checked={s.claims.photosForDamage}
                onChange={(e) =>
                  setClaims({ photosForDamage: e.currentTarget.checked })
                }
              />
              {loaded.features.claimRules && (
                <s-checkbox
                  label="Require a supporting document for lost and stolen claims"
                  details="For example a police report or the carrier's reply. Customers can upload photos or PDFs."
                  checked={s.claims.evidenceForLostStolen}
                  onChange={(e) =>
                    setClaims({
                      evidenceForLostStolen: e.currentTarget.checked,
                    })
                  }
                />
              )}
              {loaded.features.claimRules ? (
                <>
                  <s-heading>Limits and review flags</s-heading>
                  <s-text color="subdued">
                    Limits stop a claim being filed online (the customer is
                    asked to contact you; you can still create it under Claims).
                    Flags never block anything — they mark claims to look at
                    more closely.
                  </s-text>
                  <s-grid
                    gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))"
                    gap="base"
                  >
                    {field(
                      "Most that can be claimed per order",
                      s.claims.maxValuePerOrder,
                      (n) =>
                        setClaims({
                          maxValuePerOrder: Number.isFinite(n) ? n : 0,
                        }),
                      {
                        details:
                          "All claims on the order together. 0 = no limit.",
                      },
                    )}
                    {field(
                      "Most one customer can claim in 12 months",
                      s.claims.maxValuePerCustomer,
                      (n) =>
                        setClaims({
                          maxValuePerCustomer: Number.isFinite(n) ? n : 0,
                        }),
                      {
                        details: "By email. 0 = no limit.",
                      },
                    )}
                    {field(
                      "Flag claims worth at least",
                      s.claims.highValue,
                      (n) =>
                        setClaims({ highValue: Number.isFinite(n) ? n : 0 }),
                      {
                        details: "0 = off.",
                      },
                    )}
                    <s-number-field
                      label="Flag repeat claims from"
                      details="Claims in 12 months from the same customer or shipping address, this one included."
                      value={String(s.claims.repeatThreshold)}
                      min={2}
                      max={20}
                      step={1}
                      suffix="claims"
                      onInput={(e) =>
                        setClaims({
                          repeatThreshold: Number(e.currentTarget.value) || 2,
                        })
                      }
                    />
                  </s-grid>
                </>
              ) : (
                <UpgradeNotice feature="claimRules">
                  Set limits per order and per customer, require documents for
                  lost or stolen packages, start the claim window at delivery,
                  and flag repeat or high-value claims for a closer look.
                </UpgradeNotice>
              )}
              <s-email-field
                label="Send new-claim emails to"
                placeholder="Your store's email"
                value={s.claims.notifyEmail}
                onInput={(e) =>
                  setClaims({ notifyEmail: e.currentTarget.value })
                }
              />
              <s-text-area
                label="Policy shown on the claims page (optional)"
                details="Plain text: what's covered, what isn't, and how long decisions take. Shown above the form."
                rows={4}
                value={s.claims.policy}
                onInput={(e) => setClaims({ policy: e.currentTarget.value })}
              />
            </s-stack>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Tracking" id="tracking">
        {!loaded.features.tracking ? (
          <UpgradeNotice feature="tracking">
            Follow every protected package and get flags for packages that
            weren&apos;t picked up, stalled, are late or may be lost.
          </UpgradeNotice>
        ) : (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Packages of protected orders are followed on the{" "}
              <s-link href="/app/shipments">Shipments</s-link> page. These rules
              decide when one is flagged for you to check. Set any of them to 0
              to turn it off.
            </s-paragraph>
            <s-grid
              gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))"
              gap="base"
            >
              {days(
                "Not picked up after",
                s.tracking.noScanDays,
                60,
                (n) => setTracking({ noScanDays: n }),
                "Fulfilled, but no carrier scan yet.",
              )}
              {days(
                "Stalled after",
                s.tracking.staleDays,
                60,
                (n) => setTracking({ staleDays: n }),
                "In transit with no carrier update.",
              )}
              {days(
                "Late after",
                s.tracking.lateDays,
                60,
                (n) => setTracking({ lateDays: n }),
                "Days past the carrier's estimated delivery.",
              )}
              {days(
                "Possibly lost after",
                s.tracking.lostDays,
                180,
                (n) => setTracking({ lostDays: n }),
                "Days since shipping without delivery.",
              )}
            </s-grid>
          </s-stack>
        )}
      </s-section>

      {loaded.configured && (
        <s-section heading="Remove from store">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Deletes the Shipping protection product and the checkout rule from
              your store. Do this before uninstalling the app — afterwards the
              app can&apos;t remove them for you. Your settings here are
              cleared; past orders keep their protection details.
            </s-paragraph>
            <s-stack direction="inline" gap="small-200">
              {confirmRemove ? (
                <>
                  <s-button
                    tone="critical"
                    variant="primary"
                    {...(busy ? { loading: true } : {})}
                    onClick={() => {
                      fetcher.submit({ intent: "remove" } as never, {
                        method: "POST",
                        encType: "application/json",
                      });
                      setConfirmRemove(false);
                    }}
                  >
                    Yes, remove it
                  </s-button>
                  <s-button onClick={() => setConfirmRemove(false)}>
                    Cancel
                  </s-button>
                </>
              ) : (
                <s-button
                  tone="critical"
                  onClick={() => setConfirmRemove(true)}
                >
                  Remove from store
                </s-button>
              )}
            </s-stack>
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

/** Children only once the optional scopes are granted; otherwise an Allow button. */
function ScopeGate({
  scopes,
  what,
  children,
}: {
  scopes: string[];
  what: string;
  children: React.ReactNode;
}) {
  const shopify = useAppBridge();
  const [granted, setGranted] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    shopify.scopes
      .query()
      .then((d) => live && setGranted(d.granted))
      .catch(() => live && setGranted([]));
    return () => {
      live = false;
    };
  }, [shopify]);
  if (granted === null) return null;
  const missing = scopes.filter((x) => !granted.includes(x));
  if (!missing.length) return <>{children}</>;
  return (
    <s-banner tone="info" heading="Permission needed">
      SafeShip needs your permission to {what}.{" "}
      <s-button
        onClick={() =>
          shopify.scopes
            .request(missing)
            .then(() => shopify.scopes.query())
            .then((d) => setGranted(d.granted))
            .catch(() => {})
        }
      >
        Allow
      </s-button>
    </s-banner>
  );
}

/** Fixed fees per Shopify market, in each market's currency. */
function MarketPricesSection({
  value,
  onChange,
}: {
  value: Settings["marketPrices"];
  onChange: (v: Settings["marketPrices"]) => void;
}) {
  const fetcher = useFetcher<ActionResult>();
  const markets = fetcher.data?.ok ? (fetcher.data.markets ?? null) : null;
  const error =
    fetcher.data && !fetcher.data.ok ? fetcher.data.errors[0] : null;
  const load = () =>
    fetcher.submit({ intent: "markets" } as never, {
      method: "POST",
      encType: "application/json",
    });
  const set = (
    marketId: number,
    patch: Partial<Settings["marketPrices"][number]>,
  ) =>
    onChange(
      value.map((m) => (m.marketId === marketId ? { ...m, ...patch } : m)),
    );
  const unused = (markets ?? []).filter(
    (m) => !value.some((v) => v.marketId === m.id),
  );

  return (
    <s-section heading="Prices by market (optional)">
      <s-stack direction="block" gap="base">
        <s-paragraph>
          Charge a fixed fee in a market&apos;s own currency — for example €2.99
          in Europe — instead of your pricing above converted. The fee is set in
          that market&apos;s price list in Shopify Markets.
        </s-paragraph>
        {value.map((m) => (
          <s-grid
            key={m.marketId}
            gridTemplateColumns="2fr 1fr auto"
            gap="small-200"
            alignItems="end"
          >
            <s-text>
              {m.name || `Market ${m.marketId}`}
              {markets && !markets.some((x) => x.id === m.marketId)
                ? " (not found — remove it)"
                : ""}
            </s-text>
            <s-number-field
              label="Fee"
              min={0}
              step={0.01}
              suffix={m.currency}
              value={Number.isFinite(m.amount) ? String(m.amount) : ""}
              onInput={(e) =>
                set(m.marketId, { amount: Number(e.currentTarget.value) })
              }
            />
            <s-button
              variant="tertiary"
              tone="critical"
              onClick={() =>
                onChange(value.filter((x) => x.marketId !== m.marketId))
              }
            >
              Remove
            </s-button>
          </s-grid>
        ))}
        <ScopeGate scopes={["read_markets"]} what="read your markets">
          {markets === null ? (
            <s-stack direction="inline" gap="small-200">
              <s-button
                onClick={load}
                {...(fetcher.state !== "idle" ? { loading: true } : {})}
              >
                {value.length ? "Add another market" : "Choose markets"}
              </s-button>
            </s-stack>
          ) : unused.length === 0 ? (
            <s-text color="subdued">
              All your active markets have a price.
            </s-text>
          ) : (
            <s-stack direction="inline" gap="small-200">
              {unused.slice(0, MAX_MARKET_PRICES - value.length).map((m) => (
                <s-button
                  key={m.id}
                  onClick={() =>
                    onChange([
                      ...value,
                      {
                        marketId: m.id,
                        name: m.name,
                        currency: m.currency,
                        amount: NaN,
                      },
                    ])
                  }
                >
                  + {m.name} ({m.currency})
                </s-button>
              ))}
            </s-stack>
          )}
        </ScopeGate>
        {error && <s-banner tone="critical">{error}</s-banner>}
        <s-text color="subdued">
          Customers in a market with a price here pay exactly that, whatever the
          cart value — protection is still only offered from your minimum cart
          value. Save to apply.
        </s-text>
      </s-stack>
    </s-section>
  );
}

/** "How to set up SafeShip": open until the first save, then folded away. */
function SetupGuide({
  steps,
}: {
  steps: { done: boolean; title: string; body: React.ReactNode }[];
}) {
  const left = steps.filter((x) => !x.done).length;
  const allSet = steps.slice(0, 3).every((x) => x.done);
  return (
    <s-section>
      <details open={!allSet}>
        <summary style={{ cursor: "pointer", padding: "4px 0" }}>
          <s-text type="strong">How to set up SafeShip</s-text>{" "}
          <s-text color="subdued">
            {allSet
              ? "— you're live"
              : `— ${left} step${left === 1 ? "" : "s"} to go`}
          </s-text>
        </summary>
        <s-stack direction="block" gap="base">
          <s-ordered-list>
            {steps.map((x) => (
              <s-list-item key={x.title}>
                <s-stack direction="block" gap="small-100">
                  <s-stack
                    direction="inline"
                    gap="small-200"
                    alignItems="center"
                  >
                    <s-text type="strong">{x.title}</s-text>
                    {x.done && <s-badge tone="success">Done</s-badge>}
                  </s-stack>
                  <s-text color="subdued">{x.body}</s-text>
                </s-stack>
              </s-list-item>
            ))}
          </s-ordered-list>
          <s-text color="subdued">
            Good to know: everything you save here is pushed into Shopify, so
            protection keeps working at checkout even if this app is ever
            unavailable. Settings are explained next to each field.
          </s-text>
        </s-stack>
      </details>
    </s-section>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
