import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { rankOffers, verifyCart } from "../src/agent/matcher.js";
import { createApiContext } from "../src/api/BaseApiAdapter.js";
import { ConfigSchema } from "../src/config/schema.js";
import { runInstantSale } from "../src/instant/runner.js";
import { assertAuthorized, assertNetworkAllowed, authorizeAdapter } from "../src/platforms/authorize.js";
import { checkAdapterContract } from "../src/sites/contract.js";
import PretixAdapter, { PRETIX_EMAIL_ENV, PRETIX_TOKEN_ENV, parseEventUrl, toCents } from "../src/sites/pretix/PretixAdapter.js";
import { BlockerError, NotLoggedInError, OfferUnavailableError, RateLimitedError, StopRunError } from "../src/utils/errors.js";
import { silentLogger } from "../src/utils/logger.js";
import { redact } from "../src/utils/redact.js";
import { acquireEventLock } from "../src/utils/lock.js";
import { lockKeysFor } from "../src/sale/lockKeys.js";
import { FAKE_TOKEN, fakePretix, type FakePretixOptions } from "../testkit/fakePretix.js";
import { MockMailer } from "../testkit/mockMailer.js";
import { catalogWith, daysAgo, ev, plat, TODAY } from "./helpers/platformFixtures.js";

/**
 * pretix — banc de test API-first sur une INSTANCE CONTRÔLÉE (AUTHORIZED_SCOPE = CONTROLLED_PRETIX_INSTANCE_ONLY).
 * Aucune requête réelle : faux `fetch` en mémoire (testkit/fakePretix.ts), jeton FICTIF. Le catalogue ci-dessous est un catalogue DE TEST :
 * il n'enregistre aucune preuve réelle. Une simulation locale n'est jamais un achat réel ; les durées mesurées sont celles de la fixture.
 */
const URL_OK = "https://pretix.eu/demo-org/demo-event/";
const ENV = { [PRETIX_TOKEN_ENV]: FAKE_TOKEN, [PRETIX_EMAIL_ENV]: "organisateur@example.org" } as NodeJS.ProcessEnv;
const testCatalog = (age = 3) => catalogWith([plat("pretix", { officialHosts: ["pretix.eu"] })], [ev("pretix", "api", daysAgo(age, Date.now()), { source: { url: "https://docs.pretix.eu/dev/api/index.html", title: "REST API (test)" } })]);
const cfg = (over: Record<string, unknown> = {}, qty = 2) => ConfigSchema.parse({
  site: "pretix", event: { name: "Événement de test contrôlé", url: URL_OK }, sale: { startTime: new Date(Date.now() + 1200).toISOString() },
  tickets: { quantity: qty, maxPricePerTicket: 150 }, timing: { preArmSeconds: 0.5, pollIntervalMs: 200, maxWaitAfterSaleSeconds: 6 }, notifications: { desktop: false, sound: false }, telemetry: { enabled: false },
  browser: { headless: true }, ...over,
});
const make = (fx: FakePretixOptions = {}, env: NodeJS.ProcessEnv = ENV) => {
  const f = fakePretix(fx);
  const adapter = new PretixAdapter({ fetchImpl: f.fetchImpl, env, minIntervalMs: 200, sleep: async () => undefined });
  const config = (over: Record<string, unknown> = {}, qty = 2) => cfg(over, qty);
  const ctx = (c = config()) => createApiContext(c, silentLogger, env);
  return { f, adapter, config, ctx };
};
const prev = process.env[PRETIX_TOKEN_ENV];
before(() => void (process.env[PRETIX_TOKEN_ENV] = FAKE_TOKEN)); // jeton FICTIF : le cœur exige la variable déclarée dans meta.requires.env
after(() => (prev === undefined ? delete process.env[PRETIX_TOKEN_ENV] : void (process.env[PRETIX_TOKEN_ENV] = prev)));
const createMode = { siteOptions: { pretix: { orderMode: "create" } } };

