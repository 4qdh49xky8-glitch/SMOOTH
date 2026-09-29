import type { BotConfig } from "../config/schema.js";
import type { CartSummary, Offer } from "../sites/SiteAdapter.js";

export const normalize = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

type Criteria = Pick<
  BotConfig,
  "quantity" | "maxPricePerTicket" | "categories" | "seatsTogether" | "seatsTogetherStrict"
>;

/**
 * Filtre puis classe les offres. 100 % déterministe (aucun appel LLM).
 * Ordre : côte à côte d'abord (si demandé) → ordre des catégories du fichier → prix croissant.
 */
export function rankOffers(offers: Offer[], c: Criteria): Offer[] {
  const wanted = c.categories.map(normalize);
  const togetherRank = (o: Offer): number => (o.seatsTogether === true ? 0 : o.seatsTogether === "unknown" ? 1 : 2);

  return offers
    .filter((o) => o.available >= c.quantity)
    .filter((o) => o.pricePerTicket <= c.maxPricePerTicket)
    .filter((o) => wanted.includes(normalize(o.category)))
    .filter((o) => !(c.seatsTogether && c.seatsTogetherStrict) || o.seatsTogether === true)
    .sort((a, b) => {
      if (c.seatsTogether) {
        const d = togetherRank(a) - togetherRank(b);
        if (d) return d;
      }
      const cat = wanted.indexOf(normalize(a.category)) - wanted.indexOf(normalize(b.category));
      return cat || a.pricePerTicket - b.pricePerTicket;
    });
}

/** Des numéros de sièges forment-ils une suite contiguë de `quantity` places ? */
export function seatsAreContiguous(seats: string[] | undefined, quantity: number): boolean | "unknown" {
  if (!seats || seats.length === 0) return "unknown";
  const nums = seats.map((s) => Number.parseInt(s, 10));
  if (nums.some(Number.isNaN)) return "unknown";
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    run = sorted[i]! === sorted[i - 1]! + 1 ? run + 1 : 1;
    if (run >= quantity) return true;
  }
  return quantity <= 1;
}

export function verifyCart(cart: CartSummary, c: Criteria): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (cart.itemCount !== c.quantity) problems.push(`quantité ${cart.itemCount} ≠ ${c.quantity} demandée`);
  for (const it of cart.items) {
    if (it.unitPrice > c.maxPricePerTicket) problems.push(`prix ${it.unitPrice} > budget ${c.maxPricePerTicket}`);
  }
  return { ok: problems.length === 0, problems };
}
