import type { BotConfig } from "../config/schema.js";
import { authorizationOf, channelOf } from "../platforms/authorize.js";
import { detectCommonBlocker } from "../selectors/blockers.js";
import { NotLoggedInError } from "../utils/errors.js";
import type {
  AdapterAuthorization,
  AdapterContext,
  AdapterMeta,
  Availability,
  Blocker,
  CartSummary,
  EventInfo,
  Offer,
  SaleSnapshot,
  SiteAdapter,
} from "./SiteAdapter.js";

export const DEFAULT_PAYMENT_URL_PATTERNS: RegExp[] = [
  /\/(payment|paiement|checkout\/pay|pay)(\/|\?|#|$)/i,
];

/**
 * Base commune : comportements par défaut sûrs. Un nouvel adaptateur n'a à écrire que ce qui est propre au site
 * (voir docs/ADAPTER_CONTRACT.md et docs/ADDING_A_SITE.md). Rien ici ne contourne un mécanisme de protection.
 *
 * Lecture : implémentez SOIT `fetchSale()` (une lecture unique : disponibilité + offres), SOIT `getAvailability()` + `getOffers()`.
 * Panier : implémentez SOIT `getCartState()`, SOIT `readCart()`. Les autres formes sont dérivées ; en implémenter aucune lève
 * une erreur explicite (et le contrat d'adaptateur la signale).
 */
export abstract class BaseSiteAdapter implements SiteAdapter {
  abstract readonly meta: AdapterMeta;
  readonly paymentUrlPatterns: RegExp[] = DEFAULT_PAYMENT_URL_PATTERNS;

  // ───── déclarations (dérivées de meta) ─────
  get authorization(): AdapterAuthorization {
    return authorizationOf(this.meta);
  }
  get channel(): "official-api" | "browser" {
    return channelOf(this.meta);
  }
  get capabilities(): AdapterMeta["capabilities"] {
    return this.meta.capabilities;
  }
  /** Par défaut : l'hôte de la page d'événement. Ajoutez les autres hôtes contactés (ils doivent être officiels). */
  allowedHosts(config: BotConfig): string[] {
    return [new URL(this.resolveEventUrl(config)).hostname];
  }

  resolveEventUrl(config: BotConfig): string {
    if (!config.event.url) throw new Error(`event.url est requis pour l'adaptateur « ${this.meta.id} »`);
    return config.event.url;
  }

  /** L'adaptateur a-t-il fourni sa propre version de cette méthode (et non le défaut dérivé) ? */
  private own(name: "fetchSale" | "getAvailability" | "getOffers" | "readCart" | "getCartState"): boolean {
    return (this as unknown as Record<string, unknown>)[name] !== (BaseSiteAdapter.prototype as unknown as Record<string, unknown>)[name];
  }
  private missing(what: string): never {
    throw new Error(`Adaptateur « ${this.meta.id} » : implémentez ${what}`);
  }

  // ───── les sept capacités ─────
  async getEvent(ctx: AdapterContext): Promise<EventInfo> {
    return { url: this.resolveEventUrl(ctx.config), name: ctx.config.event.name };
  }
  async getAvailability(ctx: AdapterContext): Promise<Availability> {
    if (!this.own("fetchSale")) this.missing("getAvailability() + getOffers() ou fetchSale()");
    const s = await this.fetchSale(ctx);
    return { open: s.open, soldOut: s.soldOut ?? (s.open && s.offers.every((o) => o.available <= 0)) };
  }
  async getOffers(ctx: AdapterContext): Promise<Offer[]> {
    if (!this.own("fetchSale")) this.missing("getAvailability() + getOffers() ou fetchSale()");
    return (await this.fetchSale(ctx)).offers;
  }
  /** Veto seulement (voir SiteAdapter.matchOffer) : par défaut aucune exclusion propre à la plateforme. */
  matchOffer(_offer: Offer, _criteria: BotConfig["tickets"]): boolean {
    return true;
  }
  abstract selectOffer(ctx: AdapterContext, offer: Offer, quantity: number): Promise<void>;
  abstract addToCart(ctx: AdapterContext): Promise<void>;
  async getCartState(ctx: AdapterContext): Promise<CartSummary> {
    if (!this.own("readCart")) this.missing("getCartState() ou readCart()");
    return this.readCart(ctx);
  }

  // ───── mécanique du cœur ─────
  async fetchSale(ctx: AdapterContext): Promise<SaleSnapshot> {
    if (!this.own("getAvailability") || !this.own("getOffers")) this.missing("fetchSale() ou getAvailability() + getOffers()");
    const [availability, offers] = await Promise.all([this.getAvailability(ctx), this.getOffers(ctx)]);
    return { open: availability.open, soldOut: availability.soldOut, offers };
  }
  async readCart(ctx: AdapterContext): Promise<CartSummary> {
    if (!this.own("getCartState")) this.missing("getCartState() ou readCart()");
    return this.getCartState(ctx);
  }

  /** Doit dire si la session du compte existant est active. */
  protected abstract isLoggedIn(ctx: AdapterContext): Promise<boolean>;

  /** Par défaut : connexion MANUELLE (npm run login, ou fenêtre du navigateur). */
  async ensureLoggedIn(ctx: AdapterContext): Promise<void> {
    if (!(await this.isLoggedIn(ctx))) {
      throw new NotLoggedInError("Connectez-vous à votre compte dans la fenêtre du navigateur.");
    }
  }

  async prepare(ctx: AdapterContext): Promise<void> {
    await ctx.page.goto(this.resolveEventUrl(ctx.config), { waitUntil: "domcontentloaded" });
  }

  detectBlocker(ctx: AdapterContext): Promise<Blocker | null> {
    return detectCommonBlocker(ctx.page);
  }
}