test("catalogue/contrat : hôte fixe pretix.eu, canal API officiel, secret en variable d'environnement, aucune méthode de paiement", () => {
  const a = new PretixAdapter({ env: ENV });
  assert.equal(a.channel, "official-api");
  assert.deepEqual(a.allowedHosts(), ["pretix.eu"]);
  assert.deepEqual(a.meta.requires?.env, [PRETIX_TOKEN_ENV]);
  assert.match(String(a.meta.compliance.notes), /CONTROLLED_PRETIX_INSTANCE_ONLY/);
  const errors = checkAdapterContract(a, { catalog: testCatalog() }).filter((i) => i.severity === "error");
  assert.deepEqual(errors, [], errors.map((e) => e.message).join(" | "));
  assert.ok(!Object.getOwnPropertyNames(PretixAdapter.prototype).some((m) => /^(pay|payment|checkout|purchase|placeOrder|confirmOrder|charge|settle)/i.test(m)));
});

test("portée d'autorisation : NOT_VERIFIED, preuve expirée ou hôte étranger → refus avant toute requête ; preuve valide → autorisé", () => {
  const a = new PretixAdapter({ env: ENV });
  assert.equal(authorizeAdapter(a.meta, catalogWith([plat("pretix", { officialHosts: ["pretix.eu"] })])).ok, false, "NOT_VERIFIED : refus");
  assert.equal(authorizeAdapter(a.meta, testCatalog(181)).ok, false, "preuve de 181 jours : expirée");
  assert.doesNotThrow(() => assertAuthorized(a.meta, testCatalog(3)));
  assert.doesNotThrow(() => assertNetworkAllowed(a, cfg(), testCatalog()));
  for (const bad of ["https://evil.example/demo-org/demo-event/", "https://pretix.eu.evil.example/o/e/", "http://pretix.eu/o/e/", "https://user:pw@pretix.eu/o/e/", "https://mon-instance.example.org/o/e/", "https://pretix.eu/seulement-un-segment"]) {
    assert.throws(() => a.resolveEventUrl(cfg({ event: { name: "x", url: bad } })), /pretix/, bad);
  }
  assert.deepEqual(parseEventUrl(URL_OK), { organizer: "demo-org", event: "demo-event" });
  assert.throws(() => assertNetworkAllowed(a, cfg(), catalogWith([plat("pretix", { officialHosts: ["autre.example"] })], [ev("pretix", "api")])), /hors des domaines autorisés|refusé/);
});

test("authentification : jeton d'environnement en `Token …`, absent → LOGIN_REQUIRED, 401/403/404 remontés sans contournement, jamais de secret dans les erreurs", async () => {
  const ok = make();
  await ok.adapter.ensureLoggedIn(ok.ctx());
  assert.ok(ok.f.calls.every((c) => c.authOk && c.host === "pretix.eu"), "jeton présenté, hôte fixe");
  const none = make({}, { [PRETIX_EMAIL_ENV]: "x@example.org" });
  await assert.rejects(none.adapter.ensureLoggedIn(none.ctx()), NotLoggedInError);
  assert.equal(none.f.calls.length, 0, "aucune requête sans jeton");
  const bad = make({}, { [PRETIX_TOKEN_ENV]: "JETON-INVALIDE-FICTIF-123456" });
  const e401 = await bad.adapter.ensureLoggedIn(bad.ctx()).then(() => undefined, (e: unknown) => e);
  assert.ok(e401 instanceof NotLoggedInError);
  assert.ok(!String((e401 as Error).message).includes("JETON-INVALIDE-FICTIF"));
  const perm = make({ authFail: 403 });
  const e403 = await perm.adapter.ensureLoggedIn(perm.ctx()).then(() => undefined, (e: unknown) => e);
  assert.ok(e403 instanceof BlockerError && e403.blocker.state === "BLOCKED", "permission insuffisante : remontée, jamais contournée");
  const nf = make({ notFound: true });
  await assert.rejects(nf.adapter.ensureLoggedIn(nf.ctx()), /introuvable ou inaccessible/);
  const text = [e401, e403].map((e) => String((e as Error).message)).join(" ");
  assert.ok(!text.includes(FAKE_TOKEN));
});

