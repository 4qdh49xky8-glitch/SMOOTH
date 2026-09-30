import type { BrowserContext, Page } from "playwright";
import type { Logger } from "../utils/logger.js";

/**
 * Uniquement des médias décoratifs (images, polices, vidéos). Aucun script n'est bloqué — ni analytique, ni publicitaire, ni de
 * vérification : des scripts de protection du site peuvent s'y cacher, et les bloquer reviendrait à les contourner.
 */
const HEAVY_URL_PATTERNS = ["*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp", "*.avif", "*.svg", "*.woff", "*.woff2", "*.mp4", "*.webm"];

export interface NetworkTuning {
  /** Rétablit le réseau normal (images, polices) pour la reprise manuelle. */
  release(): Promise<void>;
}

/**
 * Optimisations réseau via CDP (plus rapide que page.route : le filtrage se fait dans le
 * navigateur, sans aller-retour JS ↔ Node pour chaque requête).
 * On bloque images/polices/vidéos uniquement PENDANT la course ; ne touche à rien d'autre.
 */
export async function tuneNetwork(
  context: BrowserContext,
  page: Page,
  opts: { blockHeavyResources: boolean },
  log: Logger,
): Promise<NetworkTuning> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
  if (opts.blockHeavyResources) {
    await cdp.send("Network.setBlockedURLs", { urls: HEAVY_URL_PATTERNS });
    log.debug("CDP : images/polices/vidéos bloquées pendant la course");
  }
  return {
    release: async () => {
      await cdp.send("Network.setBlockedURLs", { urls: [] }).catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    },
  };
}

/** Journalise les requêtes lentes (>threshold) avec leur décomposition : outil de mesure de latence. */
export function traceSlowRequests(page: Page, log: Logger, thresholdMs = 200): void {
  page.on("requestfinished", (req) => {
    const t = req.timing();
    const total = t.responseEnd;
    if (total >= thresholdMs) {
      const dns = Math.max(0, t.domainLookupEnd - t.domainLookupStart);
      const connect = Math.max(0, t.connectEnd - t.connectStart);
      const ttfb = Math.max(0, t.responseStart - t.requestStart);
      log.info(
        `[net] ${req.method()} ${new URL(req.url()).pathname} total=${Math.round(total)}ms dns=${Math.round(dns)} connect=${Math.round(connect)} ttfb=${Math.round(ttfb)}`,
      );
    }
  });
}
