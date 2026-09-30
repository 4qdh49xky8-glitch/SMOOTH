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
  /**
   * `true` : FIXTURE DE DÉVELOPPEMENT (TEST_ONLY, NOT_A_REAL_PLATFORM). Jamais une preuve d'architecture réelle ni une autorisation ;
   * obligatoire (et réservé) à `compliance.policy: "demo"`, donc limité à localhost.
   */
  testOnly?: boolean;
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

/** Ce qu'un adaptateur EXIGE pour pouvoir s'exécuter (voir authorizationOf) : jamais une autorisation en soi. */
export interface AdapterAuthorization {
  platform: string;
  channel: "official-api" | "browser";
  policy: Compliance["policy"];
  /** false : adaptateur de test (TEST_ONLY), limité à localhost. */
  evidenceRequired: boolean;
  /** Statuts de la plateforme qui autorisent ce canal (modèle figé). Vide pour un adaptateur de test. */
  requiresStatus: string[];
}

/** Description de l'événement ciblé. */
export interface EventInfo {
  url: string;
  name?: string;
}

/** Disponibilité de la vente à l'instant de la lecture. */
export interface Availability {
  open: boolean;
  /** Le site indique explicitement « complet / épuisé ». */
  soldOut: boolean;
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
 * CONTRAT D'ADAPTATEUR (détail : docs/ADAPTER_CONTRACT.md). Le plus simple : étendre BaseSiteAdapter (navigateur) ou
 * BaseApiAdapter (API officielle), qui fournissent tout ce qui n'est pas propre à la plateforme.
 *
 * DÉCLARATIONS (lecture seule ; elles disent ce que l'adaptateur EST et EXIGE, jamais ce qui est autorisé) :
 *   authorization   plateforme + statuts qui autorisent son canal (la preuve seule peut les satisfaire)
 *   channel         "official-api" | "browser"
 *   capabilities    ce que la plateforme expose (API officielle, heure serveur, adjacence, choix de places, limite d'achat)
 *   allowedHosts()  hôtes que l'adaptateur contactera ; TOUS doivent appartenir aux domaines officiels du catalogue
 *
 * CAPACITÉS (les sept seules dont le cœur a besoin) :
 *   getEvent · getAvailability · getOffers · matchOffer · selectOffer · addToCart · getCartState
 *
 * ÉTATS : un adaptateur ne remonte que des états bloquants (QUEUE, CAPTCHA, LOGIN_REQUIRED, MANUAL_SELECTION, PURCHASE_LIMIT,
 * BLOCKED) via `detectBlocker` ou `BlockerError` ; le cœur en déduit AVAILABLE, SOLD_OUT, CART_SUCCESS, ERROR.
 *
 * RÈGLES : lecture LÉGÈRE ; aucune méthode ne contourne CAPTCHA / file d'attente / anti-bot / limite de débit / limite d'achat /
 * authentification (lever BlockerError ou signaler via detectBlocker : le cœur cède la main ou s'arrête) ; aucune méthode ne
 * déclenche un paiement ; aucune requête hors de `allowedHosts()`.
 */
export interface SiteAdapter {
  readonly meta: AdapterMeta;
  readonly authorization: AdapterAuthorization;
  readonly channel: "official-api" | "browser";
  readonly capabilities: AdapterMeta["capabilities"];
  /** Hôtes contactés (API officielle, page d'événement, service de file…), vérifiés contre les domaines officiels avant tout contact. */
  allowedHosts(config: BotConfig): string[];

  /** URLs de paiement : bloquées pendant l'exécution du bot (garde-fou). */
  readonly paymentUrlPatterns: RegExp[];

  // ───── les sept capacités ─────
  /** L'événement visé (URL, nom). Local par défaut (depuis la configuration). */
  getEvent(ctx: AdapterContext): Promise<EventInfo>;
  /** La vente est-elle ouverte / complète ? Lecture légère. Peut lever RateLimitedError. */
  getAvailability(ctx: AdapterContext): Promise<Availability>;
  /** Offres normalisées : prix, catégorie, quantité, adjacence. Peut lever RateLimitedError. */
  getOffers(ctx: AdapterContext): Promise<Offer[]>;
  /**
   * Veto propre à la plateforme (offre réservée, épuisée côté site…). Il ne peut QU'EXCLURE : le budget, la quantité, les catégories et
   * la stratégie restent décidés par le cœur (déterministe) ; retourner `true` n'ajoute jamais une offre que le cœur a écartée.
   */
  matchOffer(offer: Offer, criteria: BotConfig["tickets"]): boolean;
  /** Ouvre l'offre et règle la quantité. Peut lever OfferUnavailableError / BlockerError. */
  selectOffer(ctx: AdapterContext, offer: Offer, quantity: number): Promise<void>;
  /** Ajoute au panier (JAMAIS un paiement) et attend la confirmation (ou OfferUnavailableError). */
  addToCart(ctx: AdapterContext): Promise<void>;
  /** État du panier, relu depuis la plateforme (le cœur vérifie quantité et budget ; le bot s'arrête là). */
  getCartState(ctx: AdapterContext): Promise<CartSummary>;

  // ───── mécanique du cœur (fournie par les classes de base) ─────
  /** Ouverture de la page événement : URL à charger (local, synchrone). */
  resolveEventUrl(config: BotConfig): string;
  /** Lecture atomique disponibilité + offres (dérivée de getAvailability + getOffers par défaut). */
  fetchSale(ctx: AdapterContext): Promise<SaleSnapshot>;
  /** Alias de getCartState, utilisé par le cœur. */
  readCart(ctx: AdapterContext): Promise<CartSummary>;
  /** Heure serveur en epoch ms, si le site l'expose. */
  getServerTime?(ctx: AdapterContext): Promise<number>;
  /** Authentification MANUELLE par défaut : lève NotLoggedInError si l'humain doit se connecter. */
  ensureLoggedIn(ctx: AdapterContext): Promise<void>;
  /** Pré-chauffage avant l'ouverture : charge la page événement, ouvre les connexions. */
  prepare(ctx: AdapterContext): Promise<void>;
  /**
   * Optionnel — choix des places après selectOffer. Si le choix doit être fait par l'humain
   * (plan de salle), lever BlockerError({ state: "MANUAL_SELECTION", … }) : le cœur cède la main puis continue.
   */
  selectSeats?(ctx: AdapterContext, offer: Offer, quantity: number): Promise<void>;
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