test("disponibilité + offres : prix en centimes, catégories, quantités de quota, variations, limite par commande appliquée, épuisé, vente non live, réponses mal formées", async () => {
  assert.equal(toCents("19.99") * 3, 5997);
  assert.equal(toCents("0.10") + toCents("0.20"), 30);
  assert.throws(() => toCents("12,5"), /mal formé/);
  const m = make({
    items: [
      { id: 1, name: "Standard", category: 10, price: "40.00", max_per_order: 1 },
      { id: 2, name: "VIP", category: 11, price: "120.50", variations: [{ id: 21, value: "Gold", price: "150.00" }] },
      { id: 3, name: "Goodies", category: null, price: "5.00", admission: false },
    ],
    quotas: [{ id: 100, items: [1], available: true, number: 50 }, { id: 101, items: [2], variations: [21], available: true, number: 3 }],
  });
  const ctx = m.ctx();
  await m.adapter.ensureLoggedIn(ctx);
  assert.equal((await m.adapter.getAvailability(ctx)).open, true);
  const offers = await m.adapter.getOffers(ctx);
  const byId = Object.fromEntries(offers.map((o) => [o.id, o]));
  assert.deepEqual(Object.keys(byId).sort(), ["1", "2:21"], "les produits sans admission sont ignorés");
  assert.equal(byId["1"]!.available, 1, "max_per_order de pretix : jamais contourné (pas de commandes multiples)");
  assert.equal(byId["1"]!.pricePerTicket, 40);
  assert.equal(byId["2:21"]!.pricePerTicket, 150);
  assert.equal(byId["2:21"]!.available, 3);
  assert.equal(byId["2:21"]!.category, "VIP");
  assert.equal(byId["2:21"]!.currency, "EUR");
  // épuisé : quota sans disponibilité
  const so = make({ quotas: [{ id: 100, items: [1], available: false, number: 0 }, { id: 101, items: [2], available: false, number: 0 }] });
  const a = await so.adapter.getAvailability(so.ctx());
  assert.deepEqual([a.open, a.soldOut], [true, true]);
  // vente non ouverte
  const off = make({ live: false });
  assert.equal((await off.adapter.getAvailability(off.ctx())).open, false);
  assert.equal(off.f.calls.filter((c) => /availability/.test(c.path)).length, 0, "aucune lecture de quota tant que la vente n'est pas live");
  for (const malformed of ["items", "availability", "event"] as const) {
    const x = make({ malformed });
    await assert.rejects(x.adapter.getOffers(x.ctx()), /mal formée/, malformed);
  }
});

test("sélection : le cœur applique budget, catégorie, quantité et stratégie ; min_per_order en veto ; seatsTogether non supporté → « unknown »", async () => {
  const m = make({
    items: [{ id: 1, name: "Standard", category: 10, price: "40.00" }, { id: 2, name: "VIP", category: 11, price: "200.00" }, { id: 4, name: "Duo", category: 10, price: "35.00", min_per_order: 2 }],
    quotas: [{ id: 100, items: [1, 4], available: true, number: 5 }, { id: 101, items: [2], available: true, number: 5 }],
  });
  const c = m.config({ tickets: { quantity: 1, maxPricePerTicket: 150, categories: ["Standard"] } }, 1);
  const ctx = m.ctx(c);
  await m.adapter.ensureLoggedIn(ctx);
  const offers = await m.adapter.getOffers(ctx);
  assert.ok(offers.every((o) => o.seatsTogether === "unknown"));
  const ranked = rankOffers(offers, c.tickets, c.strategy).filter((o) => m.adapter.matchOffer(o, c.tickets));
  assert.deepEqual(ranked.map((o) => o.id), ["1"], "VIP hors budget, « Duo » exige 2 billets minimum (veto)");
});

