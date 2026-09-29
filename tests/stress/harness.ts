import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/load.js";
import { runSimulation, type SimulationOptions, type SimulationOutcome } from "../../src/simulation/run.js";
import { CANARIES, loadScenario, type Scenario } from "../../src/simulation/scenario.js";
import type { TelemetryRecord } from "../../src/telemetry/Telemetry.js";
import { createLogger } from "../../src/utils/logger.js";

/** Secrets factices que le faux site laisse fuiter dans ses messages d'erreur : ils ne doivent apparaître nulle part. */
export const SECRETS = [CANARIES.token, CANARIES.session, CANARIES.email, CANARIES.card, "hunter2secret"];

export interface StressOutcome extends SimulationOutcome {
  /** Toutes les lignes de log, tous niveaux confondus (DEBUG inclus). */
  logs: string[];
  telemetryFile: string;
  telemetryText: string;
  record: TelemetryRecord;
  scenario: Scenario;
}

export interface StressOptions {
  profile?: string;
  startInMs?: number;
  /** Modifie le scénario chargé (ex. mélanger l'ordre des offres). */
  mutate?: (s: Scenario) => Scenario;
  agentOverrides?: SimulationOptions["agentOverrides"];
  onAdapter?: SimulationOptions["onAdapter"];
  telemetryDir?: string;
  scope?: string;
}

/** Exécute un scénario `simulations/stress/<name>.json` avec capture complète des logs. */
export async function runStress(name: string, opts: StressOptions = {}): Promise<StressOutcome> {
  let scenario = loadScenario(`stress/${name}`);
  scenario = { ...scenario, leakCanaries: true };
  if (opts.mutate) scenario = opts.mutate(scenario);
  const logs: string[] = [];
  const log = createLogger({ level: "debug", scope: opts.scope, sink: (_l, line) => logs.push(line) });
  const telemetryDir = opts.telemetryDir ?? mkdtempSync(join(tmpdir(), "stress-"));
  const out = await runSimulation({
    config: loadConfig(opts.profile ?? "concert"),
    scenario,
    log,
    startInMs: opts.startInMs ?? 600,
    telemetryDir,
    profile: opts.profile ?? "concert",
    agentOverrides: opts.agentOverrides,
    onAdapter: opts.onAdapter,
  });
  const file = out.result.telemetryFile!;
  assert.ok(file, "la télémétrie doit être écrite");
  const telemetryText = readFileSync(file, "utf8");
  void readdirSync;
  return { ...out, logs, telemetryFile: file, telemetryText, record: JSON.parse(telemetryText) as TelemetryRecord, scenario };
}

/** Aucun secret factice dans les logs, les notifications ni la télémétrie. */
export function assertNoSensitiveData(o: Pick<StressOutcome, "logs" | "notifications" | "telemetryText">, label = ""): void {
  const haystacks: [string, string][] = [
    ["logs", o.logs.join("\n")],
    ["notifications", o.notifications.map((n) => `${n.title}\n${n.message}`).join("\n")],
    ["télémétrie", o.telemetryText],
  ];
  for (const [where, text] of haystacks)
    for (const secret of SECRETS) assert.ok(!text.includes(secret), `${label} : « ${secret} » présent dans ${where}`);
  assert.ok(!/https?:\/\/[^\s]*\?[^\s]*(token|sid)=/i.test(o.logs.join("\n")), `${label} : URL avec paramètres sensibles dans les logs`);
}

export interface Expectation {
  status: string;
  finalState: string;
  offerId?: string;
  failureReason?: string;
  attempts: number;
}

/** Les six vérifications communes : état final, offre, raison, tentatives, télémétrie, absence de données sensibles. */
export function expectRun(o: StressOutcome, e: Expectation, label: string): void {
  const r = o.result;
  assert.equal(r.finalState, e.finalState, `${label} : état final`);
  assert.equal(r.status, e.status, `${label} : status`);
  assert.equal(r.offer?.id, e.offerId, `${label} : offre choisie`);
  assert.equal(r.failureReason, e.failureReason, `${label} : raison de l'échec`);
  assert.equal(r.telemetry.metrics.attempts, e.attempts, `${label} : tentatives`);
  // Télémétrie : fichier cohérent avec le résultat, sans donnée personnelle.
  const t = o.record;
  assert.equal(t.finalState, e.finalState, `${label} : télémétrie.finalState`);
  assert.equal(t.failureReason, e.failureReason, `${label} : télémétrie.failureReason`);
  assert.equal(t.metrics.attempts, e.attempts, `${label} : télémétrie.attempts`);
  assert.equal(t.attemptsDetail.length, e.attempts, `${label} : détail des tentatives`);
  assert.equal(t.mode, "simulation");
  assert.ok(o.telemetryText.length < 20_000, "télémétrie compacte");
  assert.ok(!/@|https?:\/\//.test(o.telemetryText), `${label} : URL ou e-mail dans la télémétrie`);
  assertNoSensitiveData(o, label);
}

/** Étapes d'action du site appelées dans l'intervalle [from, to[ (epoch ms). */
export function actionsBetween(o: Pick<StressOutcome, "adapter">, from: number, to: number): string[] {
  return o.adapter.callLog.filter((c) => ["selectOffer", "selectSeats", "addToCart"].includes(c.step) && c.at >= from && c.at < to).map((c) => c.step);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
