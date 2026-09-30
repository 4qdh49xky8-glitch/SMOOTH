/**
 * Génère le squelette d'un adaptateur :
 *   npm run new-site -- <id> "Nom affiché" [--platform <id-catalogue>] [--channel api|browser] [--dry-run]
 *
 * Le squelette dépend du STATUT de la plateforme (déduit des preuves officielles de platforms/evidence/) :
 *  - API_ONLY | BROWSER_ONLY | API_AND_BROWSER et canal autorisé → squelette « utilisable » : autorisation, canal et références de preuve pré-remplis
 *    (les méthodes restent à écrire) ;
 *  - NOT_VERIFIED / EXPIRED / plateforme absente du catalogue → squelette EXPLICITEMENT marqué NOT_VERIFIED
 *    (`@skeleton-status NOT_VERIFIED`) : le contrat le refuse, le cœur ne peut pas l'exécuter ;
 *  - NOT_ALLOWED / HUMAN_ONLY (ou canal demandé non autorisé) → AUCUN fichier n'est créé.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { findPlatform, loadCatalog, stateOf, type Catalog, type PlatformStatus } from "../src/platforms/catalog.js";

export const toPascal = (id: string): string => id.split("-").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
export const toCamel = (id: string): string => {
  const p = toPascal(id);
  return p.charAt(0).toLowerCase() + p.slice(1);
};
const clean = (s: string): string => s.replace(/["\\`$\r\n]+/g, " ").trim();

export interface RenderContext {
  platform: string;
  channel: "official-api" | "browser";
  /** true : une preuve officielle valide autorise ce canal. */
  verified: boolean;
  status: PlatformStatus | "ABSENT_DU_CATALOGUE";
  reasons: string[];
  evidence?: { url: string; checkedAt: string; authorization: string };
}

export type NewSitePlan =
  | { kind: "refused"; status: string; message: string }
  | { kind: "skeleton"; verified: boolean; status: string; files: Record<string, string>; notes: string[] };

/** Décide quoi générer à partir du catalogue (donc des preuves). */
export function planNewSite(catalog: Catalog, id: string, displayName: string, o: { platform?: string; channel?: "api" | "browser"; now?: number } = {}): NewSitePlan {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error("id : minuscules, chiffres et tirets uniquement (ex. mon-site)");
  const platform = o.platform ?? id;
  const entry = findPlatform(catalog, platform);
  const st = entry ? stateOf(catalog, platform, o.now) : undefined;
  const wanted = o.channel === "api" ? "official-api" : o.channel === "browser" ? "browser" : undefined;

  if (st?.status === "NOT_ALLOWED" || st?.status === "HUMAN_ONLY") {
    return { kind: "refused", status: st.status, message: `Plateforme « ${platform} » : ${st.status} (${st.reasons.join("; ")}). Aucun adaptateur ne doit exister : rien n'a été créé. Reste possible : le canal humain (rappels).` };
  }
  if (st && st.channels.length > 0) {
    const channel = wanted ?? st.channels[0]!;
    if (!st.channels.includes(channel)) {
      return { kind: "refused", status: st.status, message: `Plateforme « ${platform} » : ${st.status}, mais le canal « ${channel} » n'est pas autorisé par les preuves (autorisés : ${st.channels.join(", ")}). Rien n'a été créé.` };
    }
    // La preuve citée est celle qui autorise CE canal (api/both pour l'API, browser/both pour l'interface).
    const grants = channel === "official-api" ? ["api", "both"] : ["browser", "both"];
    const ev = st.history.find((h) => h.topic === "automation" && !h.expired && grants.includes(h.channel ?? ""))!;
    const ctx: RenderContext = { platform, channel, verified: true, status: st.status, reasons: st.reasons, evidence: { url: ev.url, checkedAt: ev.checkedAt, authorization: ev.authorization } };
    return { kind: "skeleton", verified: true, status: st.status, files: renderNewSite(id, displayName, ctx), notes: [`autorisation issue de la preuve du ${ev.checkedAt} (${ev.url}), valable jusqu'au ${st.expiresAt}`] };
  }
  // NOT_VERIFIED, EXPIRED ou plateforme absente : squelette explicitement non vérifié.
  const status = st?.status ?? "ABSENT_DU_CATALOGUE";
  const ctx: RenderContext = { platform, channel: wanted ?? "browser", verified: false, status, reasons: st?.reasons ?? ["plateforme absente de platforms/catalog.json"] };
  const notes = [
    `statut ${status} : le squelette est marqué NOT_VERIFIED — non exécutable, refusé par le contrat.`,
    entry ? `Pour le débloquer : npm run platform verify ${platform}` : `Ajoutez d'abord la plateforme à platforms/catalog.json (avec ses domaines officiels), puis : npm run platform verify ${platform}`,
  ];
  return { kind: "skeleton", verified: false, status, files: renderNewSite(id, displayName, ctx), notes };
}