test("simulation : `simulate: true` ne crée AUCUNE commande, résultat PRETIX_SIMULATION_SUCCESS (jamais un panier), aucun paiement", async () => {
  const m = make();
  const ctx = m.ctx();
  await m.adapter.ensureLoggedIn(ctx);
  const offer = (await m.adapter.getOffers(ctx)).find((o) => o.id === "1")!;
  await m.adapter.selectOffer(ctx, offer, 2);
  assert.equal(m.adapter.lastResult, "PRETIX_SIMULATION_SUCCESS");
  assert.equal(m.f.simulations(), 1);
  assert.equal(m.f.created(), 0, "aucune commande réelle");
  const post = m.f.calls.find((c) => c.method === "POST")!;
  assert.equal(post.body?.simulate, true);
  assert.equal(post.idempotencyKey, undefined);
  // mode simulation : l'ajout au panier s'arrête explicitement, pas de faux CART_SUCCESS
  const err = await m.adapter.addToCart(ctx).then(() => undefined, (e: unknown) => e);
  assert.ok(err instanceof StopRunError && /PRETIX_SIMULATION_SUCCESS/.test(err.message));
  await assert.rejects(m.adapter.getCartState(ctx), /aucune commande/);
  assert.equal(m.f.created(), 0);
  assert.equal(m.f.paymentRequests().length, 0);
  // échec de validation : commande refusée (quota épuisé, quantité au-delà de la limite) → offre indisponible, une seule requête
  const limit = make({ items: [{ id: 1, name: "S", category: 10, price: "40.00", max_per_order: 1 }] });
  const lctx = limit.ctx();
  await limit.adapter.ensureLoggedIn(lctx);
  const lo = (await limit.adapter.getOffers(lctx))[0]!;
  const before = limit.f.calls.length;
  await assert.rejects(limit.adapter.selectOffer(lctx, { ...lo, available: 5 }, 2), OfferUnavailableError);
  assert.equal(limit.f.calls.length - before, 1, "pas de nouvelle tentative");
  // réponse mal formée / incohérente
  for (const x of [make({ malformed: "order" }), make({ inconsistent: "short" }), make({ inconsistent: "total" })]) {
    const xc = x.ctx();
    await x.adapter.ensureLoggedIn(xc);
    const off = (await x.adapter.getOffers(xc)).find((o) => o.id === "1")!;
    await assert.rejects(x.adapter.selectOffer(xc, off, 2), /mal formée|incohérente/);
  }
});

test("création (mode create, instance contrôlée) : UNE commande en attente, clé d'idempotence, relue et vérifiée → panier cohérent ; jamais de paiement", async () => {
  const m = make();
  const c = m.config(createMode);
  const ctx = m.ctx(c);
  await m.adapter.ensureLoggedIn(ctx);
  const offer = (await m.adapter.getOffers(ctx)).find((o) => o.id === "1")!;
  await m.adapter.selectOffer(ctx, offer, 2);
  await m.adapter.addToCart(ctx);
  assert.equal(m.f.created(), 1);
  assert.equal(m.adapter.lastResult, "PRETIX_ORDER_CREATED");
  const creates = m.f.calls.filter((x) => x.method === "POST" && !x.body?.simulate);
  assert.equal(creates.length, 1);
  assert.match(creates[0]!.idempotencyKey ?? "", /^[0-9a-f-]{36}$/, "clé d'idempotence sur la création");
  assert.ok(m.f.calls.filter((x) => x.method === "GET").every((x) => !x.idempotencyKey), "aucune clé sur les lectures");
  assert.equal(creates[0]!.body?.status, "n", "commande en attente, jamais « payée »");
  const cart = await m.adapter.getCartState(ctx);
  assert.deepEqual([cart.itemCount, cart.totalPrice, cart.currency], [2, 80, "EUR"]);
  assert.ok(cart.expiresAt && cart.expiresAt > Date.now());
  assert.ok(verifyCart(cart, c.tickets).ok);
  assert.equal(m.f.paymentRequests().length, 0);
  // une seconde création est refusée (aucune commande multiple)
  await assert.rejects(m.adapter.addToCart(ctx), StopRunError);
  assert.equal(m.f.created(), 1);
});

