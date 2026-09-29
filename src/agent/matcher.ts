import { StrategySchema, type Criterion, type Strategy, type TicketCriteria } from "../config/schema.js";
import type { CartSummary, Offer } from "../sites/SiteAdapter.js";

export const normalize = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

export const DEFAULT_STRATEGY: Strategy = StrategySchema.parse({});

const matchesAny = (value: string | undefined, patterns: string[]): boolean => {
  if (!value) return false;
  const v = normalize(value);
  return patterns.some((p) => v.includes(normalize(p)));
};

/**
 * Clés de tri par critère (plus petit = meilleur), comparées lexicographiquement.
 * 100 % déterministe (aucun appel LLM).
 */
function criterionKey(c: Criterion, o: Offer, t: TicketCriteria, s: Strategy): number[] {
  switch (c) {
    case "seatsTogether":
      if (!t.seatsTogether) return [0];
      return [o.seatsTogether === true ? 0 : o.seatsTogether === "unknown" ? 1 : 2];
    case "category": {
      const cat = normalize(o.category);
      const prio = s.priorityCategories.map(normalize);
      const accepted = t.categories.map(normalize);
      const pi = prio.indexOf(cat);
      if (pi >= 0) return [pi];
      const ai = accepted.indexOf(cat);
      return [prio.length + (ai >= 0 ? ai : 0)];
    }
    case "placement": {
      const p = s.placement;
      const section = matchesAny(o.section, p.preferSections) ? 0 : matchesAny(o.section, p.avoidSections) ? 2 : 1;
      const rowNum = Number.parseInt(o.row ?? "", 10);
      const row = p.rowPreference === "any" || Number.isNaN(rowNum) ? Number.MAX_SAFE_INTEGER : p.rowPreference === "front" ? rowNum : -rowNum;
      return [section, row];
    }
    case "price":
      return [s.priceOrder === "cheapest" ? o.pricePerTicket : -o.pricePerTicket];
    case "fit":
      return [o.available - t.quantity];
  }
}

const compareKeys = (a: number[], b: number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

/** Filtre (contraintes dures de `tickets`) puis classe selon `strategy`. */
export function rankOffers(offers: Offer[], t: TicketCriteria, strategy: Strategy = DEFAULT_STRATEGY): Offer[] {
  const wanted = t.categories.map(normalize);
  return offers
    .filter((o) => o.available >= t.quantity)
    .filter((o) => o.pricePerTicket <= t.maxPricePerTicket)
    .filter((o) => wanted.length === 0 || wanted.includes(normalize(o.category)))
    .filter((o) => !matchesAny(o.section, strategy.placement.excludeSections))
    .filter((o) => !(t.seatsTogether && t.seatsTogetherStrict) || o.seatsTogether === true)
    .sort((a, b) => {
      for (const c of strategy.priority) {
        const d = compareKeys(criterionKey(c, a, t, strategy), criterionKey(c, b, t, strategy));
        if (d) return d;
      }
      return a.pricePerTicket - b.pricePerTicket || a.id.localeCompare(b.id); // départage stable
    });
}

/** Détail des clés de tri d'une offre (journal DEBUG, `validate`). */
export function explainOffer(o: Offer, t: TicketCriteria, strategy: Strategy = DEFAULT_STRATEGY): string {
  return strategy.priority.map((c) => `${c}=${criterionKey(c, o, t, strategy).map((n) => (Math.abs(n) > 1e9 ? "∅" : n)).join("/")}`).join(" ");
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

export function verifyCart(cart: CartSummary, c: TicketCriteria): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (cart.itemCount !== c.quantity) problems.push(`quantité ${cart.itemCount} ≠ ${c.quantity} demandée`);
  for (const it of cart.items) {
    if (it.unitPrice > c.maxPricePerTicket) problems.push(`prix ${it.unitPrice} > budget ${c.maxPricePerTicket}`);
  }
  return { ok: problems.length === 0, problems };
}
