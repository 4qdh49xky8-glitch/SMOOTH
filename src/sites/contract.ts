import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { authorizeAdapter } from "../platforms/authorize.js";
import type { Catalog } from "../platforms/catalog.js";
import { assertCompliant } from "./compliance.js";
import type { SiteAdapter } from "./SiteAdapter.js";

export interface ContractIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
}

const REQUIRED_METHODS = ["resolveEventUrl", "ensureLoggedIn", "prepare", "fetchSale", "selectOffer", "addToCart", "readCart", "detectBlocker"] as const;
const CAPABILITY_KEYS = ["officialApi", "preciseServerTime", "lightweightAvailability", "reportsSeatAdjacency", "seatSelection"] as const;

/**
 * Heuristique de revue (NON exhaustive) : motifs qui n'ont aucune place dans un adaptateur, car ils
 * relèvent d'un contournement de protection, d'une multiplication d'identités ou d'un paiement automatisé.
 * Les commentaires sont ignorés avant analyse.
 */
export const FORBIDDEN_SOURCE_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /2captcha|anti-?captcha|capsolver|deathbycaptcha|solve-?captcha|captcha[-_ ]?solver/i, why: "résolution automatique de CAPTCHA" },
  { re: /stealth|undetected|AutomationControlled|navigator\.webdriver|fingerprint|spoof|setUserAgent/i, why: "masquage de l'automatisation / usurpation d'empreinte" },
  { re: /bypass|circumvent/i, why: "contournement d'un mécanisme de protection" },
  { re: /proxy[-_ ]?(rotat|pool)|rotateProxy|residential[-_ ]?proxy/i, why: "rotation de proxys / multiplication d'identités" },
  { re: /createAccount|registerAccount|registerUser|signUp\(|fakeAccount|generateAccount/i, why: "création de comptes" },
  { re: /\.(click|press|tap|dblclick)\([^)]*(payer|paiement|pay(ment)?\b|commander|place[-_ ]?order|confirm[-_ ]?order)/i, why: "clic sur un bouton de paiement" },
  { re: /card[-_ ]?number|\bcvv\b|\bcvc\b|\biban\b|cardholder/i, why: "manipulation de données bancaires" },
  { re: /autoPayment\s*[:=]\s*true/i, why: "paiement automatique" },
];

