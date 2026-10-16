import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  return {
    settings: shop.settings ? parseSettings(shop.settings) : DEFAULT_SETTINGS,
    configured: shop.settings !== null && shop.productId !== null,
    currency: shop.currency,
    decimals: currencyDecimals(shop.currency),
  };
};

type ActionResult = { ok: true; intent: string; problems?: string[] } | { ok: false; errors: string[] };

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionResult> => {
  const { session, admin } = await authenticate.admin(request);
  await ensureShop(session.shop);
  const body = (await request.json()) as { intent?: string; settings?: unknown };

  if (body.intent === "remove") {
    const problems = await removeFromStore(admin, session.shop);
    await prisma.shop.update({ where: { shop: session.shop }, data: { settings: Prisma.DbNull } });
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
    await syncProtection(admin, session.shop);
  } catch (err) {
    return {
      ok: false,
      errors: [`Saved, but your store couldn't be updated: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  return { ok: true, intent: "save" };
};

/** Sample cart values sized to the currency (¥10 isn't a cart). */
const SCALE: Record<string, number> = {
  JPY: 100, KRW: 1000, INR: 50, HUF: 300, IDR: 10000, VND: 20000, CLP: 800, COP: 3000, ISK: 100,
  PHP: 50, THB: 30, TWD: 30, CZK: 20, RUB: 80, MXN: 15, ZAR: 15, TRY: 30, PKR: 250, NGN: 1000,
};
const SAMPLES = [10, 25, 50, 100, 250, 500, 1000];

export default function SettingsPage() {
  const loaded = useLoaderData<typeof loader>();
  const [s, setS] = useState<Settings>(loaded.settings);
  const [countries, setCountries] = useState(loaded.settings.optInCountries.join(", "));
  const [tryValue, setTryValue] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const fetcher = useFetcher<ActionResult>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    const d = fetcher.data;
    if (!d) return;
    if (d.ok && d.intent === "save") shopify.toast.show("Saved — your store is updated");
    if (d.ok && d.intent === "remove") shopify.toast.show("Removed from your store");
  }, [fetcher.data, shopify]);

  const setRules = (patch: Partial<PricingRules>) => setS({ ...s, rules: { ...s.rules, ...patch } });
  const setTier = (i: number, patch: Partial<Tier>) =>
    setRules({ tiers: s.rules.tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)) });

  const parsedCountries = countries
    .split(/[\s,]+/)
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  const current: Settings = { ...s, optInCountries: parsedCountries };
  const errors = settingsErrors(current);
  const missing = missingOptInCountries(current);
  const dirty = JSON.stringify(current) !== JSON.stringify(loaded.settings) || !loaded.configured;

  const money = (n: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency: loaded.currency }).format(n);
  const hasErrors = errors.length > 0;
  const ladder = useMemo(
    () => (hasErrors ? [] : buildLadder(s.rules, loaded.decimals)),
    [s.rules, loaded.decimals, hasErrors],
  );
  const charged = (subtotal: number) => {
    const fee = computeFee(s.rules, subtotal);
    if (fee === null || !ladder.length) return null;
    return { fee, price: fromMinor(ladder[snapIndex(ladder, toMinor(fee, loaded.decimals))], loaded.decimals) };
  };
  const scale = SCALE[loaded.currency] ?? 1;
  const samples = [...SAMPLES.map((n) => n * scale), ...(Number(tryValue) > 0 ? [Number(tryValue)] : [])];
  const usesPercent =
    s.rules.mode === "PERCENT" || (s.rules.mode === "TIERED" && s.rules.tiers.some((t) => t.type === "PERCENT"));

  const num = (v: string) => (v.trim() === "" ? NaN : Number(v));
  const field = (label: string, value: number, onChange: (n: number) => void, opts: { suffix?: string; details?: string } = {}) => (
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

  const save = () =>
    fetcher.submit({ intent: "save", settings: current } as never, { method: "POST", encType: "application/json" });

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

      {fetcher.data && !fetcher.data.ok && (
        <s-banner tone="critical" heading="Not saved">
          <s-unordered-list>
            {fetcher.data.errors.map((e) => (
              <s-list-item key={e}>{e}</s-list-item>
            ))}
          </s-unordered-list>
        </s-banner>
      )}
      {!loaded.configured && (
        <s-banner tone="info" heading="Nothing is live yet">
          Saving this page creates the hidden &ldquo;Shipping protection&rdquo; product and the checkout rule in
          your store. Customers see the toggle once you also turn on the app embed (see Home).
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
            onChange={(e) => setRules({ mode: e.currentTarget.value as FeeMode })}
          >
            <s-option value="FIXED">Fixed fee</s-option>
            <s-option value="PERCENT">Percentage of the cart</s-option>
            <s-option value="TIERED">Price tiers by cart value</s-option>
          </s-select>

          {s.rules.mode === "FIXED" && field("Fee", s.rules.fixedFee, (n) => setRules({ fixedFee: n }))}

          {s.rules.mode === "PERCENT" &&
            field("Percentage of the cart subtotal", s.rules.percent, (n) => setRules({ percent: n }), { suffix: "%" })}

          {s.rules.mode === "TIERED" && (
            <s-stack direction="block" gap="small-200">
              <s-text color="subdued">
                Each tier applies from its cart value up to the next tier. Use a fixed fee or a percentage per tier.
              </s-text>
              {s.rules.tiers.map((t, i) => (
                <s-grid key={i} gridTemplateColumns="1fr 1fr 1fr auto" gap="small-200" alignItems="end">
                  {field(`Tier ${i + 1}: from cart value`, t.from, (n) => setTier(i, { from: n }))}
                  <s-select
                    label="Fee type"
                    value={t.type}
                    onChange={(e) => setTier(i, { type: e.currentTarget.value as Tier["type"] })}
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
                    onClick={() => setRules({ tiers: s.rules.tiers.filter((_, j) => j !== i) })}
                  >
                    Remove
                  </s-button>
                </s-grid>
              ))}
              <s-button
                onClick={() => {
                  const last = s.rules.tiers.at(-1);
                  setRules({
                    tiers: [...s.rules.tiers, { from: (last?.from ?? 0) + 100 * scale, type: "FIXED", value: last?.value ?? 1 }],
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
              {field("Minimum fee", s.rules.minFee, (n) => setRules({ minFee: n }), {
                details: "A percentage fee is never lower than this.",
              })}
              {field("Maximum fee", s.rules.maxFee, (n) => setRules({ maxFee: n }), {
                details: "…and never higher than this.",
              })}
            </s-grid>
          )}

          {field("Only offer from a cart value of", s.rules.minSubtotal, (n) => setRules({ minSubtotal: n }), {
            details: "0 = always offer it.",
          })}
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
                      <s-table-cell>{c ? money(c.price) : "Not offered"}</s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>
            {field("Try a cart value", Number(tryValue), (n) => setTryValue(Number.isFinite(n) ? String(n) : ""))}
            {usesPercent && (
              <s-text color="subdued">
                Percentage fees are charged at the nearest of {ladder.length} price points (within about 1.5%).
                Shopify only lets Plus stores set a cart line&apos;s price directly, so the app keeps one variant per
                price point on the protection product.
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
            <s-button onClick={() => setCountries(OPT_IN_REQUIRED_COUNTRIES.join(", "))}>
              Reset to EU, EEA, UK and Switzerland
            </s-button>
          </s-stack>
          {missing.length > 0 && (
            <s-banner tone="warning" heading="Check with your legal adviser">
              Customers in {missing.join(", ")} would see protection already added. Consumer law there generally
              requires paid extras to be chosen actively.
            </s-banner>
          )}
          <s-text color="subdued">
            Customers whose country isn&apos;t known (some themes don&apos;t set it) follow the automatic setting above.
            Their choice is remembered on the cart and saved on the order.
          </s-text>
        </s-stack>
      </s-section>

      <s-section heading="Widget text">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Leave empty to use the built-in text, shown in the customer&apos;s language (English, German, French,
            Spanish, Italian, Dutch, Hindi). Text you enter here is shown in every language.
          </s-paragraph>
          <s-text-field
            label="Title"
            value={s.copy.title}
            placeholder="Shipping protection"
            onInput={(e) => setS({ ...s, copy: { ...s.copy, title: e.currentTarget.value } })}
          />
          <s-text-field
            label="Description"
            value={s.copy.description}
            placeholder="Cover your order against loss, theft or damage in transit."
            onInput={(e) => setS({ ...s, copy: { ...s.copy, description: e.currentTarget.value } })}
          />
          <s-url-field
            label="“Learn more” link (optional)"
            value={s.copy.learnMoreUrl}
            details="Your page explaining what's covered and how to make a claim."
            onInput={(e) => setS({ ...s, copy: { ...s.copy, learnMoreUrl: e.currentTarget.value } })}
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

      {loaded.configured && (
        <s-section heading="Remove from store">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Deletes the Shipping protection product and the checkout rule from your store. Do this before
              uninstalling the app — afterwards the app can&apos;t remove them for you. Your settings here are
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
                      fetcher.submit({ intent: "remove" } as never, { method: "POST", encType: "application/json" });
                      setConfirmRemove(false);
                    }}
                  >
                    Yes, remove it
                  </s-button>
                  <s-button onClick={() => setConfirmRemove(false)}>Cancel</s-button>
                </>
              ) : (
                <s-button tone="critical" onClick={() => setConfirmRemove(true)}>
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

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
