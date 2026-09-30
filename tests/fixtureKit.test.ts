import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigSchema } from "../src/config/schema.js";
import ExampleSite from "../src/sites/ExampleSite.js";
import { defineApiAdapterSuite, type ApiFixtureHandle } from "../testkit/apiAdapterSuite.js";
import { defineBrowserAdapterSuite } from "../testkit/browserAdapterSuite.js";
import { FakeApiAdapter, fakeApi } from "../testkit/fakeApi.js";
import { startFixtureSite } from "../testkit/fixtureSite.js";
import { CANONICAL_OFFERS, SCENARIOS, optionsForScenario } from "../testkit/scenarios.js";

/**
 * KIT DE FIXTURES (docs/FIXTURES.md) : (1) le faux site et ses scénarios se comportent comme documenté ; (2) les deux suites de
 * conformité passent sur les fixtures de développement TEST_ONLY (ExampleSite, FakeApiAdapter) — elles n'attestent RIEN sur une
 * plateforme réelle : elles prouvent seulement que le kit fonctionne et montrent comment l'utiliser.
 */

// ───────────────────────────── (2) suites de conformité sur les fixtures TEST_ONLY ─────────────────────────────
defineBrowserAdapterSuite({
  label: "ExampleSite (TEST_ONLY)",
  makeAdapter: () => new ExampleSite(),
  configFor: (url) => ConfigSchema.parse({ site: "example", event: { name: "Fixture", url: `${url}/event` }, sale: { startTime: "2030-01-01T00:00:00Z" }, tickets: { quantity: 2, maxPricePerTicket: 150 }, browser: { headless: true } }),
});

const API_ENV = { P_API_KEY: "SECRET-CANARY-1234567890abcdef" };
const api = (over: Parameters<typeof fakeApi>[0] = {}): ApiFixtureHandle => {
  const f = fakeApi(over);
  return { fetchImpl: f.fetchImpl, get calls() { return f.state.calls; } } as ApiFixtureHandle;
};
defineApiAdapterSuite({
  label: "FakeApiAdapter (TEST_ONLY)",
  env: API_ENV,
  makeAdapter: (fetchImpl) => new FakeApiAdapter(fetchImpl, API_ENV),
  configFor: () => ConfigSchema.parse({ site: "p", event: { name: "Fixture", url: "https://api.p.example/events/1" }, sale: { startTime: "2030-01-01T00:00:00Z" }, tickets: { quantity: 2, maxPricePerTicket: 150 } }),
  fixtures: {
    nominal: () => api(),
    "sold-out": () => api({ offers: [{ id: "o1", category: "A", price: 90, available: 0 }] }),
    queue: () => api({ queueWaits: 99 }),
    "purchase-limit": () => api({ reserveResponse: { status: 409, body: { code: "purchase_limit" } } }),
    contention: () => api({ holdStatus: () => 409 }),
    "cart-mismatch": () => api({ shortChange: 1 }),
    "rate-limited": () => api({ rateLimitOnce: true }),
  },
});

