import { cents, normalize, rankOffers } from "../agent/matcher.js";
import type { BotConfig, Strategy } from "../config/schema.js";
import type { Offer } from "../sites/SiteAdapter.js";

/**
 * INSTANT-ON-SALE — critères de sélection COMPILÉS avant T0 (objet immuable).
 *
 * La DÉCISION reste celle du cœur (`rankOffers`, inchangé, déterministe) : cet objet ne fait que (1) figer et normaliser une fois les
 * critères avant l'ouverture et (2) écarter tôt, par des comparaisons entières, les offres que le cœur écarterait de toute façon
 * (quantité, prix en centimes, catégorie, sections exclues, adjacence stricte). Un test d'équivalence aléatoire garantit que
 * `rank(offres)` ≡ `rankOffers(offres)` du cœur.
 */
export interface CompiledSelectionCriteria {
  readonly quantity: number;
  readonly maxPriceCents: number;
  /** Catégories acceptées (normalisées) ; vide = toutes. */
  readonly categories: readonly string[];
  readonly excludedSections: readonly string[];
  readonly seatsTogether: boolean;
  readonly strictTogether: boolean;
  readonly strategy: Readonly<Strategy>;
  readonly tickets: Readonly<BotConfig["tickets"]>;
  /** Offres restantes après les filtres durs (mêmes filtres que le cœur). */
  candidates(offers: readonly Offer[]): Offer[];
  /** Classement final : celui du cœur, sur les candidates. */
  rank(offers: readonly Offer[]): Offer[];
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

export function compileSelection(config: Pick<BotConfig, "tickets" | "strategy">): CompiledSelectionCriteria {
  const tickets = deepFreeze(structuredClone(config.tickets));
  const strategy = deepFreeze(structuredClone(config.strategy));
  const categories = Object.freeze(tickets.categories.map(normalize));
  const excluded = Object.freeze(strategy.placement.excludeSections.map(normalize));
  const maxPriceCents = cents(tickets.maxPricePerTicket);
  const strict = tickets.seatsTogether && tickets.seatsTogetherStrict;
  const catSet = new Set(categories);
  const inExcluded = (section: string | undefined): boolean => {
    if (!section || excluded.length === 0) return false;
    const v = normalize(section);
    return excluded.some((p) => v.includes(p));
  };
  const candidates = (offers: readonly Offer[]): Offer[] =>
    offers.filter(
      (o) => o.available >= tickets.quantity && cents(o.pricePerTicket) <= maxPriceCents && (catSet.size === 0 || catSet.has(normalize(o.category))) && !inExcluded(o.section) && (!strict || o.seatsTogether === true),
    );
  return Object.freeze({
    quantity: tickets.quantity,
    maxPriceCents,
    categories,
    excludedSections: excluded,
    seatsTogether: tickets.seatsTogether,
    strictTogether: strict,
    strategy,
    tickets,
    candidates,
    rank: (offers: readonly Offer[]) => rankOffers(candidates(offers), tickets, strategy),
  });
}
