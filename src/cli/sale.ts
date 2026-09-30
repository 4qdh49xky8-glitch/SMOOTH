import { existsSync } from "node:fs";
import { assessSale, formatAssessment, type AssessOptions, type SaleAssessment } from "../sale/assess.js";
import { acquireEventLock, combineLocks, type EventLock } from "../utils/lock.js";
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
  /** Prise de verrou (défaut : celle de `run`). Remplaçable en test. */
  acquire?: typeof acquireEventLock;
  /** Nom de l'instance inscrit dans le verrou. */
  instance?: string;
}

/** Démarrage anticipé du navigateur avant la préparation du cœur (préparation = timing.preArmSeconds avant l'ouverture). */
export const HANDOVER_LEAD_SECONDS = 60;

/**
 * Mode attente — ATOMIQUE vis-à-vis des autres instances.
 *  1. évaluation locale (NOT_READY → arrêt, aucun contact) ;
 *  2. prise des MÊMES verrous que `run` (événement + profil de navigateur), puis nouvelle évaluation qui les vérifie ;
 *  3. attente LOCALE (aucune requête) : à chaque tranche, le verrou est renouvelé puis revérifié — perdu : arrêt immédiat, erreur explicite ;
 *     la configuration, les preuves (expiration), le canal et les hôtes sont réévalués — changement : arrêt AVANT tout contact ;
 *  4. juste avant le premier contact : évaluation COMPLÈTE (autorisation, canal, hôtes, verrou, configuration, expiration de la preuve) ;
 *  5. `run` reprend les verrous déjà détenus (aucun instant sans verrou), puis préparation, déclenchement, sélection, panier, arrêt à
 *     CART_SUCCESS — paiement manuel ;
 *  6. les verrous sont libérés dans tous les cas (succès, erreur, arrêt, interruption).
 * Le mode humain (`--human`) ne fait aucune requête et, comme `run`, ne prend pas de verrou.
 */
export async function saleWaitCommand(a: SaleWaitArgs, d: SaleWaitDeps = {}): Promise<number> {
  const target = a.target ?? defaultSaleTarget();
  const assess = d.assess ?? assessSale;
  const now = d.now ?? Date.now;
  const print = d.print ?? ((l: string) => console.log(l));
  const run = d.run ?? liveCommand;
  const acquire = d.acquire ?? acquireEventLock;
  const instance = d.instance ?? `sale-wait#${process.pid}`;

  let stopped = false;
  let wake: (() => void) | undefined;
  const sleep =
    d.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        wake = () => (clearTimeout(t), resolve());
      }));
  const onSigint = (): void => {
    stopped = true;
    wake?.();
  };

  let lock: EventLock | undefined;
  const assessNow = (): Promise<SaleAssessment> => assess(target, { ...(d.assessOptions ?? {}), human: a.human, ownLock: lock, now: now() });
  const stop = (res: SaleAssessment, why: string): number => {
    print(formatAssessment(res));
    print(`\nSALE WAIT : ${why} — arrêt AVANT tout contact avec la plateforme.`);
    return 1;
  };

  process.once("SIGINT", onSigint);
  try {
    let res = await assess(target, { ...(d.assessOptions ?? {}), human: a.human, now: now() });
    print(formatAssessment(res));
    if (res.verdict !== "READY") {
      print("\nSALE WAIT : refusé (NOT_READY) — aucune attente, aucun contact avec la plateforme.");
      return 1;
    }

    // Verrous : les mêmes que `run`, pris APRÈS les vérifications initiales et conservés jusqu'à la fin.
    let held: LiveDeps["held"];
    if (res.mode === "automatic") {
      const keys = res.lockKeys ?? [];
      const acquired: EventLock[] = [];
      try {
        for (const k of keys) acquired.push(acquire(k.key, instance, d.assessOptions?.locksDir));
      } catch (e) {
        acquired.forEach((l) => l.release());
        print(`\nSALE WAIT : verrou refusé — ${(e as Error).message}\nUne seule instance peut attendre/lancer cet événement : aucun contact avec la plateforme.`);
        return 1;
      }
      lock = combineLocks(...acquired);
      held = { lock, keys: keys.map((k) => k.key) };
      print(`Verrou acquis (${keys.map((k) => k.what).join(" + ")}) : conservé pendant toute l'attente, libéré à la fin.`);
      res = await assessNow(); // la prise du verrou n'a rien changé d'autre : tout est revérifié, verrou compris
      if (res.verdict !== "READY") return stop(res, "plus READY après la prise du verrou");
    }

    const preArm = (res.config?.timing.preArmSeconds ?? 90) * 1000;
    const handoverAt = (res.startEpochMs ?? now()) - preArm - HANDOVER_LEAD_SECONDS * 1000;
    const recheckMs = Math.max(1, (a.recheckSeconds ?? 30) * 1000);
    let ticks = 0;
    while (now() < handoverAt && !stopped) {
      await sleep(Math.min(recheckMs, Math.max(1, handoverAt - now())));
      if (stopped) break;
      if (lock && !lock.renew()) {
        print("\nSALE WAIT : ERREUR — le verrou d'événement n'est plus détenu par cette instance (supprimé ou repris) : impossible de garantir l'unicité — arrêt immédiat, AUCUN contact avec la plateforme.");
        return 1;
      }
      res = await assessNow(); // local : relit la configuration, les preuves (expiration), le canal, les hôtes ; vérifie le verrou
      if (res.verdict !== "READY") return stop(res, "plus READY pendant l'attente");
      if (++ticks % 10 === 1 || handoverAt - now() < 5 * 60_000) print(`… attente — remise au lancement dans ${Math.max(0, Math.round((handoverAt - now()) / 1000))} s (READY, verrou conservé, aucune requête envoyée)`);
    }
    if (stopped) {
      print("Interrompu : aucune requête envoyée ; verrous libérés.");
      return 130;
    }

    // Juste avant le premier contact : évaluation COMPLÈTE (autorisation, canal, hôtes, verrou, configuration, expiration de la preuve).
    if (lock && !lock.renew()) return stop(await assessNow(), "verrou perdu au moment de la remise");
    res = await assessNow();
    if (res.verdict !== "READY") return stop(res, "plus READY au moment de la remise");
    print(`\nSALE WAIT : remise au lancement (${res.mode === "human" ? "rappels humains" : `canal ${res.channel}`}). Le bot s'arrêtera au panier ; le paiement reste manuel.`);
    const code = await run({ command: "run", target, trace: !!a.trace, exitWhenDone: !!a.exitWhenDone, logLevel: a.logLevel, logFile: a.logFile, forceHuman: a.human }, { ...(d.live ?? {}), ...(held ? { held } : {}) });
    print(code === 0 ? (res.mode === "human" ? "SALE WAIT : terminé (mode humain)." : "CART_SUCCESS — panier obtenu. Vérifiez-le et FINALISEZ LE PAIEMENT VOUS-MÊME.") : "SALE WAIT : arrêt sans panier (voir le journal : blocage, autorisation, limite d'achat…). Rien n'a été payé.");
    return code;
  } finally {
    process.removeListener("SIGINT", onSigint);
    lock?.release(); // succès, erreur, arrêt ou interruption : toujours libéré
  }
}
