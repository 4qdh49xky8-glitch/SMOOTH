import type { BrowserContext, Page } from "playwright";
import type { BotConfig } from "../config/schema.js";
import type { SelectorResolver } from "../selectors/resolver.js";
import type { Logger } from "../utils/logger.js";

/** Offre normalisée : c'est le seul format que comprend le moteur de décision. */
export interface Offer {
  id: string;
  category: string;
  pricePerTicket: number;
  currency: string;
  /** Nombre de billets achetables ensemble dans cette offre. */
  available: number;
  /** true = confirmé côte à côte, false = non, "unknown" = le site ne le dit pas. */
  seatsTogether: boolean | "unknown";
  section?: string;
  row?: string;
  seats?: string[];
  /** Lien direct vers l'offre si le site en propose un (évite de passer par la liste). */
  url?: string;
}

export interface SaleSnapshot {
  open: boolean;
  offers: Offer[];
}

export interface CartSummary {
  itemCount: number;
  totalPrice: number;
  currency: string;
  items: { label: string; quantity: number; unitPrice: number }[];
  /** Fin de la réservation du panier (epoch ms), si le site l'indique. */
  expiresAt?: number;
}

export interface Blocker {
  kind: "captcha" | "queue" | "anti-bot" | "unknown";
  message: string;
}

export interface AdapterContext {
  config: BotConfig;
  context: BrowserContext;
  page: Page;
  log: Logger;
  env: NodeJS.ProcessEnv;
  selectors: SelectorResolver;
}

/**
 * Contrat à implémenter pour ajouter un site de billetterie.
 * Règles :
 *  - `fetchSale` doit être LÉGER (API JSON ou requête HTTP), sans rendu de page ;
 *  - aucune méthode ne doit contourner CAPTCHA / file d'attente / anti-bot : en cas de blocage,
 *    lever BlockerError (ou retourner un Blocker via detectBlocker) et l'agent passera la main ;
 *  - aucune méthode ne doit déclencher un paiement.
 */
export interface SiteAdapter {
  readonly id: string;
  /** URLs de paiement : bloquées pendant l'exécution du bot (garde-fou). */
  readonly paymentUrlPatterns: RegExp[];

  resolveEventUrl(config: BotConfig): string;

  /** Heure serveur en epoch ms, si le site l'expose (sinon l'horloge locale est utilisée). */
  getServerTime?(ctx: AdapterContext): Promise<number>;

  /** Vérifie/établit la session du compte existant. Lève NotLoggedInError si une action humaine est requise. */
  ensureLoggedIn(ctx: AdapterContext): Promise<void>;

  /** Pré-chauffage avant l'ouverture : charge la page, ouvre les connexions. */
  prepare(ctx: AdapterContext): Promise<void>;

  /** Lit l'état de la vente (léger). Peut lever RateLimitedError. */
  fetchSale(ctx: AdapterContext): Promise<SaleSnapshot>;

  /** Ouvre l'offre et règle la quantité. Peut lever OfferUnavailableError / BlockerError. */
  selectOffer(ctx: AdapterContext, offer: Offer, quantity: number): Promise<void>;

  /** Clique « Ajouter au panier » et attend la confirmation (ou OfferUnavailableError). */
  addToCart(ctx: AdapterContext): Promise<void>;

  readCart(ctx: AdapterContext): Promise<CartSummary>;

  detectBlocker(ctx: AdapterContext): Promise<Blocker | null>;
}
