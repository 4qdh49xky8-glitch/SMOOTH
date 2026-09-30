/**
 * Kit de fixtures pour les futurs adaptateurs (docs/FIXTURES.md). TEST_ONLY · NOT_A_REAL_PLATFORM : des données et un serveur
 * 100 % locaux ; rien ici ne représente une plateforme réelle ni ne vaut autorisation.
 *
 * Un scénario décrit ce que le site (factice) montre ; l'adaptateur doit alors se comporter selon le contrat :
 *   nominal          plusieurs offres (prix, catégorie, quantité, sièges adjacents ou non) → offres normalisées, panier, arrêt avant paiement
 *   not-open         la vente n'est pas encore ouverte → open:false
 *   sold-out         vente ouverte, plus rien d'achetable → SOLD_OUT
 *   queue            salle d'attente → détecté (QUEUE), aucune action sur le site
 *   captcha          CAPTCHA → détecté (CAPTCHA), jamais résolu ni contourné
 *   blocked          contrôle anti-bot / accès refusé → détecté (BLOCKED)
 *   login-required   non connecté → NotLoggedInError / LOGIN_REQUIRED, aucune connexion automatique
 *   purchase-limit   limite d'achat atteinte → arrêt (PURCHASE_LIMIT), jamais contournée
 *   contention       la 1re offre est vendue entre-temps → OfferUnavailableError (le cœur passe à la suivante)
 *   cart-mismatch    le site ajoute moins de billets que demandé → l'adaptateur relate fidèlement le panier (le cœur refuse de le déclarer réussi)
 */
export const SCENARIOS = ["nominal", "not-open", "sold-out", "queue", "captcha", "blocked", "login-required", "purchase-limit", "contention", "cart-mismatch"] as const;
export type FixtureScenario = (typeof SCENARIOS)[number];

export interface FixtureOffer {
  id: string;
  category: string;
  price: number;
  available: number;
  section: string;
  row: string;
  seats: string[];
}

/** Jeu de données canonique : de quoi tester filtre, budget, catégories, quantité et adjacence. */
export const CANONICAL_OFFERS: readonly FixtureOffer[] = [
  { id: "o1", category: "Catégorie 1", price: 189, available: 4, section: "A", row: "3", seats: ["11", "12", "13", "14"] }, // adjacents ; trop cher pour 150 €
  { id: "o2", category: "Catégorie 2", price: 139, available: 2, section: "B", row: "7", seats: ["5", "6"] }, // adjacents ; idéale
  { id: "o3", category: "Catégorie 2", price: 129, available: 2, section: "B", row: "9", seats: ["8", "20"] }, // PAS côte à côte
  { id: "o4", category: "Catégorie 3", price: 99, available: 1, section: "C", row: "2", seats: ["4"] }, // quantité insuffisante pour 2
  { id: "o5", category: "Catégorie 4", price: 79, available: 6, section: "D", row: "1", seats: ["1", "2", "3", "4", "5", "6"] }, // adjacents ; catégorie souvent refusée
  { id: "o6", category: "Catégorie 3", price: 120, available: 2, section: "C", row: "5", seats: ["30", "31"] }, // adjacents ; repli si o2 vendue
];

/** Ce qu'un adaptateur doit extraire du jeu canonique (prix, catégorie, quantité) ; adjacence pour une quantité demandée de 2. */
export const EXPECTED_ADJACENT: Readonly<Record<string, boolean>> = { o1: true, o2: true, o3: false, o4: false, o5: true, o6: true };

export interface FixtureSiteOptions {
  port?: number;
  scenario?: FixtureScenario;
  /** Epoch ms d'ouverture de la vente (défaut : ouverte). */
  openAt?: number;
  offers?: readonly FixtureOffer[];
  /** Salle d'attente pendant N ms après l'ouverture. */
  queueMs?: number;
  /** CAPTCHA pendant N ms après l'ouverture. */
  captchaMs?: number;
  /** Page « accès refusé » pendant N ms après l'ouverture. */
  blockedMs?: number;
  /** La 1re tentative d'ajout échoue (« déjà vendu »). */
  contention?: boolean;
  /** Limite d'achat (billets par commande) : au-delà, le site répond « limite atteinte ». */
  purchaseLimit?: number;
  /** Le site n'ajoute qu'un billet de moins que demandé. */
  cartMismatch?: boolean;
  /** Vente ouverte mais tout est épuisé. */
  soldOut?: boolean;
  /** false : la page événement est publique (la connexion n'est exigée que pour le panier). Défaut true. */
  requireLogin?: boolean;
  /** Identifiants de test (FICTIFS). */
  credentials?: { email: string; password: string };
  /** Remplace le rendu HTML de pages (reproduire le balisage d'une plateforme à partir de captures locales). */
  skin?: Partial<FixtureSkin>;
}

export interface FixtureSkin {
  page(title: string, body: string, head?: string): string;
  login(): string;
  account(): string;
  event(ctx: { open: boolean; soldOut: boolean; offers: readonly FixtureOffer[] }): string;
  offer(offer: FixtureOffer): string;
  cart(ctx: { items: { offerId: string; label: string; quantity: number; unitPrice: number }[]; total: number; expiresAt: number }): string;
  queue(): string;
  captcha(): string;
  blocked(): string;
  purchaseLimit(limit: number): string;
  contention(): string;
  payment(): string;
}

/** Applique un scénario nommé aux options (les options explicites l'emportent). */
export function optionsForScenario(scenario: FixtureScenario, now = Date.now()): Partial<FixtureSiteOptions> {
  const open = { openAt: now - 1000 };
  switch (scenario) {
    case "nominal": return { ...open };
    case "not-open": return { openAt: now + 3_600_000 };
    case "sold-out": return { ...open, soldOut: true };
    case "queue": return { ...open, queueMs: 3_600_000 };
    case "captcha": return { ...open, captchaMs: 3_600_000 };
    case "blocked": return { ...open, blockedMs: 3_600_000 };
    case "login-required": return { ...open };
    case "purchase-limit": return { ...open, purchaseLimit: 1 };
    case "contention": return { ...open, contention: true };
    case "cart-mismatch": return { ...open, cartMismatch: true };
  }
}