// ───────────────────────────── (1) le faux site lui-même ─────────────────────────────
const get = (url: string, cookie = ""): Promise<Response> => fetch(url, { headers: cookie ? { cookie } : {}, redirect: "manual" });
const loginCookie = async (url: string): Promise<string> => {
  const r = await fetch(`${url}/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "email=demo@example.com&password=demo" });
  return (r.headers.get("set-cookie") ?? "").split(";")[0]!;
};

test("faux site : chaque scénario montre ce qu'il annonce (file, CAPTCHA, blocage, complet, non ouvert, connexion)", async () => {
  const expectations: Record<string, RegExp> = {
    queue: /waiting-room/, captcha: /g-recaptcha/, blocked: /Access denied/, "sold-out": /data-testid="sold-out"/, "not-open": /Vente non ouverte/, nominal: /data-testid="offer"/,
  };
  for (const [scenario, re] of Object.entries(expectations)) {
    const site = await startFixtureSite({ scenario: scenario as never });
    try {
      const cookie = await loginCookie(site.url);
      assert.match(await (await get(`${site.url}/event`, cookie)).text(), re, scenario);
    } finally {
      await site.close();
    }
  }
  // connexion exigée : redirection vers /login sans session ; page publique si requireLogin=false
  const site = await startFixtureSite({ scenario: "login-required" });
  assert.equal((await get(`${site.url}/event`)).status, 302);
  await site.close();
  const open = await startFixtureSite({ requireLogin: false });
  assert.equal((await get(`${open.url}/event`)).status, 200);
  assert.equal((await get(`${open.url}/cart`)).status, 302, "le panier exige toujours la connexion");
  await open.close();
});

test("faux site : offres canoniques (prix, catégorie, quantité, sièges), limite d'achat, contention, panier incohérent ; /payment ne fait que COMPTER", async () => {
  const site = await startFixtureSite({ scenario: "nominal" });
  try {
    const cookie = await loginCookie(site.url);
    const offers = (await (await get(`${site.url}/api/offers`, cookie)).json()) as { open: boolean; offers: { id: string; price: number; category: string; available: number; seats: string[] }[] };
    assert.equal(offers.offers.length, CANONICAL_OFFERS.length);
    assert.deepEqual(offers.offers.map((o) => o.id), CANONICAL_OFFERS.map((o) => o.id));
    assert.ok(CANONICAL_OFFERS.some((o) => o.seats.length === 2 && Number(o.seats[1]) - Number(o.seats[0]) > 1), "le jeu contient des sièges NON adjacents");
    assert.ok(CANONICAL_OFFERS.some((o) => o.available < 2) && CANONICAL_OFFERS.some((o) => o.price > 150), "quantité insuffisante et hors budget présentes");
    assert.equal((await get(`${site.url}/payment`, cookie)).status, 200);
    assert.equal(site.state.paymentHits, 1, "la page de paiement ne fait que compter les requêtes (aucun paiement)");
  } finally {
    await site.close();
  }
  const post = (url: string, cookie: string, body: string) => fetch(`${url}/cart/add`, { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body });
  const limited = await startFixtureSite({ scenario: "purchase-limit" });
  const c1 = await loginCookie(limited.url);
  const r1 = await post(limited.url, c1, "offer=o2&quantity=2");
  assert.equal(r1.status, 403);
  assert.match(await r1.text(), /limite d'achat/);
  assert.equal(limited.state.cart.length, 0);
  await limited.close();
  const cont = await startFixtureSite({ scenario: "contention" });
  const c2 = await loginCookie(cont.url);
  assert.equal((await post(cont.url, c2, "offer=o2&quantity=2")).status, 409);
  assert.equal((await post(cont.url, c2, "offer=o2&quantity=2")).status, 302, "la 2e tentative passe");
  await cont.close();
  const mis = await startFixtureSite({ scenario: "cart-mismatch" });
  const c3 = await loginCookie(mis.url);
  await post(mis.url, c3, "offer=o2&quantity=2");
  assert.equal(mis.state.cart[0]!.quantity, 1);
  await mis.close();
});

test("faux site : écoute en local SEULEMENT, consigne méthode + chemin (jamais paramètres ni cookies), tous les scénarios ont un réglage", async () => {
  const site = await startFixtureSite();
  try {
    assert.match(site.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((site.server.address() as { address: string }).address, "127.0.0.1");
    await get(`${site.url}/event?token=SECRET-CANARY&x=1`, "sid=COOKIE-CANARY");
    assert.ok(site.state.requests.length === 1 && !JSON.stringify(site.state.requests).match(/SECRET-CANARY|COOKIE-CANARY|token/));
  } finally {
    await site.close();
  }
  for (const s of SCENARIOS) assert.ok(optionsForScenario(s), s);
  assert.equal(SCENARIOS.length, 10);
});

test("skin personnalisée : un futur adaptateur peut reproduire le balisage d'une plateforme (pages enregistrées) sans toucher à la logique des scénarios", async () => {
  const site = await startFixtureSite({ scenario: "queue", skin: { queue: () => `<div id="q" class="waiting-room-custom">file personnalisée</div>` } });
  try {
    const cookie = await loginCookie(site.url);
    assert.match(await (await get(`${site.url}/event`, cookie)).text(), /waiting-room-custom/);
  } finally {
    await site.close();
  }
});

test("le kit ne peut atteindre que la boucle locale : le serveur n'écoute que sur 127.0.0.1, aucun client réseau, aucune URL externe, aucun paiement", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { stripComments } = await import("../src/sites/contract.js");
  const files = readdirSync("testkit").filter((f) => f.endsWith(".ts"));
  assert.deepEqual(files.sort(), ["apiAdapterSuite.ts", "browserAdapterSuite.ts", "fakeApi.ts", "fakePretix.ts", "fixtureSite.ts", "mockMailer.ts", "scenarios.ts", "scriptedSale.ts"]);
  for (const f of files) {
    const code = stripComments(readFileSync(`testkit/${f}`, "utf8"));
    assert.ok(!/\bfetch\(|node:https["']|axios|WebSocket|node:net["']|node:tls["']|XMLHttpRequest/.test(code), `${f} : primitive réseau`);
    assert.equal(/node:http["']/.test(code), f === "fixtureSite.ts", `${f} : seul le faux site ouvre un serveur (node:http)`);
    const externals = [...code.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]!.toLowerCase()).filter((h) => !["127.0.0.1", "localhost", "x"].includes(h) && !/\.example$|^example\./.test(h));
    assert.deepEqual(externals, [], `${f} : URL externe`);
    assert.ok(!/cardNumber|\bcvv\b|\biban\b/i.test(code), `${f} : donnée de paiement`);
  }
  assert.match(readFileSync("testkit/fixtureSite.ts", "utf8"), /server\.listen\(opts\.port \?\? 0, "127\.0\.0\.1"/);
});
