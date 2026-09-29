import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { Agent, type RunResult } from "../src/agent/Agent.js";
import { ClaudeAssistant } from "../src/agent/claude.js";
import { ConfigSchema, type BotConfig } from "../src/config/schema.js";
import { SelectorResolver } from "../src/selectors/resolver.js";
import type { Blocker } from "../src/sites/SiteAdapter.js";
import { Clock } from "../src/utils/clock.js";
import { BlockerError, OfferUnavailableError } from "../src/utils/errors.js";
import { silentLogger } from "../src/utils/logger.js";
import { FakeAdapter, offer } from "./helpers/fakeAdapter.js";


function setup(overrides: Record<string, unknown> = {}, adapter = new FakeAdapter(), human = true) {
  const config: BotConfig = ConfigSchema.parse({
    site: "fake",
    event: { name: "Test", url: "http://127.0.0.1:9/event" },
    sale: { startTime: new Date(Date.now() - 1000).toISOString() },
    tickets: { quantity: 2, maxPricePerTicket: 150, categories: ["A", "B"], seatsTogether: true },
    timing: { preArmSeconds: 0, pollIntervalMs: 200, maxWaitAfterSaleSeconds: 3 },
    browser: { headless: true },
    notifications: { desktop: false, sound: false },
    telemetry: { enabled: false },
    ...overrides,
  });
  const notices: string[] = [];
  const humans: Blocker[] = [];
  const ctx = {
    config,
    context: {} as never,
    page: { bringToFront: async () => undefined } as unknown as Page,
    log: silentLogger,
    env: {},
    selectors: new SelectorResolver("fake", "/nonexistent/none.json"),
  };
  const agent = new Agent({
    config, adapter, ctx,
    claude: new ClaudeAssistant(config.claude, silentLogger),
    log: silentLogger,
    clock: new Clock(),
    notifier: async (o) => void notices.push(o.title),
    ...(human ? { awaitHuman: async (b: Blocker) => void humans.push(b) } : {}),
  });
  return { adapter, agent, notices, humans, run: (): Promise<RunResult> => agent.run() };
}

test("chemin nominal : meilleure offre ajoutée au panier, arrêt avant paiement, notification", async () => {
  const t = setup();
  t.adapter.offers = [offer({ id: "b", category: "B" }), offer({ id: "a", category: "A" }), offer({ id: "cher", pricePerTicket: 999 })];
  const r = await t.run();
  assert.equal(r.status, "in-cart");
  assert.equal(r.offer?.id, "a");
  assert.equal(r.cartOk, true);
  assert.deepEqual(t.adapter.calls.filter((c) => c.startsWith("selectOffer")), ["selectOffer:a"]);
  assert.ok(t.notices.some((n) => n.includes("PANIER OBTENU")));
  assert.ok(r.timeline.some((x) => x.name === "added-to-cart"));
});

test("offre vendue entre-temps : repli sur l'offre suivante", async () => {
  const t = setup();
  t.adapter.offers = [offer({ id: "a", category: "A" }), offer({ id: "b", category: "B" })];
  t.adapter.failures.addToCart = [new OfferUnavailableError("vendu")];
  const r = await t.run();
  assert.equal(r.status, "in-cart");
  assert.equal(r.offer?.id, "b");
});

test("autoAddToCart=false : sélection sans ajout au panier", async () => {
  const t = setup({ behavior: { autoAddToCart: false } });
  t.adapter.offers = [offer({ id: "a" })];
  const r = await t.run();
  assert.equal(r.status, "ready-not-added");
  assert.ok(!t.adapter.calls.includes("addToCart"));
});

test("catégories vides = toutes les catégories acceptées", async () => {
  const t = setup({ tickets: { quantity: 2, maxPricePerTicket: 150, categories: [] } });
  t.adapter.offers = [offer({ id: "z", category: "Zone inconnue" })];
  assert.equal((await t.run()).offer?.id, "z");
});

for (const state of ["CAPTCHA", "QUEUE", "BLOCKED"] as const) {
  test(`${state} : le bot cède la main, ne réessaie qu'après la reprise humaine`, async () => {
    const t = setup();
    t.adapter.offers = [offer({ id: "a" })];
    const order: string[] = [];
    t.adapter.failures.selectOffer = [new BlockerError({ state, message: state })];
    const origSelect = t.adapter.selectOffer.bind(t.adapter);
    t.adapter.selectOffer = async (c, o) => { order.push("select"); return origSelect(c, o); };
    const agent2 = new Agent({ ...(t.agent as unknown as { d: ConstructorParameters<typeof Agent>[0] }).d, awaitHuman: async () => void order.push("human") });
    const r = await agent2.run();
    assert.equal(r.status, "in-cart");
    assert.deepEqual(order, ["select", "human", "select"]); // aucune action du bot pendant la cession
  });
}

test("limite d'achat : arrêt définitif, aucune cession de main, aucun nouvel essai", async () => {
  const t = setup();
  t.adapter.offers = [offer({ id: "a" }), offer({ id: "b", category: "B" })];
  t.adapter.failures.selectOffer = [new BlockerError({ state: "PURCHASE_LIMIT", message: "Limite de 4 billets" })];
  const r = await t.run();
  assert.equal(r.status, "blocked");
  assert.equal(r.blocker?.state, "PURCHASE_LIMIT");
  assert.equal(t.humans.length, 0);
  assert.equal(t.adapter.calls.filter((c) => c.startsWith("selectOffer")).length, 1);
  assert.ok(!t.adapter.calls.includes("addToCart"));
});

