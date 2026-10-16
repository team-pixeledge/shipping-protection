// Storefront widget: the shipping-protection toggle in the cart drawer and
// on the cart page. Built by scripts/build-widget.mjs into
// extensions/protection-widget/assets/protection.js — never edit that file.
//
// How it stays right without a page reload:
//   1. It watches every cart request the theme (or another app) makes —
//      fetch and XHR to /cart/add|change|update|clear — and after each one
//      re-checks the cart ("reconcile").
//   2. Reconcile decides whether protection should be in the cart and which
//      price variant it should be (shared/pricing.ts), then fixes the cart
//      in ONE /cart/update.js request: the wrong variant / duplicates go to
//      0, the right variant to 1.
//   3. It then asks the theme to redraw its cart (refreshTheme) and redraws
//      its own widget.
//
// The shopper's choice lives in a cart attribute (_shipping_protection =
// accepted | declined), so it survives page loads and devices and reaches
// the order. Removing the protection line with the theme's own remove
// button counts as declining — otherwise default-on would re-add it forever.
//
// The checkout validation function enforces the same rules server-side;
// everything here is convenience, not security.
import {
  lineCovered,
  matchesTags,
  quote,
  startsOn,
  usesTags,
  type CartLine,
  type ProtectionConfig,
  type Quote,
} from "../shared/pricing";

interface Env {
  country: string;
  /** Presentment (cart) currency. */
  currency: string;
  locale: string;
  itemCount: number;
  placement: "auto" | "blocks";
  hideLine: boolean;
  refresh: "auto" | "events" | "reload";
  refreshEvent: string;
  t: { title: string; description: string; learnMore: string; added: string };
}

interface CartItem {
  key: string;
  product_id: number;
  variant_id: number;
  quantity: number;
  final_price: number;
  final_line_price: number;
  handle: string;
  requires_shipping: boolean;
  gift_card: boolean;
  product_type: string | null;
  vendor: string | null;
}

interface Cart {
  token: string;
  item_count: number;
  items: CartItem[];
  attributes: Record<string, string> | null;
}

type Choice = "accepted" | "declined" | undefined;

const ATTR = "_shipping_protection";
const OWN_HEADER = "X-Shipping-Protection";
const CART_CHANGE = /\/cart\/(add|change|update|clear)(\.js)?(\?|$)/;

declare global {
  interface Window {
    Shopify?: { routes?: { root?: string }; currency?: { active?: string; rate?: string } };
    __shippingProtection?: boolean;
  }
}

function readJson<T>(id: string): T | null {
  const el = document.getElementById(id);
  if (!el?.textContent) return null;
  try {
    return JSON.parse(el.textContent) as T;
  } catch {
    return null;
  }
}

function boot() {
  if (window.__shippingProtection) return;
  // The app embed's copy wins; a cart block's copy is only used when the
  // embed is off, and then the toggle goes only where blocks were placed.
  const cfg = readJson<ProtectionConfig>("sp-config") ?? readJson<ProtectionConfig>("sp-config-block");
  const embedEnv = readJson<Env>("sp-env");
  const blockEnv = readJson<Env>("sp-env-block");
  const env = embedEnv ?? (blockEnv && { ...blockEnv, placement: "blocks" as const });
  if (!cfg || !env) return;
  // Switched off: only clean up carts that still hold protection.
  if (!cfg.enabled && env.itemCount === 0) return;
  window.__shippingProtection = true;
  new Widget(cfg, env).start();
}

class Widget {
  private cart: Cart | null = null;
  private quote: Quote | null = null;
  private busy = false;
  private queued = false;
  private timer: number | undefined;
  private readonly root = (window.Shopify?.routes?.root || "/").replace(/\/?$/, "/");
  private readonly rate = Number(window.Shopify?.currency?.rate) || 1;
  private readonly money: Intl.NumberFormat;

  constructor(
    private cfg: ProtectionConfig,
    private env: Env,
  ) {
    let fmt: Intl.NumberFormat;
    try {
      fmt = new Intl.NumberFormat(env.locale, { style: "currency", currency: env.currency });
    } catch {
      fmt = new Intl.NumberFormat(undefined, { style: "currency", currency: cfg.currency });
    }
    this.money = fmt;
  }

  start() {
    this.interceptFetch();
    this.interceptXhr();
    new MutationObserver(() => this.schedule("dom", 120)).observe(document.body, {
      childList: true,
      subtree: true,
    });
    // Empty cart on load: nothing to check until the theme adds something
    // (the interceptors catch that). Saves a /cart.js on most page views.
    if (this.env.itemCount > 0) this.reconcile();
    else this.paint();
  }

