// The customer-facing claims page and emails, in the customer's language.
// Merchant-facing text (the admin) stays English.

export const LOCALES = ["en", "de", "fr", "es", "it", "nl", "hi"] as const;
export type Locale = (typeof LOCALES)[number];

/** "fr", "fr-CA", "pt_BR" → a language we have, else English. */
export function claimLocale(raw: string | null | undefined): Locale {
  const base = (raw ?? "").trim().toLowerCase().split(/[-_]/)[0];
  return (LOCALES as readonly string[]).includes(base) ? (base as Locale) : "en";
}