test("relecture : statut payé / expiré / annulé, commande expirée ou incohérente → JAMAIS un panier valide ; email de contact requis", async () => {
  for (const [opts, re] of [[{ orderStatus: "p" }, /« p »/], [{ orderStatus: "e" }, /« e »/], [{ orderStatus: "c" }, /« c »/], [{ expires: new Date(Date.now() - 1000).toISOString() }, /expirée/]] as [FakePretixOptions, RegExp][]) {
    const m = make(opts);
    const ctx = m.ctx(m.config(createMode));
    await m.adapter.ensureLoggedIn(ctx);
    const offer = (await m.adapter.getOffers(ctx)).find((o) => o.id === "1")!;
    await m.adapter.selectOffer(ctx, offer, 2);
    await m.adapter.addToCart(ctx);
    await assert.rejects(m.adapter.getCartState(ctx), re);
  }
  for (const inconsistent of ["short", "total"] as const) {
    const m = make({ inconsistent });
    const ctx = m.ctx(m.config(createMode));
    await m.adapter.ensureLoggedIn(ctx);
    const offer = (await m.adapter.getOffers(ctx)).find((o) => o.id === "1")!;
    await assert.rejects(m.adapter.selectOffer(ctx, offer, 2), /incohérente/, "la simulation incohérente arrête avant toute création");
    assert.equal(m.f.created(), 0);
  }
  const noMail = make({}, { [PRETIX_TOKEN_ENV]: FAKE_TOKEN });
  const ctx = noMail.ctx(noMail.config(createMode));
  await noMail.adapter.ensureLoggedIn(ctx);
  const offer = (await noMail.adapter.getOffers(ctx)).find((o) => o.id === "1")!;
  await noMail.adapter.selectOffer(ctx, offer, 2);
  await assert.rejects(noMail.adapter.addToCart(ctx), new RegExp(PRETIX_EMAIL_ENV));
  assert.equal(noMail.f.created(), 0);
});

test("limite de débit : 429 + Retry-After remonté à la lecture ; une écriture attend puis réessaie UNE fois (même clé) ; deux 429 → arrêt ; jamais de boucle", async () => {
  const m = make({ rateLimit: { path: /availability/, times: 1, retryAfter: "3" } });
  const err = await m.adapter.getOffers(m.ctx()).then(() => undefined, (e: unknown) => e);
  assert.ok(err instanceof RateLimitedError && err.retryAfterMs === 3000, String(err));
  const n = m.f.calls.length;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(m.f.calls.length, n, "aucune requête supplémentaire après un 429");

  const waits: number[] = [];
  const once = fakePretix({ rateLimit: { path: /\/orders\/$/, times: 1, retryAfter: "2" } });
  const a1 = new PretixAdapter({ fetchImpl: once.fetchImpl, env: ENV, minIntervalMs: 200, sleep: async (ms) => void waits.push(ms) });
  const ctx = createApiContext(cfg(createMode), silentLogger, ENV);
  await a1.ensureLoggedIn(ctx);
  const offer = (await a1.getOffers(ctx)).find((o) => o.id === "1")!;
  await a1.selectOffer(ctx, offer, 2);
  assert.deepEqual(waits, [2000], "Retry-After respecté avant l'unique nouvel essai");
  assert.equal(once.calls.filter((c) => c.method === "POST").length, 2);

  const twice = fakePretix({ rateLimit: { path: /\/orders\/$/, times: 5, retryAfter: "1" } });
  const a2 = new PretixAdapter({ fetchImpl: twice.fetchImpl, env: ENV, minIntervalMs: 200, sleep: async () => undefined });
  await a2.ensureLoggedIn(ctx);
  const o2 = (await a2.getOffers(ctx)).find((o) => o.id === "1")!;
  await assert.rejects(a2.selectOffer(ctx, o2, 2), OfferUnavailableError);
  assert.equal(twice.calls.filter((c) => c.method === "POST").length, 2, "deux requêtes au plus, jamais de boucle");
  assert.equal(twice.created(), 0);
});

