import { Agent, type RunResult } from "../agent/Agent.js";
import { ClaudeAssistant } from "../agent/claude.js";
import type { BotConfig } from "../config/schema.js";
import { SelectorResolver } from "../selectors/resolver.js";
import type { Blocker } from "../sites/SiteAdapter.js";
import { Clock } from "../utils/clock.js";
import type { Logger } from "../utils/logger.js";
import type { Scenario } from "./scenario.js";
import { SimulationAdapter } from "./SimulationAdapter.js";

export interface SimulationOptions {
  config: BotConfig;
  scenario: Scenario;
  log: Logger;
  /** Délai entre le lancement et l'ouverture simulée de la vente. */
  startInMs?: number;
  /** Dossier de télémétrie (mode "simulation" dans le fichier). */
  telemetryDir?: string;
  profile?: string;
}

export interface SimulationOutcome {
  result: RunResult;
  adapter: SimulationAdapter;
  handoffs: Blocker[];
  mismatches: string[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Exécute le VRAI Core Agent contre un faux site. Aucun navigateur, aucun réseau, aucune notification
 * système. La config (tickets, stratégie…) est celle de l'utilisateur ; seules l'URL, l'heure de vente
 * et les délais sont adaptés à la simulation.
 */
export async function runSimulation(o: SimulationOptions): Promise<SimulationOutcome> {
  const { scenario, log } = o;
  const saleStart = Date.now() + (o.startInMs ?? 700);
  const config: BotConfig = {
    ...o.config,
    event: { ...o.config.event, url: "http://localhost/simulation" },
    sale: { startTime: new Date(saleStart).toISOString() },
    timing: { ...o.config.timing, preArmSeconds: 0, maxWaitAfterSaleSeconds: scenario.maxWaitMs / 1000 },
    browser: { ...o.config.browser, headless: false },
    claude: { ...o.config.claude, enabled: false },
    notifications: { desktop: false, sound: false },
    telemetry: { ...o.config.telemetry, dir: o.telemetryDir ?? o.config.telemetry.dir },
  };
  const adapter = new SimulationAdapter(scenario);
  adapter.setSaleStart(saleStart);
  const handoffs: Blocker[] = [];

  const agent = new Agent({
    config,
    adapter,
    ctx: {
      config,
      context: {} as never,
      page: { bringToFront: async () => undefined } as never,
      log: log.child("sim"),
      env: {},
      selectors: new SelectorResolver("simulation", "/nonexistent/none.json"),
    },
    claude: new ClaudeAssistant(config.claude, log),
    log,
    clock: new Clock(),
    mode: "simulation",
    profile: o.profile,
    notifier: async (n) => log.info(`🔔 ${n.title} — ${n.message.replace(/\n/g, " · ")}`),
    awaitHuman: async (b) => {
      handoffs.push(b);
      log.info(`(simulation) l'humain traite « ${b.state} » pendant ${scenario.humanResolveMs} ms`);
      await sleep(scenario.humanResolveMs);
    },
  });

  const result = await agent.run();
  return { result, adapter, handoffs, mismatches: checkExpectation(scenario, result) };
}

export function checkExpectation(scenario: Scenario, result: RunResult): string[] {
  const e = scenario.expect;
  if (!e) return [];
  const out: string[] = [];
  const cmp = (label: string, want: unknown, got: unknown): void => {
    if (want !== undefined && want !== got) out.push(`${label} : attendu ${String(want)}, obtenu ${String(got)}`);
  };
  cmp("finalState", e.finalState, result.finalState);
  cmp("status", e.status, result.status);
  cmp("failureReason", e.failureReason, result.failureReason);
  cmp("attempts", e.attempts, result.telemetry.metrics.attempts);
  cmp("humanHandoffs", e.humanHandoffs, result.telemetry.metrics.humanHandoffs);
  cmp("offerId", e.offerId, result.offer?.id);
  for (const s of e.statesInclude ?? []) {
    if (!result.telemetry.states.some((x) => x.state === s)) out.push(`état ${s} jamais observé`);
  }
  return out;
}
