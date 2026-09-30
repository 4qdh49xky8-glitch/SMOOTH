import "dotenv/config";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { doctorCommand } from "./cli/doctor.js";
import { liveCommand, type LiveDeps } from "./cli/live.js";
import { saleInstantCommand } from "./cli/instant.js";
import { saleCheckCommand, saleWaitCommand } from "./cli/sale.js";
import { simulateCommand } from "./cli/simulate.js";
import { sitesCommand } from "./cli/sites.js";
import { platformCommand } from "./cli/platform.js";
import { platformsCommand } from "./cli/platforms.js";
import { statsCommand } from "./cli/stats.js";
import { validateCommand } from "./cli/validate.js";
import { listProfiles, PROFILES_DIR } from "./config/load.js";
import { validateConfig } from "./config/validate.js";
import { createLogger, parseLogLevel } from "./utils/logger.js";

const USAGE = `Usage : npm run <commande> -- [options]   (ou : tsx src/index.ts <commande> [options])

Adaptateurs et configuration
  sites                          Liste les adaptateurs, leur base d'autorisation et l'état du contrat   (npm run sites)
  validate [fichier|profil]      Valide une configuration sans contacter aucun site                    (npm run validate -- config/event.json)
  validate --all                 Valide tous les profils de ${PROFILES_DIR}/
  profiles                       Liste les profils disponibles
  doctor                         Diagnostic local : Node, Chromium, config, adaptateurs, preuves, expiration, environnement, permissions  (npm run doctor)
  platform <verify|template|check|add|history>   Preuves officielles : ce qui manque, modèle, validation, dépôt, historique   (npm run platform verify)
  sale check                     READY / NOT_READY d'une vente, sans contacter la plateforme           (npm run sale:check -- --config sale.yaml)
  sale wait                      Mode attente : contrôle, attente locale, remise au lancement → panier (npm run sale:wait -- --config sale.yaml)
                                 --human : rappels seulement, aucun automatisme
  sale instant                   INSTANT-ON-SALE : tout est préparé avant T0, chemin critique minimal jusqu'au panier (npm run sale:instant -- --config sale.yaml)
  platforms                      Tableau interne des plateformes candidates (preuves officielles, verdicts)  (npm run platforms)
                                 --check : cohérence du catalogue · --hosts : domaines officiels à autoriser · --json

Exécution
  run                            Attend l'ouverture, met au panier, notifie, s'arrête avant le paiement (npm start)
  login                          Ouvre le navigateur pour vous connecter à la main (profil conservé)
  check                          Valide la config, la conformité et mesure l'horloge du site
  simulate                       Rejoue le vrai cœur contre un faux site (aucun réseau)                  (npm run simulate)
  stats                          Agrégats de la télémétrie locale

Options : --config <fichier> | --profile <nom>   --log-level error|warn|info|debug   --log-file <fichier>
          --scenario <nom> | --all   --start-in <ms>   --json   --trace   --exit-when-done   --dir <runs>`;

export async function main(argv: string[] = process.argv.slice(2), deps: LiveDeps = {}): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      profile: { type: "string" },
      "log-level": { type: "string" },
      "log-file": { type: "string" },
      scenario: { type: "string" },
      "start-in": { type: "string" },
      dir: { type: "string", default: "runs" },
      all: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      trace: { type: "boolean", default: false },
      "exit-when-done": { type: "boolean", default: false },
      mode: { type: "string" },
      check: { type: "boolean", default: false },
      hosts: { type: "boolean", default: false },
      markdown: { type: "boolean", default: false },
      topic: { type: "string" },
      human: { type: "boolean", default: false },
      "recheck-seconds": { type: "string" },
    },
  });
  const [command, arg] = positionals;
  const target = values.config ?? values.profile ?? arg;

  switch (command) {
    case "sites":
      return sitesCommand({ json: values.json });
    case "validate":
      return validateCommand(target, { all: values.all, json: values.json });
    case "doctor":
      return doctorCommand({ json: values.json });
    case "platform":
      return platformCommand({ sub: arg, target: positionals[2], topic: values.topic, json: values.json });
    case "platforms":
      return platformsCommand({ json: values.json, check: values.check, hosts: values.hosts, markdown: values.markdown });
    case "sale": {
      const common = { target: values.config ?? values.profile ?? positionals[2], json: values.json, human: values.human };
      if (arg === "check") return saleCheckCommand(common);
      if (arg === "wait")
        return saleWaitCommand({ ...common, logLevel: values["log-level"], logFile: values["log-file"], exitWhenDone: values["exit-when-done"], trace: values.trace, recheckSeconds: values["recheck-seconds"] ? Number(values["recheck-seconds"]) : undefined }, { live: deps });
      if (arg === "instant")
        return saleInstantCommand({ target: common.target, logLevel: values["log-level"], logFile: values["log-file"], exitWhenDone: values["exit-when-done"], recheckSeconds: values["recheck-seconds"] ? Number(values["recheck-seconds"]) : undefined, human: values.human }, { live: deps });
      console.log("Usage : sale check|wait|instant [--config <fichier>] [--human (check|wait)] [--json]");
      return 1;
    }
    case "profiles": {
      const names = listProfiles();
      for (const n of names) {
        const r = await validateConfig(n);
        console.log(`${r.ok ? "✓" : "✗"} ${n.padEnd(12)} ${r.config ? `${r.config.event.name} — site « ${r.config.site} »` : r.errors[0]}`);
      }
      if (!names.length) console.log(`Aucun profil dans ${PROFILES_DIR}/`);
      return 0;
    }
    case "simulate":
      return simulateCommand({
        target,
        scenario: values.scenario,
        all: values.all,
        startInMs: values["start-in"] ? Number(values["start-in"]) : undefined,
        log: createLogger({ level: parseLogLevel(values["log-level"]), file: values["log-file"] }),
        telemetryDir: values.dir === "runs" ? undefined : values.dir,
      });
    case "stats":
      return statsCommand(values.dir, { json: values.json, mode: values.mode });
    case "run":
    case "login":
    case "check":
      return liveCommand(
        {
          command,
          target,
          trace: values.trace,
          exitWhenDone: values["exit-when-done"],
          logLevel: values["log-level"],
          logFile: values["log-file"],
        },
        deps,
      );
    default:
      console.log(USAGE);
      return command ? 1 : 0;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error((err as Error).message);
      process.exit(1);
    },
  );
}