test("aucune commande en double : coupure pendant la création → résultat incertain, arrêt, aucune nouvelle tentative", async () => {
  const m = make({ dropCreate: true });
  const ctx = m.ctx(m.config(createMode));
  await m.adapter.ensureLoggedIn(ctx);
  const offer = (await m.adapter.getOffers(ctx)).find((o) => o.id === "1")!;
  await m.adapter.selectOffer(ctx, offer, 2);
  const e1 = await m.adapter.addToCart(ctx).then(() => undefined, (e: unknown) => e);
  assert.ok(e1 instanceof StopRunError && /incertain/.test(e1.message));
  const posts = m.f.calls.filter((c) => c.method === "POST" && !c.body?.simulate).length;
  await assert.rejects(m.adapter.addToCart(ctx), StopRunError);
  assert.equal(m.f.calls.filter((c) => c.method === "POST" && !c.body?.simulate).length, posts, "pas de seconde requête de création");
});

test("paiement bloqué : aucun chemin de paiement / de transition, aucun champ bancaire, aucune requête vers ces chemins", async () => {
  const m = make();
  const ctx = m.ctx(m.config(createMode));
  await m.adapter.ensureLoggedIn(ctx);
  const offer = (await m.adapter.getOffers(ctx)).find((o) => o.id === "1")!;
  await m.adapter.selectOffer(ctx, offer, 2);
  await m.adapter.addToCart(ctx);
  await m.adapter.getCartState(ctx);
  const before = m.f.calls.length;
  for (const p of ["/organizers/demo-org/events/demo-event/orders/AB001/payments/", "/organizers/demo-org/events/demo-event/orders/AB001/mark_paid/", "/organizers/demo-org/events/demo-event/orders/AB001/payments/1/confirm/"]) {
    // chemin ajouté par l'adaptateur (mark_paid, confirm… ne sont pas couverts par ApiClient) puis garde d'ApiClient (payments)
    await assert.rejects((m.adapter as unknown as { call: (m: string, p: string, o: object) => Promise<unknown> }).call("POST", p, { body: {} }), /paiement|refusé/);
    if (/payments\/$/.test(p)) await assert.rejects(m.adapter.client.request("POST", p, { body: {} }), /paiement|refusé/);
  }
  await assert.rejects(m.adapter.client.request("POST", "/organizers/demo-org/events/demo-event/orders/", { body: { cardNumber: "x", cvv: "y" } }), /donnée de paiement/);
  assert.equal(m.f.calls.length, before, "ces tentatives sont refusées AVANT l'envoi");
  assert.equal(m.f.paymentRequests().length, 0);
  assert.ok(!m.f.calls.some((c) => /payments?|mark_|refund|confirm|transition/.test(c.path)));
  assert.ok(!m.f.calls.some((c) => c.body && /card|cvv|cvc|iban|payment|3ds/i.test(JSON.stringify(c.body))), "aucune donnée bancaire dans aucun corps de requête");
  assert.ok(m.f.calls.every((c) => c.host === "pretix.eu"), "aucun autre hôte");
});

test("secrets : le jeton n'apparaît ni dans les erreurs, ni dans les journaux, ni dans les résumés (masquage)", async () => {
  const lines: string[] = [];
  const m = make({ rateLimit: { path: /items/, times: 1, retryAfter: "1" } });
  const ctx = m.ctx();
  ctx.log = { ...silentLogger, info: (s: string) => void lines.push(s), warn: (s: string) => void lines.push(s), debug: (s: string) => void lines.push(s), error: (s: string) => void lines.push(s) } as never;
  const err = await m.adapter.getOffers(ctx).then(() => undefined, (e: unknown) => e);
  assert.ok(err instanceof RateLimitedError);
  const all = `${String((err as Error).message)} ${lines.join(" ")} ${JSON.stringify(m.f.calls)}`;
  assert.ok(!all.includes(FAKE_TOKEN), "le jeton ne figure ni dans les erreurs, ni dans les journaux, ni dans les appels consignés");
  assert.ok(!redact(`Authorization: Token ${FAKE_TOKEN}`).includes(FAKE_TOKEN));
});

