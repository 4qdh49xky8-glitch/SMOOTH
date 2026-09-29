import type { BrowserContext, Page } from "playwright";
import type { BotConfig } from "../config/schema.js";
import type { SelectorResolver } from "../selectors/resolver.js";
import type { BlockingState } from "../agent/states.js";
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
  /** Le site indique explicitement « complet / épuisé » (sinon déduit : aucune offre achetable). */
  soldOut?: boolean;
}

export interface CartSummary {
  itemCount: number;
  totalPrice: number;
  currency: string;
  items: { label: string; quantity: number; unitPrice: number }[];
  /** Fin de la réservation du panier (epoch ms), si le site l'indique. */
  expiresAt?: number;
}

/**
 * État « bloquant » remonté au cœur (voir src/agent/states.ts). Le cœur ne contourne JAMAIS aucun de ces états :
 *  - CAPTCHA | QUEUE | BLOCKED          : cession de la main à l'humain, reprise auto quand ça disparaît ;
 *  - LOGIN_REQUIRED | MANUAL_SELECTION  : cession de la main, reprise quand l'humain confirme (Entrée) ;
 *  - PURCHASE_LIMIT                     : ARRÊT DÉFINITIF du run (limite d'achat du site, jamais contournée).
 */
/** Alias pratique du type d'état bloquant. */
export type BlockingStateAlias = BlockingState;

export interface Blocker {
  state: BlockingState;
  message: string;
}

/**
 * Cadre juridique de l'adaptateur. Le cœur REFUSE de lancer un adaptateur sans déclaration valide
 * (voir src/sites/compliance.ts). C'est à vous de lire les CGU du site avant de renseigner ceci.
 */
export interface Compliance {
  /**
   * "official-api"        : le site fournit une API/un partenariat d'intégration officiel ;
   * "permitted-by-terms"  : les CGU/règles du site autorisent expressément l'outil décrit ;
   * "demo"                : site local de démonstration uniquement (limité à localhost).
   */
  policy: "official-api" | "permitted-by-terms" | "demo";
  /** Page des CGU / de la documentation qui fonde la décision. */
  termsUrl: string;
  /** Date de la dernière relecture, AAAA-MM-JJ (expire après 180 jours). */
  reviewedAt: string;
  notes?: string;
}

export interface AdapterMeta {
  id: string;
  displayName: string;
  /** Entrée du catalogue des plateformes (platforms/catalog.json) ; par défaut `id`. Une même plateforme peut avoir plusieurs adaptateurs (un par canal). */
  platform?: string;
  /** Canal technique : "official-api" ou "browser" (par défaut déduit de capabilities.officialApi). */
  channel?: "official-api" | "browser";
  /** Prérequis d'exécution : un adaptateur dont les variables d'environnement manquent n'est pas retenu (le cœur passe au canal suivant). */
  requires?: { env?: string[] };
  compliance: Compliance;
  capabilities: {
    /** Utilise une API officielle plutôt que le pilotage de pages. */
    officialApi: boolean;
    /** Le site expose une heure serveur précise (sinon repli sur l'en-tête Date, ±500 ms). */
    preciseServerTime: boolean;
    /** fetchSale ne nécessite pas de rendu de page. */
    lightweightAvailability: boolean;
    /** Le site indique si des places sont côte à côte. */
    reportsSeatAdjacency: boolean;
    /** none : pas de choix de places ; automatic : l'adaptateur choisit ; manual : l'humain choisit sur le plan. */
    seatSelection: "none" | "automatic" | "manual";
    /**
     * Limite d'achat officielle du site (billets par commande), si elle est connue à l'avance.
     * Le cœur refuse de démarrer si `tickets.quantity` la dépasse : il ne tente jamais de la contourner.
     */
    maxTicketsPerOrder?: number;
  };
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
 * Contrat à implémenter pour ajouter un site (le plus simple : étendre BaseSiteAdapter).
 * Règles :
 *  - `fetchSale` doit être LÉGER (API officielle ou requête HTTP), sans rendu de page ;
 *  - aucune méthode ne doit contourner CAPTCHA / file d'attente / anti-bot / limite d'achat /
 *    authentification : en cas de blocage, lever BlockerError (ou retourner un Blocker via
 *    detectBlocker) et le cœur passe la main ou s'arrête ;
 *  - aucune méthode ne doit déclencher un paiement.
 */
export interface SiteAdapter {
  readonly meta: AdapterMeta;
  /** URLs de paiement : bloquées pendant l'exécution du bot (garde-fou). */
  readonly paymentUrlPatterns: RegExp[];

  /** Ouverture de la page événement : URL à charger. */
  resolveEventUrl(config: BotConfig): string;

  /** Heure serveur en epoch ms, si le site l'expose. */
  getServerTime?(ctx: AdapterContext): Promise<number>;

  /** Authentification MANUELLE par défaut : lève NotLoggedInError si l'humain doit se connecter. */
  ensureLoggedIn(ctx: AdapterContext): Promise<void>;

  /** Pré-chauffage avant l'ouverture : charge la page événement, ouvre les connexions. */
  prepare(ctx: AdapterContext): Promise<void>;

  /** Disponibilité + offres (prix, catégorie, quantité, adjacence). Peut lever RateLimitedError. */
  fetchSale(ctx: AdapterContext): Promise<SaleSnapshot>;

  /** Ouvre l'offre et règle la quantité. Peut lever OfferUnavailableError / BlockerError. */
  selectOffer(ctx: AdapterContext, offer: Offer, quantity: number): Promise<void>;

  /**
   * Optionnel — choix des places après selectOffer. Si le choix doit être fait par l'humain
   * (plan de salle), lever BlockerError({ state: "MANUAL_SELECTION", … }) : le cœur cède la main puis continue.
   */
  selectSeats?(ctx: AdapterContext, offer: Offer, quantity: number): Promise<void>;

  /** Clique « Ajouter au panier » et attend la confirmation (ou OfferUnavailableError). */
  addToCart(ctx: AdapterContext): Promise<void>;

  readCart(ctx: AdapterContext): Promise<CartSummary>;

  /** Valide `siteOptions` de la config ; retourne des messages d'erreur (vide = OK). Utilisé par `npm run validate`. */
  validateOptions?(options: Record<string, unknown>): string[];

  /** Lecture seule de la page : file d'attente, CAPTCHA, anti-bot, limite d'achat, session expirée. */
  detectBlocker(ctx: AdapterContext): Promise<Blocker | null>;

  /**
   * Optionnel — lecture UNIQUE et cohérente « disponibilité + état bloquant » au même instant. Le cœur la préfère à
   * fetchSale + detectBlocker en parallèle quand ces deux lectures partagent un canal à cadence plafonnée (API officielle).
   * Contrat : si un blocage est signalé, le snapshot n'invite pas à agir (aucune sélection pendant une file d'attente).
   */
  pollState?(ctx: AdapterContext): Promise<{ snapshot: SaleSnapshot; blocker: Blocker | null }>;
}
