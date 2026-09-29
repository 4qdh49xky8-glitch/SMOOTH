import type { BotConfig } from "../config/schema.js";
import { detectCommonBlocker } from "../selectors/blockers.js";
import { NotLoggedInError } from "../utils/errors.js";
import type {
  AdapterContext,
  AdapterMeta,
  Blocker,
  CartSummary,
  Offer,
  SaleSnapshot,
  SiteAdapter,
} from "./SiteAdapter.js";

export const DEFAULT_PAYMENT_URL_PATTERNS: RegExp[] = [
  /\/(payment|paiement|checkout\/pay|pay)(\/|\?|#|$)/i,
];

/**
 * Base commune : comportements par défaut sûrs. Un nouvel adaptateur n'a à écrire que ce qui est
 * propre au site (voir docs/ADDING_A_SITE.md). Rien ici ne contourne un mécanisme de protection.
 */
export abstract class BaseSiteAdapter implements SiteAdapter {
  abstract readonly meta: AdapterMeta;
  readonly paymentUrlPatterns: RegExp[] = DEFAULT_PAYMENT_URL_PATTERNS;

  resolveEventUrl(config: BotConfig): string {
    if (!config.event.url) throw new Error(`event.url est requis pour l'adaptateur « ${this.meta.id} »`);
    return config.event.url;
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

  abstract fetchSale(ctx: AdapterContext): Promise<SaleSnapshot>;
  abstract selectOffer(ctx: AdapterContext, offer: Offer, quantity: number): Promise<void>;
  abstract addToCart(ctx: AdapterContext): Promise<void>;
  abstract readCart(ctx: AdapterContext): Promise<CartSummary>;

  detectBlocker(ctx: AdapterContext): Promise<Blocker | null> {
    return detectCommonBlocker(ctx.page);
  }
}
