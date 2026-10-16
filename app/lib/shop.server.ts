import prisma from "../db.server";

/** The shop's row, created on first sight; a reinstall clears uninstalledAt. */
export async function ensureShop(shop: string, currency?: string) {
  return prisma.shop.upsert({
    where: { shop },
    create: { shop, ...(currency ? { currency } : {}) },
    update: { uninstalledAt: null, ...(currency ? { currency } : {}) },
  });
}
