import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateLegacyConfig } from "../src/config/load.js";
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

test("la config refuse autoPayment=true et un startTime sans fuseau", () => {
  const ok = { site: "example", event: { name: "e" }, sale: { startTime: "2026-10-01T10:00:00+02:00" }, tickets: { quantity: 2, maxPricePerTicket: 150 } };
  assert.equal(ConfigSchema.safeParse(ok).success, true);
  assert.equal(ConfigSchema.safeParse({ ...ok, behavior: { autoPayment: true } }).success, false);
  assert.equal(ConfigSchema.safeParse({ ...ok, sale: { startTime: "2026-10-01T10:00:00" } }).success, false);
  assert.deepEqual(ConfigSchema.parse(ok).tickets.categories, []); // vide = toutes
});

test("l'ancien format plat est migré", () => {
  const legacy = { event: "Ancien", saleTime: "2026-10-01T10:00:00+02:00", quantity: 2, maxPricePerTicket: 150, categories: ["A"], seatsTogether: true, autoAddToCart: true, autoPayment: false };
  const cfg = ConfigSchema.parse(migrateLegacyConfig(legacy));
  assert.equal(cfg.event.name, "Ancien");
  assert.equal(cfg.sale.startTime, legacy.saleTime);
  assert.equal(cfg.tickets.quantity, 2);
  assert.equal(cfg.site, "example");
  assert.equal(ConfigSchema.safeParse(migrateLegacyConfig({ ...legacy, autoPayment: true })).success, false);
});

test("détection d'éléments de paiement", () => {
  for (const s of ["Payer", "Procéder au paiement", "Confirmer la commande", "Buy now"]) assert.equal(looksLikePayment(s), true, s);
  for (const s of ["Ajouter au panier", "Continuer", "Catégorie 2"]) assert.equal(looksLikePayment(s), false, s);
});