// ───────────────────────────── sale:instant (API seule, aucun appel à Claude, e-mail après CART_SUCCESS vérifié) ─────────────────────────────
async function instant(fx: FakePretixOptions, extra: Record<string, unknown>, deps: Record<string, unknown> = {}) {
  const f = fakePretix(fx);
  const adapter = new PretixAdapter({ fetchImpl: f.fetchImpl, env: ENV, minIntervalMs: 200, sleep: async () => undefined });
  const dir = mkdtempSync(join(tmpdir(), "pretix-"));
  const t0 = Date.now() + 1200;
  const file = join(dir, "sale.json");
  writeFileSync(file, JSON.stringify({
    site: "pretix", event: { name: "Événement de test contrôlé", url: URL_OK }, sale: { startTime: new Date(t0).toISOString() },
    tickets: { quantity: 2, maxPricePerTicket: 150 }, timing: { preArmSeconds: 0.5, pollIntervalMs: 200, maxWaitAfterSaleSeconds: 5 }, notifications: { desktop: false, sound: false }, telemetry: { enabled: false }, ...extra,
  }));
  const lines: string[] = [];
  const res = await runInstantSale({ target: file }, { adapters: [adapter], catalog: testCatalog(), locksDir: join(dir, "locks"), print: (l) => void lines.push(l), authCheckIntervalMs: 50, ...deps });
  return { f, adapter, res, lines, locksDir: join(dir, "locks"), dir, file };
}
const emailCfg = { enabled: true, to: "moi@example.org", on: "CART_SUCCESS", provider: "smtp", from: "bot@example.org", smtp: { host: "127.0.0.1", port: 2525, secure: false } } as never;

test("sale:instant + pretix (mode create, fixture) : T0 → disponibilité → sélection → commande → relecture → CART_SUCCESS → PAYMENT_MANUAL, API seule, Claude 0, une commande, e-mail unique, verrous libérés", async () => {
  const mail = new MockMailer("ok");
  const o = await instant({}, createMode, { emailConfig: emailCfg, mailer: mail.mailer });
  const r = o.res.report;
  assert.equal(r.status, "CART_SUCCESS", o.lines.join("\n"));
  assert.equal(o.res.code, 0);
  assert.equal(r.metrics.claudeCallsTotal, 0, "Claude n'est jamais appelé");
  assert.equal(o.f.created(), 1, "une seule commande");
  assert.equal(o.f.paymentRequests().length, 0);
  assert.match(o.lines.join("\n"), /CART_SUCCESS\nPAYMENT_REQUIRED\nPAYMENT_MANUAL/);
  assert.equal(r.security.payment, "MANUAL");
  for (const k of ["sale_open_to_availability", "availability_to_selection", "selection_to_cart_request", "cart_request_to_cart_success", "total_sale_open_to_cart"] as const) assert.ok(typeof r.timings[k] === "number" && r.timings[k]! >= 0, k);
  console.log(`# pretix (fixture locale — pas des durées pretix réelles) : ouverture→dispo ${r.timings.sale_open_to_availability} ms · dispo→sélection ${r.timings.availability_to_selection} ms · sélection→requête ${r.timings.selection_to_cart_request} ms · requête→CART_SUCCESS ${r.timings.cart_request_to_cart_success} ms · total ${r.timings.total_sale_open_to_cart} ms · retries ${r.metrics.retries} · Claude ${r.metrics.claudeCallsTotal}`);
  assert.equal(mail.calls, 1, "un seul e-mail, après le CART_SUCCESS vérifié");
  assert.ok(!mail.sent[0]!.text.includes(FAKE_TOKEN) && /PAYMENT REQUIRED — PAYMENT MANUAL/.test(mail.sent[0]!.text));
  assert.deepEqual(readdirSync(o.locksDir).filter((f) => f.endsWith(".lock")), []);
});

