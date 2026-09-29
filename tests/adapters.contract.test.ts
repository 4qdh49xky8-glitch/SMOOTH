import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCompliant } from "../src/sites/compliance.js";
import { discoverAdapters } from "../src/sites/registry.js";

/**
 * Contrat appliqué automatiquement à TOUT adaptateur déposé dans src/sites/ :
 * un nouveau site est vérifié sans qu'on ait à toucher à ce fichier.
 */
const adapters = await discoverAdapters();

test("au moins un adaptateur est découvert et les identifiants sont uniques", () => {
  assert.ok(adapters.length >= 1);
  assert.equal(new Set(adapters.map((a) => a.meta.id)).size, adapters.length);
});

for (const a of adapters) {
  test(`contrat « ${a.meta.id} » : méthodes, métadonnées, garde-fou de paiement, conformité`, () => {
    for (const m of ["resolveEventUrl", "ensureLoggedIn", "prepare", "fetchSale", "selectOffer", "addToCart", "readCart", "detectBlocker"] as const) {
      assert.equal(typeof a[m], "function", `${m} manquant`);
    }
    assert.match(a.meta.id, /^[a-z0-9-]+$/);
    assert.ok(a.meta.displayName.length > 0);
    assert.ok(a.paymentUrlPatterns.length > 0, "paymentUrlPatterns vide : le garde-fou de paiement serait inactif");
    assert.ok(a.paymentUrlPatterns.some((p) => p.test("https://x.example/payment")), "le motif de paiement ne reconnaît pas /payment");
    assert.ok(["none", "automatic", "manual"].includes(a.meta.capabilities.seatSelection));
    if (a.meta.capabilities.seatSelection !== "none") assert.equal(typeof a.selectSeats === "function" || a.meta.capabilities.seatSelection === "manual", true);
    const url = a.meta.compliance.policy === "demo" ? "http://127.0.0.1/e" : "https://example.com/e";
    assertCompliant(a.meta, url); // ne doit pas lever pour la déclaration livrée
  });
}