test("choix de places par l'humain : cession de la main puis poursuite jusqu'au panier", async () => {
  const t = setup();
  t.adapter.offers = [offer({ id: "a" })];
  t.adapter.selectSeats = async () => { throw new BlockerError({ state: "MANUAL_SELECTION", message: "Choisissez vos places" }); };
  const r = await t.run();
  assert.equal(r.status, "in-cart");
  assert.deepEqual(t.humans.map((h) => h.state), ["MANUAL_SELECTION"]);
});

test("adaptateur sans conformité valide ou démo hors localhost : refusé avant toute action", async () => {
  const noCompliance = new FakeAdapter();
  (noCompliance.meta as { compliance: unknown }).compliance = undefined;
  await assert.rejects(setup({}, noCompliance).run(), /conformité/);

  const demoOnRealSite = new FakeAdapter();
  await assert.rejects(setup({ event: { name: "x", url: "https://billetterie.example.com/e" } }, demoOnRealSite).run(), /localhost/);
  assert.equal(demoOnRealSite.calls.length, 0);

  const stale = new FakeAdapter();
  stale.meta = { ...stale.meta, compliance: { policy: "permitted-by-terms", termsUrl: "https://x.example/cgu", reviewedAt: "2020-01-01" } };
  await assert.rejects(setup({ event: { name: "x", url: "https://x.example/e" } }, stale).run(), /relues il y a/);
});

test("états standardisés : AVAILABLE puis CART_SUCCESS, métriques renseignées", async () => {
  const t = setup();
  t.adapter.offers = [offer({ id: "a" })];
  const r = await t.run();
  assert.equal(r.finalState, "CART_SUCCESS");
  assert.deepEqual(r.telemetry.states.map((s) => s.state), ["AVAILABLE", "CART_SUCCESS"]);
  assert.equal(r.telemetry.metrics.attempts, 1); // la tentative réussie est bien comptée
  assert.ok(r.telemetry.metrics.timeToCartMs! >= r.telemetry.metrics.timeToAvailabilityMs!);
  assert.ok((r.telemetry.metrics.polls ?? 0) >= 1);
});

test("SOLD_OUT : vente ouverte sans offre achetable → délai dépassé, raison normalisée", async () => {
  const t = setup();
  t.adapter.offers = [offer({ id: "epuise", available: 0 })];
  const r = await t.run();
  assert.equal(r.status, "sale-timeout");
  assert.equal(r.finalState, "SOLD_OUT");
  assert.equal(r.failureReason, "NO_MATCHING_OFFER");
  assert.ok(!t.adapter.calls.some((c) => c.startsWith("selectOffer")));
});

test("aucune offre ne correspond aux critères : état AVAILABLE conservé, raison NO_MATCHING_OFFER", async () => {
  const t = setup();
  t.adapter.offers = [offer({ id: "hors-budget", pricePerTicket: 999 })];
  const r = await t.run();
  assert.equal(r.finalState, "AVAILABLE");
  assert.equal(r.failureReason, "NO_MATCHING_OFFER");
});

test("erreur technique : état ERROR sans exception, message assaini dans la télémétrie", async () => {
  const t = setup();
  t.adapter.offers = [offer({ id: "a" })];
  t.adapter.failures.selectOffer = [new Error("boom https://secret.example/x?token=abc")];
  const r = await t.run();
  assert.equal(r.status, "error");
  assert.equal(r.finalState, "ERROR");
  assert.equal(r.failureReason, "ADAPTER_ERROR");
  assert.ok(!JSON.stringify(r.telemetry).includes("secret.example"));
});

test("headless + blocage : impossible de céder la main → ERROR / HUMAN_REQUIRED_HEADLESS", async () => {
  const t = setup({}, new FakeAdapter(), false);
  t.adapter.offers = [offer({ id: "a" })];
  t.adapter.failures.selectOffer = [new BlockerError({ state: "CAPTCHA", message: "captcha" })];
  const r = await t.run();
  assert.equal(r.finalState, "ERROR");
  assert.equal(r.failureReason, "HUMAN_REQUIRED_HEADLESS");
});

test("la stratégie de la config est appliquée par le cœur", async () => {
  const t = setup({ strategy: { priority: ["price"], priceOrder: "most-expensive" } });
  t.adapter.offers = [offer({ id: "eco", pricePerTicket: 50 }), offer({ id: "top", pricePerTicket: 140 })];
  assert.equal((await t.run()).offer?.id, "top");
});

test("la télémétrie est écrite localement quand elle est activée", async () => {
  const { mkdtempSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "agent-tel-"));
  const t = setup({ telemetry: { enabled: true, dir } });
  t.adapter.offers = [offer({ id: "a" })];
  const r = await t.run();
  assert.ok(r.telemetryFile?.startsWith(dir));
  assert.equal(readdirSync(dir).length, 1);
});
