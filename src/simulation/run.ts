import { Agent, type AgentDeps, type RunResult } from "../agent/Agent.js";
import { ClaudeAssistant } from "../agent/claude.js";
import { AUTO_DETECTABLE } from "../agent/states.js";
import { deepMerge } from "../config/load.js";
import { ConfigSchema, type BotConfig } from "../config/schema.js";
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
  /** Remplace des dépendances de l'agent (tests : attente humaine réelle, notifier, etc.). Une clé à `undefined` retire la valeur par défaut. */
  agentOverrides?: Partial<AgentDeps>;
  /** Appelé dès que l'adaptateur simulé existe (permet d'observer un run en cours). */
  onAdapter?: (adapter: SimulationAdapter) => void;
}

export interface SimulationOutcome {
  result: RunResult;
  adapter: SimulationAdapter;
  handoffs: Blocker[];
  /** Ce que l'agent a effectivement transmis au notifier (après assainissement). */
  notifications: { title: string; message: string }[];
  /** Epoch ms de l'ouverture simulée. */
  saleStart: number;
  mismatches: string[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Exécute le VRAI Core Agent contre un faux site. Aucun navigateur, aucun réseau, aucune notification
 * système. La config (tickets, stratégie…) est celle de l'utilisateur, surchargée par `scenario.config` ;
 * seules l'URL, l'heure de vente et les délais sont adaptés à la simulation.
 */
export async function runSimulation(o: SimulationOptions): Promise<SimulationOutcome> {
  const { scenario, log } = o;
  const saleStart = Date.now() + (o.startInMs ?? 700);
  const base = scenario.config ? ConfigSchema.parse(deepMerge(o.config, scenario.config)) : o.config;
  const config: BotConfig = {
    ...base,
    event: { ...base.event, url: "http://localhost/simulation" },
    sale: { startTime: new Date(saleStart).toISOString() },
    timing: { ...base.timing, preArmSeconds: 0, maxWaitAfterSaleSeconds: scenario.maxWaitMs / 1000 },
    browser: { ...base.browser, headless: !scenario.humanAvailable },
    claude: { ...base.claude, enabled: false },
    notifications: { desktop: false, sound: false },
    telemetry: { ...base.telemetry, dir: o.telemetryDir ?? base.telemetry.dir },
  };
  const adapter = new SimulationAdapter(scenario);
  adapter.setSaleStart(saleStart);
  o.onAdapter?.(adapter);
  const handoffs: Blocker[] = [];
  const notifications: { title: string; message: string }[] = [];

  const deps: AgentDeps = {
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
    notifier: async (n) => {
      notifications.push({ title: n.title, message: n.message });
      log.info(`🔔 ${n.title} — ${n.message.replace(/\n/g, " · ")}`);
    },
    // Humain simulé : pour file/CAPTCHA/anti-bot il attend aussi la disparition du blocage, comme dans la vraie détection.
    awaitHuman: scenario.humanAvailable
      ? async (b) => {
          handoffs.push(b);
          log.info(`(simulation) l'humain traite « ${b.state} » pendant au moins ${scenario.humanResolveMs} ms`);
          await sleep(scenario.humanResolveMs);
          if (AUTO_DETECTABLE.includes(b.state)) while (await adapter.detectBlocker()) await sleep(25);
        }
      : undefined,
    ...o.agentOverrides,
  };

  const result = await new Agent(deps).run();
  return { result, adapter, handoffs, notifications, saleStart, mismatches: checkExpectation(scenario, result) };
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