export function renderNewSite(id: string, displayName: string, ctx?: RenderContext): Record<string, string> {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error("id : minuscules, chiffres et tirets uniquement (ex. mon-site)");
  const P = toPascal(id);
  const c = toCamel(id);
  const name = clean(displayName);
  const x: RenderContext = ctx ?? { platform: id, channel: "browser", verified: false, status: "NOT_VERIFIED", reasons: [] };
  const isApi = x.channel === "official-api";
  const ENV = `${id.toUpperCase().replace(/-/g, "_")}_API_KEY`;

  const header = x.verified
    ? `/**
 * @skeleton-status VERIFIED — méthodes à implémenter
 * Adaptateur « ${name} » (${x.channel}). Autorisation fondée sur la preuve officielle du ${x.evidence!.checkedAt} : ${x.evidence!.url}
 * (statut ${x.status}). Elle expire 180 jours après cette date : revérifiez-la (npm run platform verify ${x.platform}).
 */`
    : `/**
 * @skeleton-status NOT_VERIFIED
 * Adaptateur « ${name} » : squelette NON VÉRIFIÉ, NON EXÉCUTABLE.
 * Statut de la plateforme « ${x.platform} » : ${x.status}${x.reasons.length ? ` (${clean(x.reasons.join("; "))})` : ""}.
 * Le contrat le refuse et le cœur ne le lance pas tant qu'aucune preuve officielle valide n'autorise son canal.
 * Étapes : npm run platform verify ${x.platform} → consigner les preuves (platforms/evidence/) → régénérer ce squelette.
 */`;

  const compliance = x.verified
    ? `{
      policy: "${isApi ? "official-api" : "permitted-by-terms"}",
      termsUrl: "${x.evidence!.url}", // source de la preuve officielle (platforms/evidence/)
      reviewedAt: "${x.evidence!.checkedAt}",
      notes: "${clean(x.evidence!.authorization).slice(0, 200)}",
    }`
    : `{
      policy: "${isApi ? "official-api" : "permitted-by-terms"}",
      termsUrl: "TODO", //         TODO(COMPLIANCE) URL de la preuve officielle
      reviewedAt: "1970-01-01", // TODO(COMPLIANCE) date de la preuve (AAAA-MM-JJ)
      notes: "TODO", //            TODO(COMPLIANCE) ce que la source autorise exactement
    }`;

  const adapter = isApi
    ? `import { BaseApiAdapter } from "../api/BaseApiAdapter.js";
// import { ApiClient } from "../api/ApiClient.js"; // client HTTP encadré (https, hôte verrouillé, cadence plafonnée, secret par variable d'environnement)
import type { AdapterContext, AdapterMeta, CartSummary, Offer, SaleSnapshot } from "../sites/SiteAdapter.js";

${header}
export default class ${P} extends BaseApiAdapter {
  readonly meta: AdapterMeta = {
    id: "${id}",
    displayName: "${name}",
    platform: "${x.platform}",
    channel: "official-api",
    requires: { env: ["${ENV}"] }, // NOM de la variable d'environnement du secret : jamais sa valeur
    compliance: ${compliance},
    capabilities: {
      officialApi: true,
      preciseServerTime: false,
      lightweightAvailability: true,
      reportsSeatAdjacency: false,
      seatSelection: "none",
      // maxTicketsPerOrder: 4, // limite d'achat officielle, si documentée
    },
  };

  /** Authentification OFFICIELLE : secret lu dans l'environnement. Jamais de formulaire, jamais de création de compte. */
  async authenticate(_ctx: AdapterContext): Promise<void> {
    throw new Error("TODO: authenticate");
  }
  async listOffers(_ctx: AdapterContext): Promise<SaleSnapshot> {
    throw new Error("TODO: listOffers");
  }
  async holdOffer(_ctx: AdapterContext, _offer: Offer, _quantity: number): Promise<void> {
    throw new Error("TODO: holdOffer");
  }
  /** Réservation / panier via l'API officielle. JAMAIS un paiement. */
  async reserve(_ctx: AdapterContext): Promise<void> {
    throw new Error("TODO: reserve");
  }
  async readReservation(_ctx: AdapterContext): Promise<CartSummary> {
    throw new Error("TODO: readReservation");
  }
  // async queueStatus(ctx): Promise<"none" | "waiting" | "admitted"> — file d'attente officielle de l'API (jamais contournée)
}
`
    : `import { BaseSiteAdapter } from "./BaseSiteAdapter.js";
import { ${c}Selectors as S } from "../selectors/${id}.js";
import type { AdapterContext, AdapterMeta, CartSummary, Offer, SaleSnapshot } from "./SiteAdapter.js";

${header}
export default class ${P} extends BaseSiteAdapter {
  readonly meta: AdapterMeta = {
    id: "${id}",
    displayName: "${name}",
    platform: "${x.platform}",
    channel: "browser",
    compliance: ${compliance},
    capabilities: {
      officialApi: false,
      preciseServerTime: false,
      lightweightAvailability: false,
      reportsSeatAdjacency: false,
      seatSelection: "none",
    },
  };

  /** La session du compte EXISTANT est-elle active ? (connexion manuelle : npm run login) */
  protected async isLoggedIn(_ctx: AdapterContext): Promise<boolean> {
    throw new Error("TODO: isLoggedIn");
  }
  /** Léger et sans rendu si possible. Lever RateLimitedError sur 429. Ne jamais contourner une file/un CAPTCHA. */
  async fetchSale(_ctx: AdapterContext): Promise<SaleSnapshot> {
    throw new Error("TODO: fetchSale");
  }
  async selectOffer(_ctx: AdapterContext, _offer: Offer, _quantity: number): Promise<void> {
    void S;
    throw new Error("TODO: selectOffer");
  }
  /** Cliquer « Ajouter au panier » (JAMAIS un bouton de paiement). */
  async addToCart(_ctx: AdapterContext): Promise<void> {
    throw new Error("TODO: addToCart");
  }
  async readCart(_ctx: AdapterContext): Promise<CartSummary> {
    throw new Error("TODO: readCart");
  }
}
`;

  const files: Record<string, string> = {
    [`src/sites/${P}.ts`]: adapter,
    [`tests/${id}.test.ts`]: `import assert from "node:assert/strict";
import { test } from "node:test";
import { loadCatalog } from "../src/platforms/catalog.js";
import ${P} from "../src/sites/${P}.js";
import { checkAdapterContract } from "../src/sites/contract.js";

const adapter = new ${P}();
const errors = () => checkAdapterContract(adapter, { sourceFile: "src/sites/${P}.ts", catalog: loadCatalog() }).filter((i) => i.severity === "error");

${
  x.verified
    ? `test("${id} : respecte le contrat (autorisation par preuve officielle valide, garde-fous, code source)", () => {
  assert.deepEqual(errors().map((e) => e.message), []);
});`
    : `test("${id} : squelette NOT_VERIFIED — non exécutable tant que la plateforme n'a pas de preuve officielle valide", () => {
  const codes = errors().map((e) => e.code);
  assert.ok(codes.includes("SKELETON_NOT_VERIFIED"));
  assert.ok(codes.includes("PLATFORM_AUTH") || codes.includes("COMPLIANCE"));
});`
}

// Ajoutez ici des tests sur des pages/réponses ENREGISTRÉES (tests/fixtures/${id}/…), jamais sur une vente réelle :
//  - la normalisation des offres (prix, catégorie, quantité, adjacence) ;
//  - la détection de file d'attente / CAPTCHA / limite d'achat ;
//  - ${isApi ? "les erreurs de l'API (429, 401, 403, 409) remontées au cœur sans contournement" : "paymentUrlPatterns : bloque l'URL de paiement, laisse passer événement/panier"}.
test("${id} : normalisation des offres (fixtures)", { todo: true }, () => {});
`,
  };
  if (!isApi) {
    files[`src/selectors/${id}.ts`] = `import type { SelectorSpec } from "./resolver.js";

/** Sélecteurs de « ${name} » : du plus stable (data-testid, rôle, aria) au plus fragile (texte, classes). */
export const ${c}Selectors = {
  addToCart: {
    name: "addToCart",
    description: "Bouton « Ajouter au panier » (jamais un bouton de paiement)",
    candidates: [/* TODO */ '[data-testid="add-to-cart"]'],
  },
} satisfies Record<string, SelectorSpec>;
`;
  }
  return files;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const flag = (n: string): string | undefined => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && ["--platform", "--channel"].includes(args[i - 1]!)));
  const [id, ...rest] = positional;
  if (!id) {
    console.error('Usage : npm run new-site -- <id> "Nom affiché" [--platform <id-catalogue>] [--channel api|browser] [--dry-run]');
    process.exit(1);
  }
  const channel = flag("channel") as "api" | "browser" | undefined;
  if (channel && !["api", "browser"].includes(channel)) {
    console.error("--channel ∈ api | browser");
    process.exit(1);
  }
  const plan = planNewSite(loadCatalog(), id, rest.join(" ") || id, { platform: flag("platform"), channel });
  if (plan.kind === "refused") {
    console.error(`✗ ${plan.message}`);
    process.exit(1);
  }
  for (const path of Object.keys(plan.files)) {
    if (existsSync(path)) {
      console.error(`Refus : ${path} existe déjà.`);
      process.exit(1);
    }
  }
  const dry = args.includes("--dry-run");
  for (const [path, content] of Object.entries(plan.files)) {
    if (!dry) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    console.log(`${dry ? "(simulation) " : ""}créé  ${path}`);
  }
  console.log(`\nStatut : ${plan.status} — squelette ${plan.verified ? "UTILISABLE (méthodes à écrire)" : "NOT_VERIFIED (non exécutable)"}`);
  for (const n of plan.notes) console.log(`  · ${n}`);
  console.log(`
Ensuite : npm run sites → npm run platforms -- --check → npm run test:adapters. Tests sur pages/réponses enregistrées et en
simulation, jamais sur une vente réelle sans votre présence.`);
}
