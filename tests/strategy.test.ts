import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_STRATEGY, explainOffer, rankOffers } from "../src/agent/matcher.js";
import { StrategySchema, type Strategy, type TicketCriteria } from "../src/config/schema.js";
import type { Offer } from "../src/sites/SiteAdapter.js";

const t: TicketCriteria = { quantity: 2, maxPricePerTicket: 200, categories: ["Cat 1", "Cat 2", "Cat 3"], seatsTogether: true, seatsTogetherStrict: false };
const strat = (o: Record<string, unknown> = {}): Strategy => StrategySchema.parse(o);
const offer = (o: Partial<Offer> & { id: string }): Offer => ({ category: "Cat 2", pricePerTicket: 100, currency: "EUR", available: 2, seatsTogether: true, ...o });
const ids = (xs: Offer[]): string[] => xs.map((o) => o.id);

test("stratégie par défaut : côte à côte > catégorie > prix (comportement V1 conservé)", () => {
  const r = rankOffers([offer({ id: "sep", category: "Cat 1", seatsTogether: false }), offer({ id: "c3", category: "Cat 3" }), offer({ id: "c2b", pricePerTicket: 150 }), offer({ id: "c2a", pricePerTicket: 90 })], t);
  assert.deepEqual(ids(r), ["c2a", "c2b", "c3", "sep"]);
});

test("l'ordre de priorité des critères est configurable", () => {
  const offers = [
    offer({ id: "cheap-sep", category: "Cat 3", pricePerTicket: 50, seatsTogether: false }),
    offer({ id: "pricey-together", category: "Cat 1", pricePerTicket: 190 }),
  ];
  assert.equal(rankOffers(offers, t, strat({ priority: ["seatsTogether", "price"] }))[0]!.id, "pricey-together");
  assert.equal(rankOffers(offers, t, strat({ priority: ["price", "seatsTogether"] }))[0]!.id, "cheap-sep");
  assert.equal(rankOffers(offers, t, strat({ priority: ["category"] }))[0]!.id, "pricey-together"); // Cat 1 d'abord
});

test("un critère absent de la liste est ignoré", () => {
  const offers = [offer({ id: "a", seatsTogether: false, pricePerTicket: 50 }), offer({ id: "b", seatsTogether: true, pricePerTicket: 60 })];
  assert.equal(rankOffers(offers, t, strat({ priority: ["price"] }))[0]!.id, "a");
});

test("priceOrder : moins cher d'abord ou meilleur (plus cher) dans le budget", () => {
  const offers = [offer({ id: "low", pricePerTicket: 60 }), offer({ id: "high", pricePerTicket: 180 })];
  assert.equal(rankOffers(offers, t, strat({ priority: ["price"], priceOrder: "cheapest" }))[0]!.id, "low");
  assert.equal(rankOffers(offers, t, strat({ priority: ["price"], priceOrder: "most-expensive" }))[0]!.id, "high");
  assert.deepEqual(ids(rankOffers([offer({ id: "over", pricePerTicket: 201 })], t)), []); // le budget reste une contrainte dure
});

test("priorityCategories passe avant l'ordre de tickets.categories", () => {
  const offers = [offer({ id: "c1", category: "Cat 1" }), offer({ id: "c3", category: "Cat 3" })];
  assert.equal(rankOffers(offers, t, strat({ priority: ["category"], priorityCategories: ["Cat 3"] }))[0]!.id, "c3");
});

test("placement : sections préférées/évitées/exclues et rang avant/arrière", () => {
  const offers = [
    offer({ id: "fosse", section: "Fosse Or", row: "20" }),
    offer({ id: "lat", section: "Latéral", row: "3" }),
    offer({ id: "limitee", section: "Vue limitée", row: "1" }),
    offer({ id: "visiteurs", section: "Visiteurs", row: "1" }),
  ];
  const s = strat({ priority: ["placement"], placement: { preferSections: ["fosse"], avoidSections: ["vue limitée"], excludeSections: ["visiteurs"] } });
  assert.deepEqual(ids(rankOffers(offers, t, s)), ["fosse", "lat", "limitee"]);
  const rows = [offer({ id: "r5", row: "5" }), offer({ id: "r2", row: "2" }), offer({ id: "r9", row: "9" })];
  assert.deepEqual(ids(rankOffers(rows, t, strat({ priority: ["placement"], placement: { rowPreference: "front" } }))), ["r2", "r5", "r9"]);
  assert.deepEqual(ids(rankOffers(rows, t, strat({ priority: ["placement"], placement: { rowPreference: "back" } }))), ["r9", "r5", "r2"]);
});

test("fit : préfère la quantité disponible la plus proche (évite les places orphelines)", () => {
  const offers = [offer({ id: "six", available: 6 }), offer({ id: "deux", available: 2 }), offer({ id: "trois", available: 3 })];
  assert.deepEqual(ids(rankOffers(offers, t, strat({ priority: ["fit"] }))), ["deux", "trois", "six"]);
});

test("départage stable et détail explicable", () => {
  const offers = [offer({ id: "b" }), offer({ id: "a" })];
  assert.deepEqual(ids(rankOffers(offers, t)), ["a", "b"]);
  assert.match(explainOffer(offers[0]!, t, DEFAULT_STRATEGY), /seatsTogether=0 category=1 placement=1\/.* price=100/);
});

test("le schéma refuse les critères inconnus ou en double", () => {
  assert.throws(() => StrategySchema.parse({ priority: ["magie"] }));
  assert.throws(() => StrategySchema.parse({ priority: ["price", "price"] }));
});