/** Retire // et /* *​/ (approximatif) pour ne scanner que le code. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

export function scanSource(source: string): ContractIssue[] {
  const code = stripComments(source);
  return FORBIDDEN_SOURCE_PATTERNS.filter((p) => p.re.test(code)).map((p) => ({
    severity: "error" as const,
    code: "FORBIDDEN_PATTERN",
    message: `motif interdit détecté (${p.why}) : ${p.re.source.slice(0, 60)}`,
  }));
}

/** Vérifie qu'un adaptateur respecte le contrat SiteAdapter et les garde-fous de la plateforme. */
export function checkAdapterContract(adapter: SiteAdapter, opts: { sourceFile?: string; now?: number; catalog?: Catalog } = {}): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const err = (code: string, message: string): void => void issues.push({ severity: "error", code, message });
  const warn = (code: string, message: string): void => void issues.push({ severity: "warning", code, message });
  const meta = adapter.meta;

  if (!meta) return [{ severity: "error", code: "META_MISSING", message: "meta absent" }];
  if (!/^[a-z0-9-]+$/.test(meta.id ?? "")) err("META_ID", "meta.id doit être en minuscules (a-z, 0-9, -)");
  if (!meta.displayName) err("META_NAME", "meta.displayName manquant");

  for (const m of REQUIRED_METHODS) if (typeof adapter[m] !== "function") err("METHOD_MISSING", `méthode ${m}() manquante`);

  const caps = meta.capabilities as Record<string, unknown> | undefined;
  if (!caps) err("CAPS_MISSING", "meta.capabilities manquant");
  else {
    for (const k of CAPABILITY_KEYS) if (caps[k] === undefined) err("CAPS_INCOMPLETE", `capabilities.${k} manquant`);
    if (!["none", "automatic", "manual"].includes(String(caps.seatSelection))) err("CAPS_SEATS", "capabilities.seatSelection ∈ none | automatic | manual");
    if (caps.seatSelection === "automatic" && typeof adapter.selectSeats !== "function") err("SEATS_METHOD", "seatSelection=automatic exige selectSeats()");
    const cap = caps.maxTicketsPerOrder;
    if (cap !== undefined && (!Number.isInteger(cap) || (cap as number) < 1)) err("CAPS_LIMIT", "capabilities.maxTicketsPerOrder doit être un entier ≥ 1");
    if (caps.preciseServerTime === true && typeof adapter.getServerTime !== "function") err("CLOCK_METHOD", "preciseServerTime=true exige getServerTime()");
    if (meta.compliance?.policy === "official-api" && caps.officialApi !== true) err("OFFICIAL_API", "policy=official-api exige capabilities.officialApi=true");
  }

  const url = meta.compliance?.policy === "demo" ? "http://127.0.0.1/e" : "https://example.com/e";
  try {
    assertCompliant(meta, url, opts.now);
  } catch (e) {
    err("COMPLIANCE", (e as Error).message.replace(/^Adaptateur « [^»]+ » refusé : /, ""));
  }

  // Autorisation par le catalogue des plateformes : pas de preuve officielle → pas d'adaptateur exécutable.
  if (opts.catalog && meta.compliance?.policy && meta.compliance.policy !== "demo") {
    const auth = authorizeAdapter(meta, opts.catalog, opts.now);
    if (!auth.ok) err("PLATFORM_AUTH", auth.reason ?? "plateforme non autorisée");
  }
  const req = meta.requires?.env;
  if (req && (!Array.isArray(req) || req.some((k) => !/^[A-Z][A-Z0-9_]*$/.test(k)))) err("REQUIRES_ENV", "meta.requires.env : noms de variables en MAJUSCULES (jamais de valeur dans le code)");

  // Aucune méthode de paiement, quel que soit le canal : le paiement reste toujours humain.
  const methodNames = new Set<string>();
  for (let o: object | null = adapter; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) if (typeof (adapter as unknown as Record<string, unknown>)[k] === "function") methodNames.add(k);
  }
  for (const m of methodNames) if (/^(pay|payment|checkout|purchase|placeOrder|confirmOrder|charge|settle)/i.test(m)) err("PAYMENT_METHOD", `méthode « ${m}() » interdite : un adaptateur ne paie jamais`);

  const isApi = (adapter as { isApiAdapter?: boolean }).isApiAdapter === true;
  if (isApi) {
    // Adaptateur API : pas de navigateur, donc pas d'URL de paiement à garder ; en revanche le canal doit être déclaré.
    if (meta.channel !== "official-api") err("API_CHANNEL", "un adaptateur API doit déclarer meta.channel = \"official-api\"");
    if (meta.capabilities?.officialApi !== true) err("API_CHANNEL", "un adaptateur API doit déclarer capabilities.officialApi = true");
    if (meta.compliance?.policy === "permitted-by-terms") err("API_POLICY", "un adaptateur API relève de policy « official-api »");
    if (!meta.requires?.env?.length && meta.compliance?.policy !== "demo") warn("API_SECRET", "meta.requires.env : déclarez la variable d'environnement du secret de l'API (jamais sa valeur)");
  } else if (meta.channel === "official-api") {
    err("API_CHANNEL", "channel « official-api » réservé aux adaptateurs qui étendent BaseApiAdapter (aucun navigateur)");
  }

  const patterns = adapter.paymentUrlPatterns;
  if (isApi) {
    /* pas de garde-fou navigateur */
  } else if (!Array.isArray(patterns) || patterns.length === 0) err("PAYMENT_GUARD", "paymentUrlPatterns vide : le garde-fou de paiement serait inactif");
  else {
    for (const p of patterns) {
      if (p.global || p.sticky) err("PAYMENT_GUARD_FLAGS", `le motif ${p} ne doit pas avoir de drapeau g/y (test() devient à état)`);
      for (const harmless of ["https://x.example/", "https://x.example/event", "https://x.example/cart", "https://x.example/panier"]) {
        if (new RegExp(p.source, p.flags.replace(/[gy]/g, "")).test(harmless)) err("PAYMENT_GUARD_BROAD", `le motif ${p} bloquerait ${harmless} : trop large`);
      }
    }
    if (!patterns.some((p) => new RegExp(p.source, p.flags.replace(/[gy]/g, "")).test("https://x.example/payment") || /paiement|pay|checkout|order|commande/i.test(p.source)))
      warn("PAYMENT_GUARD_NARROW", "aucun motif ne ressemble à une URL de paiement usuelle : vérifiez-les");
  }

  if (opts.sourceFile) {
    const files = [opts.sourceFile, join(dirname(opts.sourceFile), "..", "selectors", `${meta.id}.ts`)];
    for (const f of files) {
      if (!existsSync(f)) continue;
      // Un squelette généré pour une plateforme non vérifiée porte le marqueur : il ne peut pas être livré tel quel.
      if (/@skeleton-status\s+NOT_VERIFIED/.test(readFileSync(f, "utf8"))) issues.push({ severity: "error", code: "SKELETON_NOT_VERIFIED", message: `${f.split("/").slice(-2).join("/")} : squelette NOT_VERIFIED — obtenez d'abord une preuve officielle valide (npm run platform verify), puis régénérez ou retirez le marqueur` });
      for (const i of scanSource(readFileSync(f, "utf8"))) issues.push({ ...i, message: `${f.split("/").slice(-2).join("/")} : ${i.message}` });
    }
  }
  return issues;
}
