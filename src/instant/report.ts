import type { CallCounts } from "./monitor.js";
import type { InstantTimings } from "./timeline.js";

export type InstantStatus = "CART_SUCCESS" | "SOLD_OUT" | "QUEUE" | "CAPTCHA" | "BLOCKED" | "LOGIN_REQUIRED" | "PURCHASE_LIMIT" | "AUTHORIZATION_EXPIRED" | "NOT_OPEN" | "CART_MISMATCH" | "REFUSED" | "ERROR";

export interface InstantMetrics {
  claudeCallsInCriticalPath: number;
  claudeCallsTotal: number;
  claudeDenied: number;
  /** Appels effectués PAR le cœur à l'adaptateur (chaque lecture ou écriture = une opération réseau possible). */
  calls: CallCounts;
  /** Opérations de l'adaptateur susceptibles d'émettre des requêtes : lectures, sélection, ajout, relecture du panier. */
  networkOperations: number;
  /** Requêtes réellement vues côté serveur de fixture (tests) ; absent en réel. */
  observedRequests?: number;
  retries: number;
  rateLimited: number;
  offersExamined: number;
  polls: number;
  skippedByFeed: number;
  feed: string;
  handoffs: number;
}

export interface InstantSecurity {
  authorization: string;
  channel: string;
  lock: string;
  payment: "MANUAL";
}

export interface InstantReport {
  status: InstantStatus;
  reason?: string;
  timings: InstantTimings;
  prepare: { prepareToBrowserMs: number | null; eventPrepareMs: number | null };
  metrics: InstantMetrics;
  security: InstantSecurity;
  blockersSeen: string[];
  mode: string;
}

const ms = (v: number | null | undefined): string => (v === null || v === undefined ? "—" : `${v} ms`);

/** Tableau de bord final (texte). Le paiement reste MANUEL ; ne contient ni cookie, ni jeton, ni URL, ni donnée de session. */
export function formatDashboard(r: InstantReport): string {
  const t = r.timings;
  const m = r.metrics;
  const l = [
    `STATUS: ${r.status}${r.reason ? ` (${r.reason})` : ""}`,
    "TIMING:",
    `  sale_open_to_availability   ${ms(t.sale_open_to_availability)}`,
    `  availability_to_selection   ${ms(t.availability_to_selection)}`,
    `  selection_to_cart           ${ms(t.selection_to_cart_request)}`,
    `  cart_request_to_success     ${ms(t.cart_request_to_cart_success)}`,
    `  sale_open_to_cart           ${ms(t.total_sale_open_to_cart)}`,
    "PERFORMANCE:",
    `  claude_calls                ${m.claudeCallsInCriticalPath} (chemin critique) / ${m.claudeCallsTotal} (total)`,
    `  network_requests            ${m.observedRequests ?? m.networkOperations} ${m.observedRequests === undefined ? "(opérations d'adaptateur)" : "(vues côté serveur de fixture)"}`,
    `  retries                     ${m.retries}${m.rateLimited ? ` (dont ${m.rateLimited} limite(s) de débit respectée(s))` : ""}`,
    `  offers_examined             ${m.offersExamined}`,
    "SECURITY:",
    `  authorization               ${r.security.authorization}`,
    `  channel                     ${r.security.channel}`,
    `  lock                        ${r.security.lock}`,
    `  payment                     ${r.security.payment}`,
  ];
  if (r.blockersSeen.length) l.splice(1, 0, `BLOCKERS: ${r.blockersSeen.join(", ")} (cession de la main, aucun contournement)`);
  if (r.status === "CART_SUCCESS") l.push("", "CART_SUCCESS", "Payment remains manual.");
  return l.join("\n");
}

/** Rapport de latence (tests locaux) : étapes séparées ; en simulation/fixture, jamais une vitesse d'achat réelle. */
export function formatPerformance(r: InstantReport): string {
  const t = r.timings;
  return [
    "INSTANT SALE PERFORMANCE",
    "Browser ready:",
    `${ms(r.prepare.prepareToBrowserMs)}`,
    "Event ready:",
    `${ms(r.prepare.eventPrepareMs)}`,
    "Sale open → availability:",
    `${ms(t.sale_open_to_availability)}`,
    "Availability → selection:",
    `${ms(t.availability_to_selection)}`,
    "Selection → cart request:",
    `${ms(t.selection_to_cart_request)}`,
    "Cart request → cart success:",
    `${ms(t.cart_request_to_cart_success)}`,
    "Sale open → cart:",
    `${ms(t.total_sale_open_to_cart)}`,
    "Claude calls in critical path:",
    `${r.metrics.claudeCallsInCriticalPath}`,
    "Network retries:",
    `${r.metrics.retries}`,
    "(mesures sur fixture locale : elles ne disent rien de la vitesse d'un achat réel)",
  ].join("\n");
}
