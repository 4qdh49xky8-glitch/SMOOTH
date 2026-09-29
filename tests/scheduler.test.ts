import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigSchema } from "../src/config/schema.js";
import { Clock, estimateOffset } from "../src/utils/clock.js";
import { looksLikePayment } from "../src/agent/claude.js";
import { waitUntil } from "../src/utils/scheduler.js";

test("waitUntil se déclenche à moins de 15 ms de la cible", async () => {
  const clock = new Clock();
  const target = clock.now() + 250;
  const overshoot = await waitUntil(target, clock, { spinThresholdMs: 25 });
  assert.ok(overshoot >= 0 && overshoot < 15, `dépassement ${overshoot} ms`);
});

test("l'horloge suit le décalage serveur estimé", async () => {
  const skew = 1234;
  const est = await estimateOffset(async () => Date.now() + skew, 5);
  assert.ok(Math.abs(est.offsetMs - skew) < 20, `offset ${est.offsetMs}`);
  assert.ok(Math.abs(new Clock(est.offsetMs).now() - (Date.now() + skew)) < 20);
});

test("la config refuse autoPayment=true et un saleTime sans fuseau", () => {
  const ok = { event: "e", saleTime: "2026-10-01T10:00:00+02:00", quantity: 2, maxPricePerTicket: 150, categories: ["a"] };
  assert.equal(ConfigSchema.safeParse(ok).success, true);
  assert.equal(ConfigSchema.safeParse({ ...ok, autoPayment: true }).success, false);
  assert.equal(ConfigSchema.safeParse({ ...ok, saleTime: "2026-10-01T10:00:00" }).success, false);
});

test("détection d'éléments de paiement", () => {
  for (const s of ["Payer", "Procéder au paiement", "Confirmer la commande", "Buy now"]) assert.equal(looksLikePayment(s), true, s);
  for (const s of ["Ajouter au panier", "Continuer", "Catégorie 2"]) assert.equal(looksLikePayment(s), false, s);
});
