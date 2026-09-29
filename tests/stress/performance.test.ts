import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { Agent } from "../../src/agent/Agent.js";
import { ClaudeAssistant } from "../../src/agent/claude.js";
import { rankOffers } from "../../src/agent/matcher.js";
import { ConfigSchema, type BotConfig } from "../../src/config/schema.js";
import { SelectorResolver } from "../../src/selectors/resolver.js";
import type { Offer } from "../../src/sites/SiteAdapter.js";
import { Clock } from "../../src/utils/clock.js";
import { OfferUnavailableError } from "../../src/utils/errors.js";
import { silentLogger } from "../../src/utils/logger.js";
import { waitUntil } from "../../src/utils/scheduler.js";
import { FakeAdapter, offer } from "../helpers/fakeAdapter.js";
import { sleep } from "./harness.js";

/** Audit chiffré : boucles de polling, attentes inutiles, parallélisme, tâches de fond. */
function setup(over: Record<string, unknown> = {}, adapter = new FakeAdapter(), agentOver: Record<string, unknown> = {}) {
  const config: BotConfig = ConfigSchema.parse({
    site: "fake",
    event: { name: "T", url: "http://127.0.0.1:9/e" },
    sale: { startTime: new Date(Date.now() - 500).toISOString() },
    tickets: { quantity: 2, maxPricePerTicket: 150 },
    timing: { preArmSeconds: 0, pollIntervalMs: 200, maxWaitAfterSaleSeconds: 1 },
    notifications: { desktop: false, sound: false },
    telemetry: { enabled: false },
    ...over,
  });
  const agent = new Agent({
    config, adapter, claude: new ClaudeAssistant(config.claude, silentLogger), log: silentLogger, clock: new Clock(),
    notifier: async () => undefined,
    ctx: { config, context: {} as never, page: { bringToFront: async () => undefined } as unknown as Page, log: silentLogger, env: {}, selectors: new SelectorResolver("fake", "/nonexistent/x.json") },
    ...agentOver,
  });
  return { adapter, agent };
}

test("classement : 2 000 offres classées en quelques millisecondes (clés calculées une fois par offre)", () => {
  const offers: Offer[] = Array.from({ length: 2000 }, (_, i) => offer({ id: `o${i}`, category: `Cat ${i % 7}`, pricePerTicket: 20 + (i % 130), seatsTogether: i % 3 === 0 ? true : i % 3 === 1 ? false : "unknown", section: `S${i % 11}`, row: String(i % 40) }));
  const cfg = ConfigSchema.parse({ site: "x", event: { name: "e" }, sale: { startTime: "2030-01-01T00:00:00Z" }, tickets: { quantity: 2, maxPricePerTicket: 150, categories: [] }, strategy: { priority: ["seatsTogether", "category", "placement", "price", "fit"], placement: { preferSections: ["S3"], rowPreference: "front" } } });
  rankOffers(offers, cfg.tickets, cfg.strategy); // échauffement
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) rankOffers(offers, cfg.tickets, cfg.strategy);
  const perRun = (performance.now() - t0) / 10;
  assert.ok(perRun < 25, `${perRun.toFixed(1)} ms par classement de 2000 offres`);
});

test("attente jusqu'à l'ouverture : pas d'attente active (CPU quasi nul), déclenchement précis", async () => {
  const clock = new Clock();
  const cpu0 = process.cpuUsage();
  const target = clock.now() + 600;
  const overshoot = await waitUntil(target, clock, { spinThresholdMs: 25 });
  const cpuMs = (process.cpuUsage(cpu0).user + process.cpuUsage(cpu0).system) / 1000;
  assert.ok(cpuMs < 120, `${cpuMs.toFixed(0)} ms de CPU pour 600 ms d'attente`);
  assert.ok(overshoot < 15, `dépassement ${overshoot.toFixed(1)} ms`);
});

test("cadence de surveillance : une lecture toutes les ~200 ms, pas plus (pas de boucle agressive)", async () => {
  const t = setup({ timing: { preArmSeconds: 0, pollIntervalMs: 200, pollJitterMs: 0, maxWaitAfterSaleSeconds: 1 } });
  t.adapter.saleOpen = false; // la vente n'ouvre jamais : on mesure uniquement la boucle de lecture
  await t.agent.run();
  const polls = t.adapter.count("fetchSale");
  assert.ok(polls >= 3 && polls <= 6, `${polls} lectures en 1 s à 200 ms d'intervalle`);
});

test("lecture de disponibilité et lecture de l'état de la page : en parallèle, sans latence ajoutée", async () => {
  const t = setup({ timing: { preArmSeconds: 0, pollIntervalMs: 200, maxWaitAfterSaleSeconds: 1 } });
  t.adapter.latency = { fetchSale: 80, detectBlocker: 80 };
  t.adapter.offers = [offer({ id: "a" })];
  await t.agent.run();
  const f = t.adapter.timeline.find((x) => x.name === "fetchSale")!;
  const d = t.adapter.timeline.find((x) => x.name === "detectBlocker")!;
  assert.ok(Math.abs(f.start - d.start) < 15, "les deux lectures démarrent ensemble");
  assert.ok(f.end - f.start < 130 && d.end - d.start < 130, "chaque lecture prend ~80 ms, pas 160 ms (non séquentielles)");
});

