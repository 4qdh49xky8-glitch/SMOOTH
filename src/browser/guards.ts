import type { BrowserContext } from "playwright";
import type { Logger } from "../utils/logger.js";

/**
 * Garde-fou : tant que le bot tourne, toute navigation vers une URL de paiement est annulée.
 * Le paiement n'est jamais automatisé ; on lève ce garde-fou à la fin pour la reprise manuelle.
 */
export async function installPaymentGuard(
  context: BrowserContext,
  patterns: RegExp[],
  log: Logger,
  onBlocked: (url: string) => void,
): Promise<() => Promise<void>> {
  const handler = (route: import("playwright").Route): Promise<void> => {
    // Hôte + chemin seulement : jamais les paramètres d'URL (jetons, identifiants de session…).
    const u = new URL(route.request().url());
    log.warn(`Garde-fou : accès à une page de paiement bloqué (${u.origin}${u.pathname})`);
    onBlocked(route.request().url());
    return route.abort();
  };
  for (const p of patterns) await context.route(p, handler);
  return async () => {
    for (const p of patterns) await context.unroute(p, handler).catch(() => undefined);
  };
}
