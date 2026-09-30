/**
 * États standardisés, communs à TOUS les sites. Les adaptateurs remontent uniquement des états
 * « bloquants » (voir BlockingState) ; le cœur produit les autres (AVAILABLE, SOLD_OUT, CART_SUCCESS, ERROR).
 */
export const State = {
  /** Des offres achetables sont visibles. */
  AVAILABLE: "AVAILABLE",
  /** La vente est ouverte mais plus rien n'est achetable. */
  SOLD_OUT: "SOLD_OUT",
  /** File d'attente virtuelle : l'humain patiente, le bot ne fait rien. */
  QUEUE: "QUEUE",
  /** CAPTCHA : résolu uniquement par l'humain. */
  CAPTCHA: "CAPTCHA",
  /** Connexion manuelle requise (ou session expirée). */
  LOGIN_REQUIRED: "LOGIN_REQUIRED",
  /** Une étape est confiée à l'humain (choix de places sur un plan, ajout manuel...). */
  MANUAL_SELECTION: "MANUAL_SELECTION",
  /** Limite d'achat du site atteinte : arrêt définitif, jamais contournée. */
  PURCHASE_LIMIT: "PURCHASE_LIMIT",
  /** Contrôle anti-bot / accès refusé : l'humain traite, le bot ne contourne pas. */
  BLOCKED: "BLOCKED",
  /** Billets au panier : le bot s'arrête avant le paiement. */
  CART_SUCCESS: "CART_SUCCESS",
  /** Une étape est confiée à l'humain sans cause plus précise (reprise manuelle, vérification à la main). */
  MANUAL_INTERVENTION: "MANUAL_INTERVENTION",
  /** L'autorisation de la plateforme a expiré ou a été retirée pendant le run : arrêt, plus aucune requête. */
  AUTHORIZATION_EXPIRED: "AUTHORIZATION_EXPIRED",
  /** Erreur technique ou délai dépassé (voir FailureReason). */
  ERROR: "ERROR",
} as const;
export type State = (typeof State)[keyof typeof State];

/**
 * Les 10 états du CONTRAT d'adaptateur : ce dont un adaptateur et ses fixtures parlent. Les deux autres états
 * (AUTHORIZATION_EXPIRED, MANUAL_INTERVENTION) sont produits par le cœur seul.
 */
export const ADAPTER_STATES = ["AVAILABLE", "SOLD_OUT", "QUEUE", "CAPTCHA", "LOGIN_REQUIRED", "MANUAL_SELECTION", "PURCHASE_LIMIT", "BLOCKED", "CART_SUCCESS", "ERROR"] as const satisfies readonly State[];
export const CORE_ONLY_STATES = ["MANUAL_INTERVENTION", "AUTHORIZATION_EXPIRED"] as const satisfies readonly State[];

/** Sous-ensemble que les adaptateurs peuvent remonter. */
export type BlockingState = "QUEUE" | "CAPTCHA" | "LOGIN_REQUIRED" | "MANUAL_SELECTION" | "PURCHASE_LIMIT" | "BLOCKED";

/** Blocages dont la disparition se détecte sur la page (les autres attendent la confirmation humaine). */
export const AUTO_DETECTABLE: readonly BlockingState[] = ["QUEUE", "CAPTCHA", "BLOCKED"];

export const STATE_DESCRIPTIONS: Record<State, string> = {
  AVAILABLE: "Des offres achetables sont visibles",
  SOLD_OUT: "Vente ouverte, plus rien d'achetable",
  QUEUE: "File d'attente virtuelle — l'humain patiente",
  CAPTCHA: "CAPTCHA — résolu par l'humain uniquement",
  LOGIN_REQUIRED: "Connexion manuelle requise",
  MANUAL_SELECTION: "Étape confiée à l'humain (plan de salle…)",
  PURCHASE_LIMIT: "Limite d'achat atteinte — arrêt définitif",
  BLOCKED: "Contrôle anti-bot / accès refusé — l'humain traite",
  CART_SUCCESS: "Billets au panier — paiement manuel",
  MANUAL_INTERVENTION: "Intervention humaine (reprise manuelle)",
  AUTHORIZATION_EXPIRED: "Autorisation expirée ou retirée — arrêt, aucune requête de plus",
  ERROR: "Erreur technique ou délai dépassé",
};

/** Raisons d'échec normalisées (télémétrie). Jamais de texte libre susceptible de contenir des données perso. */
export type FailureReason =
  | "SALE_NOT_OPEN_TIMEOUT"
  | "NO_MATCHING_OFFER"
  | "MAX_ATTEMPTS"
  | "OFFER_UNAVAILABLE"
  | "PURCHASE_LIMIT"
  | "QUEUE"
  | "CAPTCHA"
  | "LOGIN_REQUIRED"
  | "MANUAL_SELECTION"
  | "BLOCKED"
  | "HUMAN_REQUIRED_HEADLESS"
  | "CART_MISMATCH"
  | "CART_UNVERIFIED"
  | "SELECTOR_NOT_FOUND"
  | "RATE_LIMITED"
  | "AUTHORIZATION_EXPIRED"
  | "LOCK_LOST"
  | "ADAPTER_ERROR";

export const reasonForState = (s: BlockingState): FailureReason => s;
