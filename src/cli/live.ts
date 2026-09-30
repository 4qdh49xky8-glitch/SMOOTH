import { basename } from "node:path";
import { Agent } from "../agent/Agent.js";
import { resolveChannel } from "../agent/channels.js";
import { ClaudeAssistant } from "../agent/claude.js";
import { runHumanAssist } from "../agent/humanAssist.js";
import { createApiContext } from "../api/BaseApiAdapter.js";
import { installNetworkGuards } from "../browser/guards.js";
import { traceSlowRequests, tuneNetwork } from "../browser/cdp.js";
import { defaultUserDataDir, openBrowser, type BrowserSession } from "../browser/launch.js";
import { loadConfig, profileName, resolveConfigPath } from "../config/load.js";
import { assertAuthorized, assertNetworkAllowed, platformHosts } from "../platforms/authorize.js";
import { loadCatalog, type Catalog } from "../platforms/catalog.js";
import { SelectorResolver } from "../selectors/resolver.js";
import { assertCompliant } from "../sites/compliance.js";
import { discoverAdapters } from "../sites/registry.js";
import type { AdapterContext, SiteAdapter } from "../sites/SiteAdapter.js";
import { Clock, estimateOffset } from "../utils/clock.js";
import { lockKeysFor } from "../sale/lockKeys.js";
import { acquireEventLock, combineLocks, type EventLock } from "../utils/lock.js";
import { createLogger, pickLevel } from "../utils/logger.js";
import { trackSecretEnv } from "../utils/redact.js";
import { waitForEnter } from "../utils/prompt.js";

export interface LiveOptions {
  command: "run" | "login" | "check";
  target?: string;
  trace: boolean;
  exitWhenDone: boolean;
  logLevel?: string;
  logFile?: string;
  /** Mode humain explicite (sale:wait --human) : ne fait que restreindre le canal, jamais l'élargir. */
  forceHuman?: boolean;
}

/** Dépendances remplaçables (tests) : adaptateurs et catalogue. Par défaut : src/sites/ et platforms/. */
export interface LiveDeps {
  adapters?: SiteAdapter[];
  catalog?: Catalog;
  /**
   * Verrous DÉJÀ détenus par cette instance (`sale:wait` les conserve pendant toute l'attente) : `run` les reprend au lieu de les
   * reprendre à zéro — aucun instant sans verrou entre l'attente et le lancement. Ce n'est qu'un transfert de propriété : les clés doivent
   * être exactement celles que `run` calcule (sinon refus), et `run` les libère à la fin. Ne donne aucune autorisation.
   */
  held?: { lock: EventLock; keys: string[] };
}

