// The merchant's settings as stored in Shop.settings. Shared by the
// settings page (client) and the server; no server-only imports here.
import {
  DEFAULT_RULES,
  OPT_IN_REQUIRED_COUNTRIES,
  rulesErrors,
  type FeeMode,
  type PricingRules,
  type Tier,
} from "../../shared/pricing";

export interface Settings {
  enabled: boolean;
  rules: PricingRules;
  defaultOn: boolean;
  optInCountries: string[];
  /** Empty = the widget's translated default text. */
  copy: { title: string; description: string; learnMoreUrl: string };
  /** Charge tax on the protection fee (sets the variants' taxable flag). */
  taxable: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  rules: DEFAULT_RULES,
  // Pre-ticked outside the opt-in countries — the most common setup. The
  // EU/EEA/UK/CH list keeps it unticked where the law requires that.
  defaultOn: true,
  optInCountries: OPT_IN_REQUIRED_COUNTRIES,
  copy: { title: "", description: "", learnMoreUrl: "" },
  taxable: false,
};

const num = (v: unknown, fallback: number) => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const MODES: FeeMode[] = ["FIXED", "PERCENT", "TIERED"];

/** Whitelists and coerces untrusted input (a request body or stored JSON). */
export function parseSettings(raw: unknown): Settings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const r = (o.rules && typeof o.rules === "object" ? o.rules : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS.rules;
  const tiers: Tier[] = Array.isArray(r.tiers)
    ? r.tiers.slice(0, 20).map((t: Record<string, unknown>) => ({
        from: num(t?.from, 0),
        type: t?.type === "PERCENT" ? "PERCENT" : "FIXED",
        value: num(t?.value, 0),
      }))
    : d.tiers;
  const copy = (o.copy && typeof o.copy === "object" ? o.copy : {}) as Record<string, unknown>;
  const learnMoreUrl = str(copy.learnMoreUrl, 500);
  return {
    enabled: o.enabled === undefined ? DEFAULT_SETTINGS.enabled : o.enabled === true,
    rules: {
      mode: MODES.includes(r.mode as FeeMode) ? (r.mode as FeeMode) : d.mode,
      fixedFee: num(r.fixedFee, d.fixedFee),
      percent: num(r.percent, d.percent),
      tiers,
      minFee: num(r.minFee, d.minFee),
      maxFee: num(r.maxFee, d.maxFee),
      minSubtotal: num(r.minSubtotal, d.minSubtotal),
    },
    defaultOn: o.defaultOn === undefined ? DEFAULT_SETTINGS.defaultOn : o.defaultOn === true,
    optInCountries: Array.isArray(o.optInCountries)
      ? [...new Set(o.optInCountries.map((c) => String(c).trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)))]
      : DEFAULT_SETTINGS.optInCountries,
    copy: {
      title: str(copy.title, 80),
      description: str(copy.description, 300),
      // Only http(s) — this lands in an href on the storefront.
      learnMoreUrl: /^https?:\/\//i.test(learnMoreUrl) ? learnMoreUrl : "",
    },
    taxable: o.taxable === true,
  };
}

export const settingsErrors = (s: Settings): string[] => rulesErrors(s.rules);

/** Opt-in-required countries the merchant removed while pre-ticking. */
export function missingOptInCountries(s: Settings): string[] {
  if (!s.defaultOn) return [];
  return OPT_IN_REQUIRED_COUNTRIES.filter((c) => !s.optInCountries.includes(c));
}

/** Decimals of a currency (JPY 0, EUR 2, BHD 3). */
export function currencyDecimals(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}
