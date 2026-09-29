import { basename } from "node:path";
import { Agent } from "../agent/Agent.js";
import { ClaudeAssistant } from "../agent/claude.js";
import { installPaymentGuard } from "../browser/guards.js";
import { traceSlowRequests, tuneNetwork } from "../browser/cdp.js";
import { defaultUserDataDir, openBrowser } from "../browser/launch.js";
import { loadConfig, resolveConfigPath } from "../config/load.js";
import { SelectorResolver } from "../selectors/resolver.js";
import { assertCompliant } from "../sites/compliance.js";
import { getAdapter } from "../sites/registry.js";
import type { AdapterContext } from "../sites/SiteAdapter.js";
import { Clock, estimateOffset } from "../utils/clock.js";
import { acquireEventLock, eventKey } from "../utils/lock.js";
import { createLogger, pickLevel } from "../utils/logger.js";
import { waitForEnter } from "../utils/prompt.js";

export interface LiveOptions {
  command: "run" | "login" | "check";
  target?: string;
  trace: boolean;
  exitWhenDone: boolean;
  logLevel?: string;
  logFile?: string;
}

/** Commandes qui pilotent un vrai navigateur : run, login, check. */
export async function liveCommand(o: LiveOptions): Promise<number> {
  const target = o.target ?? "config/event.json";
  const config = loadConfig(target);
  // Identité de l'instance : nom du profil + PID. Elle préfixe les logs et nomme le navigateur (un profil = un navigateur).
  const profile = basename(resolveConfigPath(target), ".json");
  const instance = `${profile}#${process.pid}`;
  const logFile = (o.logFile ?? config.logging.file)?.replaceAll("{profile}", profile).replaceAll("{pid}", String(process.pid));
  const log = createLogger({ level: pickLevel(o.logLevel, process.env.LOG_LEVEL, config.logging.level), file: logFile, scope: instance });

  const adapter = await getAdapter(config.site);
  assertCompliant(adapter.meta, adapter.resolveEventUrl(config)); // refus AVANT d'ouvrir le navigateur

  // Un seul bot par événement (même adaptateur + même page d'événement), quel que soit le profil.
  const lock = o.command === "run" ? acquireEventLock(eventKey(adapter.meta.id, adapter.resolveEventUrl(config)), instance) : undefined;
  process.once("SIGINT", () => process.exit(130)); // déclenche 'exit' : le verrou est libéré
  try {
    const session = await openBrowser(config, log.child("browser"), { userDataDir: config.browser.userDataDir ?? defaultUserDataDir(profile) });
    const ctx: AdapterContext = {
      config,
      context: session.context,
      page: session.page,
      log: log.child(`site:${adapter.meta.id}`),
      env: process.env,
      selectors: new SelectorResolver(adapter.meta.id),
    };

    if (o.command === "login") {
      await session.page.goto(adapter.resolveEventUrl(config));
      log.info("Connectez-vous dans la fenêtre. Le profil (cookies) est conservé pour les prochains runs.");
      await waitForEnter("Appuyez sur Entrée quand vous êtes connecté.").promise;
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
      await session.detach();
      return 0;
    }

    // run
    const releaseGuard = await installPaymentGuard(session.context, adapter.paymentUrlPatterns, log.child("guard"), () => undefined);
    const tuning = await tuneNetwork(session.context, session.page, config.browser, log.child("cdp"));
    if (o.trace) traceSlowRequests(session.page, log.child("net"));

    const agent = new Agent({
      config,
      adapter,
      ctx,
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
      log.info("Le navigateur reste ouvert : vérifiez le panier et payez vous-même. Le bot s'arrête ici.");
    } else if (result.status === "cart-mismatch") {
      log.warn("Le navigateur reste ouvert : le panier n'a pas pu être validé. Vérifiez-le à la main avant tout paiement.");
    }
    if (o.exitWhenDone) await session.shutdown();
    else await session.detach();
    return result.status === "in-cart" || result.status === "ready-not-added" ? 0 : 1;
  } finally {
    lock?.release();
  }
}
