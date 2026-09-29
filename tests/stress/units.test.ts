import assert from "node:assert/strict";
import { test } from "node:test";
import { rankOffers, verifyCart } from "../../src/agent/matcher.js";
import { ConfigSchema, type TicketCriteria } from "../../src/config/schema.js";
import { validateConfig } from "../../src/config/validate.js";
import ExampleSite from "../../src/sites/ExampleSite.js";
import { checkAdapterContract } from "../../src/sites/contract.js";
import type { SiteAdapter } from "../../src/sites/SiteAdapter.js";
import { redact } from "../../src/utils/redact.js";
import { offer } from "../helpers/fakeAdapter.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const t = (max: number): TicketCriteria => ({ quantity: 2, maxPricePerTicket: max, categories: [], seatsTogether: true, seatsTogetherStrict: false });

test("14/15 · budget au centime près : =max accepté, +1 centime refusé, sans piège de virgule flottante", () => {
  const ids = (price: number, max = 120): string[] => rankOffers([offer({ id: "x", pricePerTicket: price })], t(max)).map((o) => o.id);
  assert.deepEqual(ids(120), ["x"]);
  assert.deepEqual(ids(120.01), []);
  assert.deepEqual(ids(119.99), ["x"]);
  assert.deepEqual(ids(0.1 + 0.2, 0.3), ["x"], "0,1 + 0,2 = 0,30000000000000004 doit rester ≤ 0,30");
  assert.deepEqual(ids(120.00000000000001), ["x"], "bruit de virgule flottante");
  assert.deepEqual(ids(19.99 * 6, 119.94), ["x"]);
  assert.deepEqual(ids(19.99 * 6 + 0.01, 119.94), []);
  const cart = { itemCount: 2, totalPrice: 240, currency: "EUR", items: [{ label: "x", quantity: 2, unitPrice: 120 }] };
  assert.equal(verifyCart(cart, t(120)).ok, true);
  assert.equal(verifyCart({ ...cart, items: [{ label: "x", quantity: 2, unitPrice: 120.01 }] }, t(120)).ok, false);
});

test("assainissement : URL à jeton, e-mail, carte, IBAN, mot de passe, en-tête d'autorisation, sans abîmer durées ni horodatages", () => {
  const out = redact("GET https://s.example/p?token=ABCDEF123456&sid=Z1 — jean@ex.com — 4970 1012 3456 7890 — password=hunter2 — Authorization: Bearer abcdef123456 — FR7630006000011234567890189");
  for (const bad of ["ABCDEF123456", "sid=Z1", "jean@ex.com", "4970 1012", "hunter2", "abcdef123456", "30006000011234567890189"]) assert.ok(!out.includes(bad), `« ${bad} » : ${out}`);
  const keep = "T+436.1 ms · ouverture 2026-09-29T20:18:57.000Z · 6 offres · id=o5 · http://127.0.0.1:37883/event";
  assert.equal(redact(keep), keep);
  assert.equal(redact("a https://x.example/a/b?q=1#f b"), "a https://x.example/a/b?<masqué> b");
  assert.equal(redact("https://x.example/a?b=1", { urls: "drop" }), "<url>");
  assert.match(redact("Session SESSION-9f8e7d6c5b4a expirée", { tokens: true }), /<jeton>/);
  assert.equal(redact("chemin runs/run-2026-09-29T20-24-05-211Z-simulation-b327d6.json"), "chemin runs/run-2026-09-29T20-24-05-211Z-simulation-b327d6.json", "les chemins de fichiers des logs restent lisibles");
});

const patched = (limit: number): SiteAdapter => {
  const a = new ExampleSite();
  return Object.create(a, { meta: { value: { ...a.meta, capabilities: { ...a.meta.capabilities, maxTicketsPerOrder: limit } } } }) as SiteAdapter;
};
const cfgFile = (quantity: number): string => {
  const f = join(mkdtempSync(join(tmpdir(), "lim-")), "c.json");
  writeFileSync(f, JSON.stringify({ site: "example", event: { name: "e", url: "http://127.0.0.1:4173/e" }, sale: { startTime: "2031-01-01T10:00:00+01:00" }, tickets: { quantity, maxPricePerTicket: 50 } }));
  return f;
};

test("07 · `validate` refuse d'avance une quantité supérieure à la limite d'achat du site ; le contrat valide la déclaration", async () => {
  const bad = await validateConfig(cfgFile(4), { adapters: [patched(2)], env: {} });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(" "), /dépasse la limite d'achat du site \(2\)/);
  assert.equal((await validateConfig(cfgFile(2), { adapters: [patched(2)], env: {} })).ok, true);
  assert.ok(checkAdapterContract(patched(0)).some((i) => i.code === "CAPS_LIMIT"));
  assert.ok(!checkAdapterContract(patched(4)).some((i) => i.code === "CAPS_LIMIT"));
});

test("13 · categories=[] par défaut ; un navigateur par profil (userDataDir vide, port automatique)", () => {
  const c = ConfigSchema.parse({ site: "x", event: { name: "e" }, sale: { startTime: "2030-01-01T00:00:00Z" }, tickets: { quantity: 1, maxPricePerTicket: 1 } });
  assert.deepEqual(c.tickets.categories, []);
  assert.equal(c.browser.userDataDir, undefined);
  assert.equal(c.browser.debugPort, 0);
  assert.equal(c.timing.soldOutPollIntervalMs, 1000);
  assert.equal(c.cart.unavailableCooldownMs, 3000);
});
