import type { SelectorSpec } from "../selectors/resolver.js";
import type { Blocker } from "../sites/SiteAdapter.js";

/** L'offre choisie n'est plus disponible (vendue, quantité insuffisante...). */
export class OfferUnavailableError extends Error {
  constructor(message = "Offre indisponible") {
    super(message);
    this.name = "OfferUnavailableError";
  }
}

/** Le site demande de ralentir (HTTP 429...). */
export class RateLimitedError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`Limite de débit atteinte, attente ${retryAfterMs} ms`);
    this.name = "RateLimitedError";
  }
}

export class NotLoggedInError extends Error {
  constructor(message = "Compte non connecté") {
    super(message);
    this.name = "NotLoggedInError";
  }
}

/** File d'attente, CAPTCHA, contrôle anti-bot : seul un humain peut poursuivre. */
export class BlockerError extends Error {
  constructor(public readonly blocker: Blocker) {
    super(`Blocage détecté (${blocker.state}) : ${blocker.message}`);
    this.name = "BlockerError";
  }
}

export class SelectorNotFoundError extends Error {
  constructor(public readonly spec: SelectorSpec) {
    super(`Élément introuvable : ${spec.name} (${spec.description})`);
    this.name = "SelectorNotFoundError";
  }
}

/** Arrêt définitif du run (ex. limite d'achat atteinte) : jamais contourné, jamais réessayé. */
export class StopRunError extends Error {
  constructor(public readonly blocker: Blocker) {
    super(`Arrêt : ${blocker.message}`);
    this.name = "StopRunError";
  }
}

/** Une action humaine est nécessaire mais impossible (navigateur headless). */
export class HumanRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HumanRequiredError";
  }
}

/** L'autorisation de la plateforme n'est plus valable (preuve expirée, retirée, canal ou hôte non autorisé) : arrêt, AUCUNE requête de plus. */
export class AuthorizationExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationExpiredError";
  }
}

/** Le verrou d'événement n'est plus détenu par ce processus (supprimé ou repris) : un autre bot pourrait cibler le même événement. */
export class LockLostError extends Error {
  constructor(message = "Le verrou d'événement n'est plus détenu par cette instance") {
    super(message);
    this.name = "LockLostError";
  }
}
