import type { Page } from "playwright";
import type { ApiClient } from "./ApiClient.js";
import type { BotConfig } from "../config/schema.js";
import { SelectorResolver } from "../selectors/resolver.js";
import { authorizationOf, channelOf } from "../platforms/authorize.js";
import type { AdapterAuthorization, AdapterContext, AdapterMeta, Availability, Blocker, CartSummary, EventInfo, Offer, SaleSnapshot, SiteAdapter } from "../sites/SiteAdapter.js";
import type { Logger } from "../utils/logger.js";

/**
 * Interface des futurs adaptateurs API OFFICIELLE (canal « official-api »).
 *
 * Ce que l'interface impose (par construction, pas par convention) :
 *  - AUCUNE opération de paiement : `reserve` crée/valide une réservation ou un panier, jamais un règlement ;
 *  - authentification par identifiants officiels lus dans l'ENVIRONNEMENT (`meta.requires.env`), jamais de formulaire,
 *    jamais de création de compte ;
 *  - une file d'attente officielle se déclare via `queueStatus` : tant qu'elle est « waiting », le cœur ne tente rien ;
 *  - les refus (401/403/429/limite d'achat/CAPTCHA) sont remontés au cœur, jamais contournés (voir ApiClient.mapApiError) ;
 *  - aucun navigateur : `ctx.page` refuse tout accès sauf `bringToFront` (sans effet).
 *
 * Un adaptateur qui l'étend doit déclarer `meta.channel = "official-api"` et `capabilities.officialApi = true` ; il n'est
 * exécutable que si le catalogue affiche API_ONLY ou API_AND_BROWSER pour sa plateforme.
 */
export abstract class BaseApiAdapter implements SiteAdapter {
  abstract readonly meta: AdapterMeta;
  /** Marqueur lu par le contrat : cet adaptateur n'utilise pas de navigateur. */
  readonly isApiAdapter = true;
  /** Client HTTP encadré de l'adaptateur : ses hôtes sont vérifiés contre le catalogue avant tout contact. */
  readonly client?: ApiClient;
  get authorization(): AdapterAuthorization {
    return authorizationOf(this.meta);
  }
  get channel(): "official-api" | "browser" {
    return channelOf(this.meta);
  }
  get capabilities(): AdapterMeta["capabilities"] {
    return this.meta.capabilities;
  }
  /** Hôtes de l'API officielle (ceux du client HTTP encadré) : vérifiés contre les domaines officiels avant tout contact. */
  allowedHosts(_config?: BotConfig): string[] {
    return this.client ? this.client.hosts : [];
  }
  async getEvent(ctx: AdapterContext): Promise<EventInfo> {
    return { url: this.resolveEventUrl(ctx.config), name: ctx.config.event.name };
  }
  async getAvailability(ctx: AdapterContext): Promise<Availability> {
    const s = await this.listOffers(ctx);
    return { open: s.open, soldOut: s.soldOut ?? (s.open && s.offers.every((o) => o.available <= 0)) };
  }
  async getOffers(ctx: AdapterContext): Promise<Offer[]> {
    return (await this.listOffers(ctx)).offers;
  }
  /** Veto seulement : aucune exclusion propre à la plateforme par défaut. */
  matchOffer(_offer: Offer, _criteria: BotConfig["tickets"]): boolean {
    return true;
  }
  getCartState(ctx: AdapterContext): Promise<CartSummary> {
    return this.readReservation(ctx);
  }
  /** Pas d'URL de paiement : aucun navigateur, et aucune opération de paiement n'existe dans l'interface. */
  readonly paymentUrlPatterns: RegExp[] = [];

  resolveEventUrl(config: BotConfig): string {
    if (!config.event.url) throw new Error(`event.url est requis pour l'adaptateur « ${this.meta.id} »`);
    return config.event.url;
  }

  /** Authentification OFFICIELLE (jeton/clé lus dans l'environnement). Lève NotLoggedInError si absente/refusée. */
  abstract authenticate(ctx: AdapterContext): Promise<void>;
  /** Disponibilité + offres normalisées (prix, catégorie, quantité, adjacence). Léger. */
  abstract listOffers(ctx: AdapterContext): Promise<SaleSnapshot>;
  /** Vérifie/verrouille l'offre pour la quantité demandée (OfferUnavailableError si vendue). */
  abstract holdOffer(ctx: AdapterContext, offer: Offer, quantity: number): Promise<void>;
  /** Crée la RÉSERVATION / le PANIER via l'API officielle. Jamais un paiement. */
  abstract reserve(ctx: AdapterContext): Promise<void>;
  abstract readReservation(ctx: AdapterContext): Promise<CartSummary>;
  /** Optionnel : file d'attente officielle de l'API. */
  queueStatus?(ctx: AdapterContext): Promise<"none" | "waiting" | "admitted">;
  /** Optionnel : pré-chauffage (connexion HTTP/TLS, jeton). */
  warmUp?(ctx: AdapterContext): Promise<void>;
  getServerTime?(ctx: AdapterContext): Promise<number>;

  ensureLoggedIn(ctx: AdapterContext): Promise<void> {
    return this.authenticate(ctx);
  }
  async prepare(ctx: AdapterContext): Promise<void> {
    await this.warmUp?.(ctx);
  }
  fetchSale(ctx: AdapterContext): Promise<SaleSnapshot> {
    return this.listOffers(ctx);
  }
  selectOffer(ctx: AdapterContext, offer: Offer, quantity: number): Promise<void> {
    return this.holdOffer(ctx, offer, quantity);
  }
  addToCart(ctx: AdapterContext): Promise<void> {
    return this.reserve(ctx);
  }
  readCart(ctx: AdapterContext): Promise<CartSummary> {
    return this.readReservation(ctx);
  }
  async detectBlocker(ctx: AdapterContext): Promise<Blocker | null> {
    const q = await this.queueStatus?.(ctx);
    return q === "waiting" ? { state: "QUEUE", message: "file d'attente officielle de l'API" } : null;
  }
  /**
   * Lecture cohérente : la file d'attente officielle d'abord ; tant qu'elle est « waiting », on n'interroge même pas les
   * offres (on respecte la file, on n'insiste pas). Les deux lectures sont séquentielles : elles partagent le même client
   * à cadence plafonnée, les lancer « en parallèle » n'apporterait rien et pourrait faire manquer la file.
   */
  async pollState(ctx: AdapterContext): Promise<{ snapshot: SaleSnapshot; blocker: Blocker | null }> {
    const blocker = await this.detectBlocker(ctx);
    if (blocker) return { snapshot: { open: false, offers: [] }, blocker };
    return { snapshot: await this.listOffers(ctx), blocker: null };
  }
}

const refuse = (what: string): never => {
  throw new Error(`Canal API : aucun navigateur (${what}) — un adaptateur API n'utilise que l'API officielle`);
};

/** Contexte sans navigateur : toute tentative d'utiliser `page` ou `context` échoue bruyamment. */
export function createApiContext(config: BotConfig, log: Logger, env: NodeJS.ProcessEnv = process.env): AdapterContext {
  const guard = (label: string, allowed: string[] = []): object =>
    new Proxy({}, { get: (_t, prop) => (allowed.includes(String(prop)) ? async () => undefined : prop === "then" ? undefined : refuse(`${label}.${String(prop)}`)) });
  return {
    config,
    context: guard("context") as never,
    page: guard("page", ["bringToFront"]) as Page,
    log,
    env,
    selectors: new SelectorResolver("api"),
  };
}

export const isApiAdapter = (a: SiteAdapter): boolean => (a as { isApiAdapter?: boolean }).isApiAdapter === true;
