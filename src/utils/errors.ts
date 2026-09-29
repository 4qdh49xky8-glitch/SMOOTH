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
    super(`Blocage détecté (${blocker.kind}) : ${blocker.message}`);
    this.name = "BlockerError";
  }
}

export class SelectorNotFoundError extends Error {
  constructor(public readonly spec: SelectorSpec) {
    super(`Élément introuvable : ${spec.name} (${spec.description})`);
    this.name = "SelectorNotFoundError";
  }
}
