import { loadConfig } from "../config/load.js";
import { runSimulation } from "../simulation/run.js";
import { listScenarios, loadScenario } from "../simulation/scenario.js";
import type { Logger } from "../utils/logger.js";
import { createLogger } from "../utils/logger.js";

export interface SimulateOptions {
  target?: string;
  scenario?: string;
  all: boolean;
  startInMs?: number;
  log: Logger;
  telemetryDir?: string;
}

/**
 * `npm run simulate` : exécute le vrai Core Agent contre un faux site (aucun réseau, aucun navigateur).
 * `--all` rejoue tous les scénarios de simulations/ et vérifie leur résultat attendu.
 */
export async function simulateCommand(o: SimulateOptions): Promise<number> {
  const config = loadConfig(o.target ?? "concert");
  // Les résultats attendus des scénarios livrés sont écrits pour le profil de référence « concert ».
  const enforce = (o.target ?? "concert") === "concert";
  const names = o.all ? listScenarios() : [o.scenario ?? "nominal"];
  let failures = 0;
  for (const name of names) {
    const scenario = loadScenario(name);
    // En mode --all, chaque scénario est rejoué en silence : une ligne de bilan par scénario.
    const log = o.all ? createLogger({ level: "silent" }) : o.log;
    const { result, mismatches: all, handoffs } = await runSimulation({ config, scenario, log, startInMs: o.startInMs, telemetryDir: o.telemetryDir, profile: o.target });
    const mismatches = enforce ? all : [];
    const m = result.telemetry.metrics;
    const ok = mismatches.length === 0;
    if (!ok) failures++;
    console.log(
      `${ok ? "✓" : "✗"} ${scenario.name.padEnd(16)} → ${result.finalState.padEnd(16)} tentatives=${m.attempts} passages-de-main=${handoffs.length}` +
        `${m.timeToCartMs !== null ? ` panier=T+${m.timeToCartMs}ms` : ""}${result.failureReason ? ` raison=${result.failureReason}` : ""}`,
    );
    for (const x of mismatches) console.log(`    ✗ ${x}`);
  }
  if (!enforce) console.log(`(profil « ${o.target} » : les résultats attendus des scénarios livrés sont écrits pour le profil « concert » et n'ont pas été vérifiés)`);
  if (o.all) console.log(`\n${names.length - failures}/${names.length} scénario(s) conformes.`);
  return failures ? 1 : 0;
}
