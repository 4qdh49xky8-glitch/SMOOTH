import type { BrowserContext } from "playwright";
import type { Logger } from "../utils/logger.js";

export interface NetworkGuardOptions {
  /** Patterns d'URL de paiement de l'adaptateur : toute requête est annulée. */
  paymentPatterns: RegExp[];
  /** Hôtes autorisés pour les NAVIGATIONS de page (domaines officiels de la plateforme ; boucle locale pour la démo). */
  allowedHosts: string[];
  log: Logger;
  onBlocked?: (url: string, why: "payment" | "host") => void;
}

const hostAllowed = (host: string, allowed: string[]): boolean => allowed.some((a) => host === a.toLowerCase() || host.endsWith(`.${a.toLowerCase()}`));

/**
 * Garde-fous réseau du navigateur, UN seul point d'interception (Playwright intercepte déjà toutes les requêtes dès qu'une route existe) :
 *  - paiement : toute requête vers une URL de paiement est annulée ;
 *  - navigation : toute NAVIGATION de page (document, y compris après redirection) vers un hôte hors des domaines autorisés est annulée.
 * Les sous-ressources (scripts, API du site, widgets de vérification) suivent le fonctionnement normal du site et ne sont pas modifiées.
 * Il s'agit d'une LIMITE de ce que le bot peut atteindre, jamais d'un moyen de contourner une protection du site.
 */
export async function installNetworkGuards(context: BrowserContext, o: NetworkGuardOptions): Promise<() => Promise<void>> {
  const isPayment = (url: string): boolean => o.paymentPatterns.some((p) => p.test(url));
  const isForeign = (url: string): boolean => {
    try {
      const u = new URL(url);
      return (u.protocol === "http:" || u.protocol === "https:") && !hostAllowed(u.hostname.toLowerCase(), o.allowedHosts);
    } catch {
      return false;
    }
  };
  const matcher = (u: URL): boolean => isPayment(u.href) || isForeign(u.href);
  const handler = async (route: import("playwright").Route): Promise<void> => {
    const req = route.request();
    const u = new URL(req.url());
    const where = `${u.origin}${u.pathname}`; // jamais les paramètres d'URL
    if (isPayment(req.url())) {
      o.log.warn(`Garde-fou : accès à une page de paiement bloqué (${where})`);
      o.onBlocked?.(req.url(), "payment");
      return route.abort();
    }
    if (req.isNavigationRequest() && req.frame().parentFrame() === null) {
      o.log.warn(`Garde-fou : navigation hors des domaines autorisés bloquée (${where})`);
      o.onBlocked?.(req.url(), "host");
      return route.abort();
    }
    return route.fallback();
  };
  await context.route(matcher, handler);
  return async () => {
    await context.unroute(matcher, handler).catch(() => undefined);
  };
}
