import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Agent } from "../src/agent/Agent.js";
import { ClaudeAssistant } from "../src/agent/claude.js";
import { ConfigSchema } from "../src/config/schema.js";
import { SelectorResolver } from "../src/selectors/resolver.js";
import { STAGE_NAMES } from "../src/telemetry/Telemetry.js";
import { Clock } from "../src/utils/clock.js";
import { silentLogger } from "../src/utils/logger.js";
import { FakeAdapter, offer } from "./helpers/fakeAdapter.js";

/** Mesures séparées par étape, sans secret ; en simulation elles ne disent RIEN de la vitesse d'un achat réel. */
const run = async (mode: "live" | "simulation", configure?: (a: FakeAdapter) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "stages-"));
  const a = new FakeAdapter();
  a.offers = [offer({ id: "a" })];
  a.latency = { fetchSale: 5, selectOffer: 12, addToCart: 20, readCart: 8 };
  configure?.(a);
  const config = ConfigSchema.parse({
    site: "fake", event: { name: "T", url: "http://127.0.0.1:9/event" }, sale: { startTime: new Date(Date.now() + 300).toISOString() }, tickets: { quantity: 2, maxPricePerTicket: 150 },
    timing: { preArmSeconds: 0, pollIntervalMs: 200, maxWaitAfterSaleSeconds: 3 }, notifications: { desktop: false, sound: false }, telemetry: { enabled: true, dir }, browser: { headless: true },
  });
  const result = await new Agent({
    config, adapter: a, mode, browserStartMs: 321.4, claude: new ClaudeAssistant(config.claude, silentLogger), log: silentLogger, clock: new Clock(), notifier: async () => undefined,
    ctx: { config, context: {} as never, page: { bringToFront: async () => undefined } as never, log: silentLogger, env: {}, selectors: new SelectorResolver("fake", "/nonexistent/x.json") },
  }).run();
  const file = readdirSync(dir)[0]!;
  return { result, text: readFileSync(join(dir, file), "utf8") };
};

test("télémétrie : browser_start, page_ready, availability_detected, decision, selection, cart_request, cart_confirmed — mesurés séparément", async () => {
  const { result, text } = await run("live");
  assert.equal(result.finalState, "CART_SUCCESS");
  const rec = JSON.parse(text) as { stagesMs: Record<string, number | null>; mode: string };
  assert.deepEqual(Object.keys(rec.stagesMs), [...STAGE_NAMES]);
  for (const n of STAGE_NAMES) assert.equal(typeof rec.stagesMs[n], "number", `étape non mesurée : ${n}`);
  assert.equal(rec.stagesMs.browser_start, 321.4, "fournie par l'appelant (durée réelle d'ouverture du navigateur)");
  assert.ok(rec.stagesMs.selection! >= 10 && rec.stagesMs.cart_request! >= 18 && rec.stagesMs.cart_confirmed! >= 6, JSON.stringify(rec.stagesMs));
  assert.ok(rec.stagesMs.decision! < 50, "la décision est locale et quasi instantanée");
  assert.equal(rec.mode, "live");
});

test("étapes non atteintes → null (pas de valeur inventée) ; aucune donnée sensible dans le fichier", async () => {
  const { result, text } = await run("simulation", (a) => void (a.saleOpen = false));
  assert.notEqual(result.finalState, "CART_SUCCESS");
  const rec = JSON.parse(text) as { stagesMs: Record<string, number | null>; mode: string };
  for (const n of ["availability_detected", "decision", "selection", "cart_request", "cart_confirmed"]) assert.equal(rec.stagesMs[n], null, n);
  assert.equal(rec.mode, "simulation", "un run simulé est marqué tel quel : ses durées ne sont jamais une vitesse d'achat réelle");
  assert.ok(!/https?:\/\/|@|cookie|token|secret/i.test(text));
});
