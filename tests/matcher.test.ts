import assert from "node:assert/strict";
import { test } from "node:test";
import { rankOffers, seatsAreContiguous, verifyCart } from "../src/agent/matcher.js";
import type { Offer } from "../src/sites/SiteAdapter.js";

const base = { quantity: 2, maxPricePerTicket: 150, categories: ["Catégorie 1", "Catégorie 2", "Catégorie 3"], seatsTogether: true, seatsTogetherStrict: false };
const offer = (o: Partial<Offer> & { id: string }): Offer => ({ category: "Catégorie 2", pricePerTicket: 100, currency: "EUR", available: 2, seatsTogether: true, ...o });

test("filtre prix, quantité et catégorie (accents/casse ignorés, pas de faux positif 'Catégorie 10')", () => {
  const r = rankOffers(
    [offer({ id: "cher", pricePerTicket: 151 }), offer({ id: "peu", available: 1 }), offer({ id: "autre", category: "Catégorie 10" }), offer({ id: "ok", category: "categorie 2" })],
    base,
  );
  assert.deepEqual(r.map((o) => o.id), ["ok"]);
});

test("côte à côte d'abord, puis ordre des catégories, puis prix", () => {
  const r = rankOffers(
    [
      offer({ id: "sep-c1", category: "Catégorie 1", seatsTogether: false }),
      offer({ id: "tog-c3", category: "Catégorie 3" }),
      offer({ id: "tog-c2-cher", pricePerTicket: 140 }),
      offer({ id: "tog-c2", pricePerTicket: 90 }),
      offer({ id: "unk-c1", category: "Catégorie 1", seatsTogether: "unknown" }),
    ],
    base,
  );
  assert.deepEqual(r.map((o) => o.id), ["tog-c2", "tog-c2-cher", "tog-c3", "unk-c1", "sep-c1"]);
});

test("mode strict : seules les offres confirmées côte à côte", () => {
  const r = rankOffers([offer({ id: "a", seatsTogether: false }), offer({ id: "b", seatsTogether: "unknown" }), offer({ id: "c" })], { ...base, seatsTogetherStrict: true });
  assert.deepEqual(r.map((o) => o.id), ["c"]);
});

test("contiguïté des sièges", () => {
  assert.equal(seatsAreContiguous(["5", "6"], 2), true);
  assert.equal(seatsAreContiguous(["8", "20"], 2), false);
  assert.equal(seatsAreContiguous(["11", "12", "13", "14"], 3), true);
  assert.equal(seatsAreContiguous(["A", "B"], 2), "unknown");
  assert.equal(seatsAreContiguous(undefined, 2), "unknown");
});

test("vérification du panier", () => {
  const cart = { itemCount: 2, totalPrice: 278, currency: "EUR", items: [{ label: "x", quantity: 2, unitPrice: 139 }] };
  assert.equal(verifyCart(cart, base).ok, true);
  assert.equal(verifyCart({ ...cart, itemCount: 1 }, base).ok, false);
  assert.equal(verifyCart({ ...cart, items: [{ label: "x", quantity: 2, unitPrice: 160 }] }, base).ok, false);
});
