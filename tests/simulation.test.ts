import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { loadConfig } from "../src/config/load.js";
import { runSimulation } from "../src/simulation/run.js";
import { listScenarios, loadScenario, ScenarioSchema } from "../src/simulation/scenario.js";
import { silentLogger } from "../src/utils/logger.js";

const config = loadConfig("concert");
const telemetryDir = mkdtempSync(join(tmpdir(), "sim-"));
const realFetch = globalThis.fetch;
const networkCalls: string[] = [];

before(() => {
  // Garantie « sans contacter un vrai site » : tout appel réseau fait échouer le test.
  globalThis.fetch = (async (input: unknown) => {
    networkCalls.push(String(input));
    throw new Error("réseau interdit en simulation");
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

test("les scénarios livrés couvrent les 10 états et sont valides", () => {
  const names = listScenarios();
  for (const n of ["nominal", "contention", "queue", "captcha", "blocked", "login-required", "manual-seats", "purchase-limit", "sold-out", "rate-limited", "clock-skew", "adapter-error"])
    assert.ok(names.includes(n), n);
  const seen = new Set(names.flatMap((n) => [loadScenario(n).expect?.finalState, ...(loadScenario(n).expect?.statesInclude ?? [])]));
  for (const s of ["AVAILABLE", "SOLD_OUT", "QUEUE", "CAPTCHA", "LOGIN_REQUIRED", "MANUAL_SELECTION", "PURCHASE_LIMIT", "BLOCKED", "CART_SUCCESS", "ERROR"])
    assert.ok(seen.has(s), `état ${s} non couvert par un scénario`);
});

for (const name of listScenarios()) {
  test(`simulation « ${name} » : résultat conforme, aucun appel réseau`, async () => {
    const scenario = loadScenario(name);
    const { result, mismatches, adapter } = await runSimulation({ config, scenario, log: silentLogger, telemetryDir });
    assert.deepEqual(mismatches, []);
    assert.equal(networkCalls.length, 0, networkCalls.join(","));
    assert.equal(result.telemetry.mode, "simulation");
    assert.ok(result.telemetryFile, "télémétrie écrite");
    // Aucune action de paiement, jamais.
    assert.ok(!adapter.calls.some((c) => /pay/i.test(c)));
  });
}

test("simulation : purchase-limit n'est jamais contournée (une seule tentative, pas de cession de main)", async () => {
  const { result, adapter, handoffs } = await runSimulation({ config, scenario: loadScenario("purchase-limit"), log: silentLogger, telemetryDir });
  assert.equal(result.status, "blocked");
  assert.equal(handoffs.length, 0);
  assert.equal(adapter.calls.filter((c) => c === "selectOffer").length, 1);
  assert.ok(!adapter.calls.includes("addToCart"));
});

test("simulation : pendant une cession de main, le bot n'agit plus sur le site", async () => {
  const { adapter, result } = await runSimulation({ config, scenario: loadScenario("captcha"), log: silentLogger, telemetryDir });
  assert.equal(result.finalState, "CART_SUCCESS");
  const calls = adapter.calls;
  // addToCart échoue (CAPTCHA) puis est rejoué après la reprise : aucun appel intermédiaire.
  const first = calls.indexOf("addToCart");
  assert.equal(calls[first + 1], "addToCart");
});

test("simulation : la synchronisation d'horloge compense l'avance du serveur", async () => {
  const { result } = await runSimulation({ config, scenario: loadScenario("clock-skew"), log: silentLogger, telemetryDir });
  assert.ok(Math.abs(result.telemetry.metrics.clockOffsetMs! - 1500) < 60, String(result.telemetry.metrics.clockOffsetMs));
});

test("simulation : la stratégie du profil pilote le choix (spectacle = meilleur prix dans le budget)", async () => {
  const scenario = ScenarioSchema.parse({
    name: "strategie",
    saleOpensAfterMs: 100,
    offers: [
      { id: "eco", category: "Orchestre", price: 40, available: 2, seats: ["1", "2"] },
      { id: "top", category: "Orchestre", price: 75, available: 2, seats: ["5", "6"], section: "Orchestre centre", row: "2" },
      { id: "trop", category: "Orchestre", price: 95, available: 2, seats: ["7", "8"] },
    ],
  });
  const { result } = await runSimulation({ config: loadConfig("spectacle"), scenario, log: silentLogger, telemetryDir });
  assert.equal(result.offer?.id, "top");
  const festival = await runSimulation({ config: loadConfig("festival"), scenario: ScenarioSchema.parse({ ...scenario, offers: [{ id: "a", category: "Pass", price: 80, available: 4 }, { id: "b", category: "Pass", price: 60, available: 4 }] }), log: silentLogger, telemetryDir });
  assert.equal(festival.result.offer?.id, "b"); // festival : moins cher d'abord, quantité 4
});