test("notification non bloquante : un notifieur lent (webhook) ne retarde ni la lecture du panier ni l'arrêt du bot", async () => {
  let notifStart = 0;
  const t = setup({ timing: { preArmSeconds: 0, pollIntervalMs: 200, maxWaitAfterSaleSeconds: 2 } }, new FakeAdapter(), {
    notifier: async () => {
      notifStart ||= performance.now();
      await sleep(700); // webhook lent
    },
  });
  t.adapter.offers = [offer({ id: "a" })];
  const started = performance.now();
  const r = await t.agent.run();
  const add = t.adapter.timeline.find((x) => x.name === "addToCart")!;
  const read = t.adapter.timeline.find((x) => x.name === "readCart")!;
  assert.equal(r.finalState, "CART_SUCCESS");
  assert.ok(read.start - add.end < 100, `lecture du panier ${(read.start - add.end).toFixed(0)} ms après l'ajout (elle attendait la notification)`);
  assert.ok(notifStart > 0 && notifStart <= add.end + 50, "la notification part dès l'ajout, avant la vérification");
  assert.ok(performance.now() - started >= 650, "mais le bot attend la fin de l'envoi avant de rendre la main");
});

test("cession de la main : la détection de fond est stoppée à la reprise (aucune lecture de page concurrente ensuite)", async () => {
  const adapter = new FakeAdapter();
  adapter.offers = [offer({ id: "a" })];
  adapter.blocker = { state: "QUEUE", message: "file" };
  let release!: () => void;
  const t = setup({ timing: { preArmSeconds: 0, pollIntervalMs: 200, maxWaitAfterSaleSeconds: 3 } }, adapter, {
    awaitHuman: undefined,
    waitForEnter: () => ({ promise: new Promise<void>((r) => (release = r)), cancel: () => undefined }),
  });
  const run = t.agent.run();
  await sleep(250); // la détection automatique tourne (une lecture toutes les 500 ms)
  adapter.blocker = null;
  release(); // l'humain confirme avant que la détection automatique ne conclue
  const r = await run;
  assert.equal(r.finalState, "CART_SUCCESS");
  const after = adapter.count("detectBlocker");
  await sleep(1300); // > 2 cycles de détection de fond : un reliquat aurait continué à lire la page
  assert.equal(adapter.count("detectBlocker"), after, "boucle de détection encore active après la reprise");
});

test("offre signalée indisponible : elle n'est pas martelée à chaque lecture (délai de grâce)", async () => {
  const t = setup({ timing: { preArmSeconds: 0, pollIntervalMs: 200, pollJitterMs: 0, maxWaitAfterSaleSeconds: 2 } });
  t.adapter.offers = [offer({ id: "perimee" })]; // la liste reste périmée : l'offre y figure toujours
  t.adapter.failures.selectOffer = Array.from({ length: 20 }, () => new OfferUnavailableError("vendue"));
  const r = await t.agent.run();
  assert.equal(t.adapter.calls.filter((c) => c.startsWith("selectOffer")).length, 1, "une seule tentative en 2 s (délai de grâce 3 s)");
  assert.equal(r.failureReason, "NO_MATCHING_OFFER");
  assert.ok(t.adapter.count("fetchSale") >= 5, "la surveillance continue pendant ce temps");
});

test("aucune activité résiduelle après l'arrêt : ni lecture, ni tâche de fond", async () => {
  const t = setup({ timing: { preArmSeconds: 0, pollIntervalMs: 200, maxWaitAfterSaleSeconds: 3 } });
  t.adapter.offers = [offer({ id: "a" })];
  await t.agent.run();
  const n = t.adapter.timeline.length;
  await sleep(900);
  assert.equal(t.adapter.timeline.length, n);
});

test("panne de lecture persistante : attente exponentielle et logs espacés (pas de martèlement à cadence fixe)", async () => {
  const lines: string[] = [];
  const adapter = new FakeAdapter();
  let calls = 0;
  adapter.fetchSale = async () => {
    calls++;
    throw new Error("réseau coupé");
  };
  const t = setup({ timing: { preArmSeconds: 0, pollIntervalMs: 200, pollJitterMs: 0, maxWaitAfterSaleSeconds: 3 } }, adapter, {
    log: (await import("../../src/utils/logger.js")).createLogger({ level: "warn", sink: (_l, line) => lines.push(line) }),
  });
  const r = await t.agent.run();
  // 3 s : sans backoff ~15 tentatives ; avec 200, 400, 800, 1600 ms → 4 à 5.
  assert.ok(calls <= 6, `${calls} tentatives en 3 s`);
  assert.ok(lines.filter((l) => l.includes("Lecture de la vente")).length <= 4, `${lines.length} lignes de log`);
  assert.equal(r.status, "sale-timeout");
});

test("page occupée (lecture d'état qui ne répond pas) : la surveillance n'est pas gelée", async () => {
  const adapter = new FakeAdapter();
  adapter.offers = [offer({ id: "a" })];
  adapter.detectBlocker = () => new Promise(() => undefined); // ne répond jamais
  const t = setup({ timing: { preArmSeconds: 0, pollIntervalMs: 200, maxWaitAfterSaleSeconds: 3 } }, adapter);
  const started = performance.now();
  const r = await t.agent.run();
  assert.equal(r.finalState, "CART_SUCCESS");
  assert.ok(performance.now() - started < 1500, "le panier est obtenu malgré la page occupée (délai borné à 250 ms)");
});
