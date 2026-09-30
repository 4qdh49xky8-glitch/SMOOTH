import { existsSync } from "node:fs";
import { assessSale, formatAssessment, type AssessOptions, type SaleAssessment } from "../sale/assess.js";
import { liveCommand, type LiveDeps, type LiveOptions } from "./live.js";

/**
 * `sale:check` et `sale:wait` — mode « READY FOR SALE » générique (docs/SALE.md). Aucune des deux ne contacte la plateforme pendant
 * l'évaluation ni pendant l'attente ; seule la remise au lancement (`run`) le fait, APRÈS une dernière évaluation locale, et seulement si
 * un canal automatisé est explicitement autorisé par des preuves officielles valides.
 */
/** Fichier de vente par défaut : config/sale.yaml, .yml ou .json (le premier qui existe). */
export const defaultSaleTarget = (): string => ["config/sale.yaml", "config/sale.yml", "config/sale.json"].find((f) => existsSync(f)) ?? "config/sale.yaml";

export interface SaleCheckArgs {
  target?: string;
  json?: boolean;
  human?: boolean;
}

export async function saleCheckCommand(a: SaleCheckArgs, o: AssessOptions = {}): Promise<number> {
  const target = a.target ?? defaultSaleTarget();
  const res = await assessSale(target, { ...o, human: a.human });
  if (a.json) console.log(JSON.stringify({ ...res, config: undefined, networkRequests: 0 }, null, 2));
  else console.log(formatAssessment(res));
  return res.verdict === "READY" ? 0 : 1;
}

export interface SaleWaitArgs extends SaleCheckArgs {
  logLevel?: string;
  logFile?: string;
  exitWhenDone?: boolean;
  trace?: boolean;
  /** Intervalle de réévaluation LOCALE pendant l'attente (défaut 30 s). */
  recheckSeconds?: number;
}

export interface SaleWaitDeps {
  assess?: (target: string, o: AssessOptions) => Promise<SaleAssessment>;
  run?: (o: LiveOptions, d?: LiveDeps) => Promise<number>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  print?: (line: string) => void;
  assessOptions?: AssessOptions;
  live?: LiveDeps;
}

/** Démarrage anticipé du navigateur avant la préparation du cœur (préparation = timing.preArmSeconds avant l'ouverture). */
export const HANDOVER_LEAD_SECONDS = 60;

/**
 * Mode attente. 1) évaluation (NOT_READY → arrêt, aucun contact) ; 2) attente LOCALE jusqu'à la remise, avec réévaluation périodique :
 * si l'autorisation expire, si un verrou apparaît, si la configuration change, on s'arrête AVANT tout contact ; 3) dernière évaluation,
 * puis `run` (verrous, garde réseau, préparation, déclenchement, sélection, panier, arrêt à CART_SUCCESS — paiement manuel).
 */
export async function saleWaitCommand(a: SaleWaitArgs, d: SaleWaitDeps = {}): Promise<number> {
  const target = a.target ?? defaultSaleTarget();
  const assess = d.assess ?? assessSale;
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const print = d.print ?? ((l: string) => console.log(l));
  const run = d.run ?? liveCommand;
  const ao = (): AssessOptions => ({ ...(d.assessOptions ?? {}), human: a.human, now: d.assessOptions?.now ?? now() });

  let res = await assess(target, ao());
  print(formatAssessment(res));
  if (res.verdict !== "READY") {
    print("\nSALE WAIT : refusé (NOT_READY) — aucune attente, aucun contact avec la plateforme.");
    return 1;
  }
  const preArm = (res.config?.timing.preArmSeconds ?? 90) * 1000;
  const handoverAt = (res.startEpochMs ?? now()) - preArm - HANDOVER_LEAD_SECONDS * 1000;
  const recheckMs = Math.max(1, (a.recheckSeconds ?? 30) * 1000);

  let stopped = false;
  const onSigint = (): void => void (stopped = true);
  process.once("SIGINT", onSigint);
  let ticks = 0;
  try {
    while (now() < handoverAt && !stopped) {
      await sleep(Math.min(recheckMs, Math.max(1, handoverAt - now())));
      if (stopped) break;
      res = await assess(target, ao()); // local : relit la configuration, les preuves (expiration), les verrous
      if (res.verdict !== "READY") {
        print(formatAssessment(res));
        print("\nSALE WAIT : plus READY pendant l'attente — arrêt AVANT tout contact avec la plateforme.");
        return 1;
      }
      if (++ticks % 10 === 1 || handoverAt - now() < 5 * 60_000) print(`… attente — remise au lancement dans ${Math.max(0, Math.round((handoverAt - now()) / 1000))} s (toujours READY, aucune requête envoyée)`);
    }
    if (stopped) {
      print("Interrompu : aucune requête envoyée.");
      return 130;
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }

  res = await assess(target, ao()); // dernière vérification locale juste avant la remise
  if (res.verdict !== "READY") {
    print(formatAssessment(res));
    print("\nSALE WAIT : plus READY au moment de la remise — arrêt avant tout contact.");
    return 1;
  }
  print(`\nSALE WAIT : remise au lancement (${res.mode === "human" ? "rappels humains" : `canal ${res.channel}`}). Le bot s'arrêtera au panier ; le paiement reste manuel.`);
  const code = await run({ command: "run", target, trace: !!a.trace, exitWhenDone: !!a.exitWhenDone, logLevel: a.logLevel, logFile: a.logFile, forceHuman: a.human }, d.live);
  print(code === 0 ? (res.mode === "human" ? "SALE WAIT : terminé (mode humain)." : "CART_SUCCESS — panier obtenu. Vérifiez-le et FINALISEZ LE PAIEMENT VOUS-MÊME.") : "SALE WAIT : arrêt sans panier (voir le journal : blocage, autorisation, limite d'achat…). Rien n'a été payé.");
  return code;
}