test("sale:instant + pretix (mode simulation, défaut) : PRETIX_SIMULATION_SUCCESS n'est PAS un CART_SUCCESS — aucune commande, aucun e-mail", async () => {
  const mail = new MockMailer("ok");
  const o = await instant({}, {}, { emailConfig: emailCfg, mailer: mail.mailer });
  assert.notEqual(o.res.report.status, "CART_SUCCESS");
  assert.equal(o.f.created(), 0);
  assert.equal(o.f.simulations() >= 1, true);
  assert.equal(mail.calls, 0);
  assert.ok(!o.lines.some((l) => /^PAYMENT_(REQUIRED|MANUAL)$/.test(l)));
});

test("sale:instant + pretix : commande incohérente, épuisé → jamais CART_SUCCESS ; préconditions : NOT_VERIFIED refusé sans requête ; verrou tenu → refus avant toute requête ; autorisation expirée → arrêt", async () => {
  const short = await instant({ inconsistent: "short" }, createMode);
  assert.notEqual(short.res.report.status, "CART_SUCCESS");
  assert.equal(short.f.created(), 0);
  const sold = await instant({ quotas: [{ id: 100, items: [1], available: false, number: 0 }, { id: 101, items: [2], available: false, number: 0 }] }, createMode);
  assert.equal(sold.res.report.status, "SOLD_OUT");
  assert.equal(sold.f.created(), 0);
  // NOT_VERIFIED : refus avant toute requête
  const f = fakePretix();
  const a = new PretixAdapter({ fetchImpl: f.fetchImpl, env: ENV });
  const dir = mkdtempSync(join(tmpdir(), "pretix-nv-"));
  const file = join(dir, "sale.json");
  writeFileSync(file, JSON.stringify({ site: "pretix", event: { name: "E", url: URL_OK }, sale: { startTime: new Date(Date.now() + 1000).toISOString() }, tickets: { quantity: 2, maxPricePerTicket: 150 }, telemetry: { enabled: false } }));
  const r = await runInstantSale({ target: file }, { adapters: [a], catalog: catalogWith([plat("pretix", { officialHosts: ["pretix.eu"] })]), locksDir: join(dir, "locks"), print: () => undefined });
  assert.equal(r.report.status, "REFUSED");
  assert.equal(f.calls.length, 0, "aucune requête tant que la plateforme est NOT_VERIFIED");
  // verrou tenu par un autre contrôleur
  const cfgObj = JSON.parse(JSON.stringify({ site: "pretix", event: { name: "E", url: URL_OK }, sale: { startTime: new Date(Date.now() + 1000).toISOString() }, tickets: { quantity: 2, maxPricePerTicket: 150 }, telemetry: { enabled: false } }));
  writeFileSync(file, JSON.stringify(cfgObj));
  const locksDir = join(dir, "locks2");
  const keys = lockKeysFor(a, ConfigSchema.parse(cfgObj), "official-api", "sale");
  const other = acquireEventLock(keys[0]!.key, "autre-controleur#1", locksDir);
  try {
    await assert.rejects(runInstantSale({ target: file }, { adapters: [a], catalog: testCatalog(), locksDir, print: () => undefined }), /même événement|verrou/i);
    assert.equal(f.calls.length, 0, "aucune requête pretix");
  } finally {
    other.release();
  }
  // autorisation expirée pendant la surveillance (le catalogue local est relu : plus aucune requête ensuite)
  const catalog = testCatalog();
  const expired = testCatalog(181).evidence;
  const timer = setTimeout(() => void (catalog.evidence.length = 0, catalog.evidence.push(...expired)), 1500);
  const exp = await instant({ live: false }, {}, { catalog, authCheckIntervalMs: 50 });
  clearTimeout(timer);
  assert.equal(exp.res.report.status, "AUTHORIZATION_EXPIRED");
  assert.deepEqual(readdirSync(exp.locksDir).filter((f) => f.endsWith(".lock")), []);
  void TODAY;
});