  // ---- Watching the theme's cart requests ----

  private interceptFetch() {
    const original = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await original(input, init);
      try {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        if (CART_CHANGE.test(url) && !headers.has(OWN_HEADER)) this.schedule("cart", 60);
      } catch {
        /* never break the theme's request */
      }
      return res;
    };
  }

  private interceptXhr() {
    const open = XMLHttpRequest.prototype.open;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const widget = this;
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL) {
      if (CART_CHANGE.test(String(url))) {
        this.addEventListener("load", () => widget.schedule("cart", 60));
      }
      // eslint-disable-next-line prefer-rest-params
      return open.apply(this, arguments as unknown as Parameters<typeof open>);
    } as typeof open;
  }

  /** "dom": a drawer re-rendered — just re-mount. "cart": re-check the cart. */
  schedule(kind: "dom" | "cart", ms: number) {
    if (kind === "dom") {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.paint(), ms);
      return;
    }
    window.setTimeout(() => this.reconcile(), ms);
  }

  // ---- Cart API ----

  private async getCart(): Promise<Cart> {
    const res = await fetch(`${this.root}cart.js`, {
      headers: { [OWN_HEADER]: "1", Accept: "application/json" },
    });
    return res.json();
  }

  private async update(body: { updates?: Record<string, number>; attributes?: Record<string, string> }): Promise<Cart> {
    const res = await fetch(`${this.root}cart/update.js`, {
      method: "POST",
      headers: { [OWN_HEADER]: "1", "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`cart update ${res.status}`);
    return res.json();
  }

  // ---- Coverage ----

  /**
   * Tags per product. /cart.js doesn't include tags, so when coverage uses
   * them each product's /products/<handle>.js is read once per tab session.
   */
  private async productTags(items: CartItem[]): Promise<Map<number, string[]>> {
    const out = new Map<number, string[]>();
    if (!usesTags(this.cfg.coverage)) return out;
    const key = (id: number) => `sp-tags:${id}`;
    await Promise.all(
      [...new Map(items.map((i) => [i.product_id, i])).values()].map(async (item) => {
        try {
          const cached = sessionStorage.getItem(key(item.product_id));
          if (cached) {
            out.set(item.product_id, JSON.parse(cached));
            return;
          }
        } catch {
          /* private mode */
        }
        try {
          const res = await fetch(`${this.root}products/${encodeURIComponent(item.handle)}.js`, {
            headers: { Accept: "application/json" },
          });
          const tags: string[] = res.ok ? ((await res.json()).tags ?? []) : [];
          out.set(item.product_id, tags);
          try {
            sessionStorage.setItem(key(item.product_id), JSON.stringify(tags));
          } catch {
            /* private mode */
          }
        } catch {
          out.set(item.product_id, []);
        }
      }),
    );
    return out;
  }

  /** The cart lines protection covers (and charges for). */
  private async coveredItems(items: CartItem[]) {
    const tags = await this.productTags(items);
    const cov = this.cfg.coverage;
    return items.filter((i) => {
      const line: CartLine = {
        variantId: i.variant_id,
        productId: i.product_id,
        quantity: i.quantity,
        subtotal: i.final_line_price / 100,
        requiresShipping: i.requires_shipping,
        giftCard: i.gift_card,
        productType: i.product_type,
        vendor: i.vendor,
        tagMatch: cov ? matchesTags(cov, tags.get(i.product_id) ?? []) : false,
      };
      return lineCovered(cov, line);
    });
  }

  // ---- The decision ----

  private seenKey(token: string) {
    return `sp-seen:${token}`;
  }

  /**
   * Was protection in this cart the last time we looked (this tab), with a
   * variant that still exists? A merchant's pricing change deletes variants
   * and Shopify drops those lines from carts — that isn't the shopper
   * declining.
   */
  private wasPresent(token: string) {
    try {
      const seen = Number(sessionStorage.getItem(this.seenKey(token)));
      return seen > 0 && this.cfg.ladder.some(([, id]) => id === seen);
    } catch {
      return false;
    }
  }

  private remember(token: string, variantId: number | undefined) {
    try {
      sessionStorage.setItem(this.seenKey(token), String(variantId ?? 0));
    } catch {
      /* private mode */
    }
  }

  async reconcile(override?: Choice) {
    if (this.busy) {
      this.queued = true;
      return;
    }
    this.busy = true;
    this.paint();
    try {
      let cart = await this.getCart();
      const prot = cart.items.filter((i) => i.product_id === this.cfg.productId);
      const others = cart.items.filter((i) => i.product_id !== this.cfg.productId);
      const present = prot.length > 0;

      let choice = (override ?? cart.attributes?.[ATTR]) as Choice;
      const attributes: Record<string, string> = {};
      if (override) attributes[ATTR] = override;
      else if (!present && choice !== "declined" && this.wasPresent(cart.token)) {
        // Gone, and not by us: the shopper used the theme's remove button.
        choice = "declined";
        attributes[ATTR] = "declined";
      }

      // The fee is on covered products only; with none (only digital items,
      // or nothing matching the merchant's rules) protection isn't offered.
      const covered = await this.coveredItems(others);
      const subtotal = covered.reduce((s, i) => s + i.final_line_price, 0) / 100 / this.rate;
      const q = covered.length ? quote(this.cfg, subtotal) : null;
      const want =
        q !== null &&
        (choice === "accepted" ||
          (choice !== "declined" && (present || startsOn(this.cfg, this.env.country))));

      const updates: Record<string, number> = {};
      if (want && q) {
        const keep = prot.find((i) => i.variant_id === q.variantId);
        for (const line of prot) if (line !== keep) updates[line.key] = 0;
        if (!keep) updates[String(q.variantId)] = 1;
        else if (keep.quantity !== 1) updates[keep.key] = 1;
      } else {
        for (const line of prot) updates[line.key] = 0;
      }

      if (Object.keys(updates).length || Object.keys(attributes).length) {
        cart = await this.update({ updates, attributes });
        this.refreshTheme(cart);
      }
      this.cart = cart;
      this.quote = q;
      this.remember(cart.token, cart.items.find((i) => i.product_id === this.cfg.productId)?.variant_id);
    } catch (err) {
      console.warn("[shipping-protection]", err);
    } finally {
      this.busy = false;
      this.paint();
      if (this.queued) {
        this.queued = false;
        this.reconcile();
      }
    }
  }

  // ---- Asking the theme to redraw its cart ----

  private refreshTheme(cart: Cart) {
    const d = document;
    let handled = false;
    // Dawn and its family (Refresh, Sense, Craft, Studio, Taste, …).
    for (const tag of ["cart-items", "cart-drawer-items"]) {
      const el = d.querySelector(tag) as (Element & { onCartUpdate?: () => unknown }) | null;
      if (el && typeof el.onCartUpdate === "function") {
        el.onCartUpdate();
        handled = true;
      }
    }
    // Horizon family (2025+ Shopify themes) listen for this.
    d.dispatchEvent(
      new CustomEvent("cart:update", {
        bubbles: true,
        detail: {
          resource: cart,
          sourceId: "shipping-protection",
          data: { source: "shipping-protection", itemCount: cart.item_count },
        },
      }),
    );
    if (d.querySelector("cart-items-component")) handled = true;
    // Maestrooo (Prestige, Impact, Focal, …) and Archetype (Impulse, Motion, …).
    d.documentElement.dispatchEvent(new CustomEvent("cart:refresh", { bubbles: true }));
    d.dispatchEvent(new CustomEvent("cart:build"));
    // A theme-specific event the merchant set in the app embed.
    if (this.env.refreshEvent) {
      d.dispatchEvent(new CustomEvent(this.env.refreshEvent, { bubbles: true, detail: { cart } }));
    }
    d.dispatchEvent(new CustomEvent("shipping-protection:change", { detail: { cart } }));

    const onCartPage = /\/cart\/?$/.test(location.pathname);
    if (onCartPage && (this.env.refresh === "reload" || (this.env.refresh === "auto" && !handled))) {
      location.reload();
    }
  }

  // ---- Rendering ----

  private paint() {
    this.hideProtectionLines();
    const slots = this.slots();
    const prot = this.cart?.items.find((i) => i.product_id === this.cfg.productId);
    const offered = this.quote !== null && (this.cart?.item_count ?? 0) > 0;
    for (const slot of slots) this.render(slot, offered, prot);
  }

  /** App-block slots, plus (auto placement) one before each checkout button. */
  private slots(): HTMLElement[] {
    const blockSlots = [...document.querySelectorAll<HTMLElement>("[data-sp-slot]")];
    if (this.env.placement !== "auto") return blockSlots;
    const buttons = document.querySelectorAll<HTMLElement>(
      'button[name="checkout"], input[name="checkout"], a[href$="/checkout"]',
    );
    const auto: HTMLElement[] = [];
    buttons.forEach((btn) => {
      const scope = btn.closest("form, .shopify-section, cart-drawer, [id*='CartDrawer']");
      if (scope?.querySelector("[data-sp-slot]")) return; // merchant placed a block here
      let anchor: HTMLElement = btn;
      const parent = btn.parentElement;
      if (parent) {
        const cs = getComputedStyle(parent);
        // Buttons side by side (checkout + PayPal…): go above the whole row.
        if (cs.display.includes("flex") && !cs.flexDirection.startsWith("column")) anchor = parent;
      }
      const prev = anchor.previousElementSibling as HTMLElement | null;
      if (prev?.hasAttribute("data-sp-auto")) {
        auto.push(prev);
        return;
      }
      const slot = document.createElement("div");
      slot.setAttribute("data-sp-auto", "");
      anchor.parentElement?.insertBefore(slot, anchor);
      auto.push(slot);
    });
    return [...blockSlots, ...auto];
  }

  private render(slot: HTMLElement, offered: boolean, line: CartItem | undefined) {
    if (!offered) {
      if (!slot.hidden) slot.hidden = true;
      return;
    }
    slot.hidden = false;
    const on = Boolean(line);
    const price = line
      ? this.money.format(line.final_price / 100)
      : this.money.format(((this.quote!.priceMinor / 10 ** this.cfg.decimals) * this.rate));
    const t = this.env.t;
    const title = this.cfg.copy.title || t.title;
    const description = this.cfg.copy.description || t.description;
    const state = `${on}|${price}|${this.busy}`;
    if (slot.dataset.spState === state) return; // nothing changed — don't churn the DOM
    slot.dataset.spState = state;

    let box = slot.querySelector<HTMLElement>(".sp-widget");
    if (!box) {
      box = document.createElement("div");
      box.className = "sp-widget";
      box.innerHTML = `
        <label class="sp-row">
          <input type="checkbox" class="sp-check" role="switch">
          <span class="sp-switch" aria-hidden="true"></span>
          <span class="sp-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M12 2 4 5v6c0 5.25 3.4 10.15 8 11.4 4.6-1.25 8-6.15 8-11.4V5l-8-3Zm-1.2 14.2-3.5-3.5 1.4-1.4 2.1 2.1 4.6-4.6 1.4 1.4-6 6Z"/></svg></span>
          <span class="sp-text"><span class="sp-title"></span><span class="sp-desc"></span></span>
          <span class="sp-price"></span>
        </label>`;
      slot.appendChild(box);
      box.querySelector("input")!.addEventListener("change", (e) => {
        const checked = (e.currentTarget as HTMLInputElement).checked;
        this.reconcile(checked ? "accepted" : "declined");
      });
    }
    const input = box.querySelector<HTMLInputElement>(".sp-check")!;
    input.checked = on;
    input.disabled = this.busy;
    input.setAttribute("aria-label", `${title} ${price}`);
    box.classList.toggle("sp-on", on);
    box.classList.toggle("sp-busy", this.busy);
    box.querySelector(".sp-title")!.textContent = title;
    const desc = box.querySelector<HTMLElement>(".sp-desc")!;
    desc.textContent = `${description} `;
    if (this.cfg.copy.learnMoreUrl) {
      const a = document.createElement("a");
      a.href = this.cfg.copy.learnMoreUrl;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = t.learnMore;
      desc.appendChild(a);
    }
    box.querySelector(".sp-price")!.textContent = price;
  }

  /** Hide the protection product's own row in the theme's cart list. */
  private hideProtectionLines() {
    if (!this.env.hideLine) return;
    const links = document.querySelectorAll<HTMLAnchorElement>(`a[href*="/products/${this.cfg.handle}"]`);
    links.forEach((a) => {
      const row = a.closest<HTMLElement>(
        "tr, li, [data-cart-item], [class*='cart-item'], [class*='cart__item'], [class*='line-item'], [class*='CartItem']",
      );
      if (!row || row.classList.contains("sp-hidden-line")) return;
      // Never hide a container that also holds real products.
      const productLinks = row.querySelectorAll('a[href*="/products/"]');
      const onlyOurs = [...productLinks].every((l) => l.getAttribute("href")?.includes(`/products/${this.cfg.handle}`));
      if (onlyOurs) row.classList.add("sp-hidden-line");
    });
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