/** Commandes qui pilotent une session : run, login, check. */
export async function liveCommand(o: LiveOptions, deps: LiveDeps = {}): Promise<number> {
  const target = o.target ?? "config/event.json";
  const loaded = loadConfig(target);
  const config = o.forceHuman ? { ...loaded, channel: "human" as const } : loaded;
  // Identité de l'instance : nom du profil + PID. Elle préfixe les logs et nomme le navigateur (un profil = un navigateur).
  const profile = profileName(resolveConfigPath(target));
  const instance = `${profile}#${process.pid}`;
  const logFile = (o.logFile ?? config.logging.file)?.replaceAll("{profile}", profile).replaceAll("{pid}", String(process.pid));
  const log = createLogger({ level: pickLevel(o.logLevel, process.env.LOG_LEVEL, config.logging.level), file: logFile, scope: instance });

  // Choix du canal : API officielle → navigateur → intervention humaine, selon les adaptateurs déclarés et les PREUVES du catalogue.
  const catalog = deps.catalog ?? loadCatalog();
  const decision = resolveChannel({ platform: config.site, adapters: deps.adapters ?? (await discoverAdapters()), catalog, env: process.env, config });
  log.info(`Canal retenu : ${decision.channel}${decision.adapter ? ` (adaptateur « ${decision.adapter.meta.id} »)` : ""} — ${decision.reasons.join("; ")}`);
  for (const r of decision.rejected) log.info(`Canal écarté : ${r.adapter} (${r.channel}) — ${r.reason}`);

  if (decision.channel === "human") {
    // Aucun navigateur, aucune requête vers le site : seulement des rappels. C'est vous qui achetez.
    if (o.command !== "run") {
      log.warn("Canal humain : aucune session n'est pilotée (ni connexion, ni contrôle) pour cette plateforme.");
      return 0;
    }
    await runHumanAssist({
      eventName: config.event.name,
      eventUrl: config.event.url,
      saleEpochMs: Date.parse(config.sale.startTime),
      clock: new Clock(),
      log: log.child("human"),
      reason: decision.reasons.join("; "),
      quantity: config.tickets.quantity,
      maxPricePerTicket: config.tickets.maxPricePerTicket,
    });
    return 0;
  }

  const adapter = decision.adapter!;
  trackSecretEnv(...(adapter.meta.requires?.env ?? []));
  // Défense en profondeur : même si le choix de canal était contourné, on revérifie l'autorisation, le canal et les HÔTES
  // (URL de l'événement, hôtes de l'adaptateur) AVANT d'ouvrir quoi que ce soit ou d'émettre la moindre requête.
  assertAuthorized(adapter.meta, catalog);
  assertCompliant(adapter.meta, adapter.resolveEventUrl(config));
  assertNetworkAllowed(adapter, config, catalog);
  const hosts = platformHosts(adapter.meta, catalog);

  // Un seul bot par événement ET par profil de navigateur, pour TOUTE commande qui pilote une session (run, login, check) :
  // deux instances multiplieraient les sessions et les paniers (et partageraient un navigateur).
  const userDataDir = config.browser.userDataDir ?? defaultUserDataDir(profile);
  const locks: EventLock[] = [];
  let lock: EventLock | undefined;
  process.once("SIGINT", () => process.exit(130)); // déclenche 'exit' : les verrous sont libérés
  try {
    const wanted = lockKeysFor(adapter, config, decision.channel, profile).map((k) => k.key);
    if (deps.held) {
      const missing = wanted.filter((k) => !deps.held!.keys.includes(k));
      if (missing.length || deps.held.keys.length !== wanted.length) {
        deps.held.lock.release();
        throw new Error("Les verrous détenus ne correspondent plus à l'événement/profil à lancer (configuration modifiée) : lancement refusé.");
      }
      if (!deps.held.lock.verify()) throw new Error("Le verrou d'événement n'est plus détenu par cette instance : lancement refusé.");
      lock = deps.held.lock;
      locks.push(lock);
    } else {
      for (const k of wanted) locks.push(acquireEventLock(k, instance));
      lock = combineLocks(...locks);
    }

    // Canal API : aucun navigateur. Canal navigateur : un navigateur par profil.
    const t0 = performance.now();
    const session: BrowserSession | undefined = decision.channel === "browser" ? await openBrowser(config, log.child("browser"), { userDataDir }) : undefined;
    const browserStartMs = session ? performance.now() - t0 : undefined;
    // Garde réseau AVANT toute navigation (login, check et run) : paiement interdit, navigations limitées aux domaines autorisés.
    const releaseGuard = session ? await installNetworkGuards(session.context, { paymentPatterns: adapter.paymentUrlPatterns, allowedHosts: hosts, log: log.child("guard") }) : async () => undefined;
    const ctx: AdapterContext = session
      ? { config, context: session.context, page: session.page, log: log.child(`site:${adapter.meta.id}`), env: process.env, selectors: new SelectorResolver(adapter.meta.id) }
      : createApiContext(config, log.child(`site:${adapter.meta.id}`), process.env);

    if (o.command === "login") {
      if (!session) {
        log.info("Canal API : aucune connexion manuelle ; les identifiants officiels se fournissent par variables d'environnement (voir meta.requires.env).");
        return 0;
      }
      await session.page.goto(adapter.resolveEventUrl(config));
      log.info("Connectez-vous dans la fenêtre. Le profil (cookies) est conservé pour les prochains runs.");
      await waitForEnter("Appuyez sur Entrée quand vous êtes connecté.").promise;
      await releaseGuard();
      await session.detach();
      return 0;
    }

    if (o.command === "check") {
      log.info(`Configuration valide. Ouverture : ${config.sale.startTime} (dans ${((Date.parse(config.sale.startTime) - Date.now()) / 60000).toFixed(1)} min)`);
      log.info(`Adaptateur « ${adapter.meta.displayName} » — capacités : ${JSON.stringify(adapter.meta.capabilities)}`);
      if (adapter.getServerTime) {
        const est = await estimateOffset(() => adapter.getServerTime!(ctx));
        log.info(`Décalage d'horloge serveur : ${est.offsetMs.toFixed(1)} ms, RTT min ${est.rttMs.toFixed(1)} ms`);
      } else {
        log.info("Cet adaptateur n'expose pas d'heure serveur précise (repli sur l'en-tête Date, ±500 ms).");
      }
      await releaseGuard();
      await session?.detach();
      return 0;
    }

    // run
    const tuning = session ? await tuneNetwork(session.context, session.page, config.browser, log.child("cdp")) : { release: async () => undefined };
    if (session && o.trace) traceSlowRequests(session.page, log.child("net"));

    const agent = new Agent({
      config,
      adapter,
      ctx,
      catalog,
      lock,
      browserStartMs,
      claude: new ClaudeAssistant(config.claude, log.child("claude")),
      log,
      clock: new Clock(),
      mode: "live",
      profile,
      onFinish: async () => {
        await releaseGuard(); // le paiement manuel redevient possible
        await tuning.release(); // images/polices de nouveau chargées
      },
    });

    const result = await agent.run();
    if (result.status === "in-cart" || result.status === "ready-not-added") {
      log.info(session ? "Le navigateur reste ouvert : vérifiez le panier et payez vous-même. Le bot s'arrête ici." : "Panier réservé via l'API officielle : finalisez et payez vous-même sur le site officiel. Le bot s'arrête ici.");
    } else if (result.status === "cart-mismatch") {
      log.warn("Le panier n'a pas pu être validé. Vérifiez-le à la main avant tout paiement.");
    } else if (result.status === "authorization-expired") {
      log.error("Autorisation expirée ou retirée pendant le run : arrêt, aucune requête de plus. Mettez à jour les preuves (npm run platform verify).");
    }
    if (session) {
      if (o.exitWhenDone) await session.shutdown();
      else await session.detach();
    }
    return result.status === "in-cart" || result.status === "ready-not-added" ? 0 : 1;
  } finally {
    lock?.release();
    for (const l of locks) l.release();
  }
}
