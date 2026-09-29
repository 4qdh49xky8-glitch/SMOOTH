/**
 * Génère le squelette d'un nouvel adaptateur :
 *   npm run new-site -- <id> "Nom affiché"
 * Crée src/sites/<Pascal>.ts, src/selectors/<id>.ts, tests/<id>.test.ts.
 * Le squelette est VOLONTAIREMENT non conforme : la déclaration d'autorisation (meta.compliance) contient
 * des TODO, donc `npm run test:adapters` échoue et le cœur refuse de le lancer tant que vous n'avez pas
 * lu les CGU du site et renseigné la base d'autorisation.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const toPascal = (id: string): string => id.split("-").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
export const toCamel = (id: string): string => {
  const p = toPascal(id);
  return p.charAt(0).toLowerCase() + p.slice(1);
};

export function renderNewSite(id: string, displayName: string): Record<string, string> {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error("id : minuscules, chiffres et tirets uniquement (ex. mon-site)");
  const P = toPascal(id);
  const c = toCamel(id);
  const name = displayName.replace(/["\\]/g, "");
  return {
    [`src/sites/${P}.ts`]: `import { BaseSiteAdapter } from "./BaseSiteAdapter.js";
import { ${c}Selectors as S } from "../selectors/${id}.js";
import type { AdapterContext, AdapterMeta, CartSummary, Offer, SaleSnapshot } from "./SiteAdapter.js";
// import { seatsAreContiguous } from "../agent/matcher.js";          // pour calculer Offer.seatsTogether depuis des numéros de sièges
// import { BlockerError, OfferUnavailableError, RateLimitedError } from "../utils/errors.js";

/**
 * Adaptateur « ${name} ».
 * AVANT toute ligne de code : lisez les CGU/règles d'achat et la documentation développeur du site
 * (docs/ADDING_A_SITE.md, étape 0). Si l'automatisation est interdite, SUPPRIMEZ ce fichier.
 */
export default class ${P} extends BaseSiteAdapter {
  readonly meta: AdapterMeta = {
    id: "${id}",
    displayName: "${name}",
    compliance: {
      policy: "permitted-by-terms", // TODO(COMPLIANCE) "official-api" (API/partenariat officiel) ou "permitted-by-terms" (CGU l'autorisant expressément)
      termsUrl: "TODO", //             TODO(COMPLIANCE) https://… page des CGU / de l'API qui fonde l'autorisation
      reviewedAt: "1970-01-01", //     TODO(COMPLIANCE) date de relecture AAAA-MM-JJ (expire après 180 jours)
      notes: "TODO", //                TODO(COMPLIANCE) ce que les CGU autorisent exactement, limites d'achat, cadence tolérée
    },
    capabilities: {
      officialApi: false, //              true si vous utilisez une API officielle plutôt que des pages
      preciseServerTime: false, //        true si vous implémentez getServerTime()
      lightweightAvailability: false, //  true si fetchSale() n'a pas besoin de rendre une page
      reportsSeatAdjacency: false, //     true si le site dit si des places sont côte à côte
      seatSelection: "none", //           "none" | "automatic" (implémentez selectSeats) | "manual" (l'humain choisit)
    },
  };

  // Astuce : si paymentUrlPatterns par défaut (/payment, /paiement, /checkout/pay) ne couvre pas ce site, surchargez-le.
  // override readonly paymentUrlPatterns = [/\\/mon-chemin-de-paiement(\\/|\\?|$)/];

  // override resolveEventUrl(config) { return config.event.url ?? "https://…"; }

  /** La session du compte EXISTANT est-elle active ? (connexion manuelle : npm run login) */
  protected async isLoggedIn(_ctx: AdapterContext): Promise<boolean> {
    throw new Error("TODO: isLoggedIn");
  }

  /** Léger et sans rendu si possible. Lever RateLimitedError sur 429. Ne jamais contourner une file/un CAPTCHA. */
  async fetchSale(_ctx: AdapterContext): Promise<SaleSnapshot> {
    throw new Error("TODO: fetchSale");
  }

  /** Ouvrir l'offre et régler la quantité. Lever OfferUnavailableError si vendue. */
  async selectOffer(_ctx: AdapterContext, _offer: Offer, _quantity: number): Promise<void> {
    void S;
    throw new Error("TODO: selectOffer");
  }

  // async selectSeats(ctx: AdapterContext, offer: Offer, quantity: number): Promise<void> {}
  //   → si le choix doit être humain : throw new BlockerError({ state: "MANUAL_SELECTION", message: "Choisissez vos places" });

  /** Cliquer « Ajouter au panier » (JAMAIS un bouton de paiement), attendre confirmation OU OfferUnavailableError. */
  async addToCart(_ctx: AdapterContext): Promise<void> {
    throw new Error("TODO: addToCart");
  }

  async readCart(_ctx: AdapterContext): Promise<CartSummary> {
    throw new Error("TODO: readCart");
  }
}
`,
    [`src/selectors/${id}.ts`]: `import type { SelectorSpec } from "./resolver.js";

/** Sélecteurs de « ${name} » : du plus stable (data-testid, rôle, aria) au plus fragile (texte, classes). */
export const ${c}Selectors = {
  addToCart: {
    name: "addToCart",
    description: "Bouton « Ajouter au panier » (jamais un bouton de paiement)",
    candidates: [/* TODO */ '[data-testid="add-to-cart"]'],
  },
} satisfies Record<string, SelectorSpec>;
`,
    [`tests/${id}.test.ts`]: `import assert from "node:assert/strict";
import { test } from "node:test";
import ${P} from "../src/sites/${P}.js";
import { checkAdapterContract } from "../src/sites/contract.js";

const adapter = new ${P}();

test("${id} : respecte le contrat (autorisation renseignée, garde-fou de paiement, code source)", () => {
  const errors = checkAdapterContract(adapter, { sourceFile: "src/sites/${P}.ts" }).filter((i) => i.severity === "error");
  assert.deepEqual(errors.map((e) => e.message), []);
});

// Ajoutez ici des tests sur des pages/réponses ENREGISTRÉES (tests/fixtures/${id}/…), jamais sur une vente réelle :
//  - fetchSale normalise prix, catégorie, quantité, adjacence des places ;
//  - detectBlocker reconnaît la file d'attente / le CAPTCHA / la limite d'achat sur les pages enregistrées ;
//  - paymentUrlPatterns bloque l'URL de paiement et laisse passer les pages événement/panier.
test("${id} : fetchSale normalise les offres (fixtures)", { todo: true }, () => {});
test("${id} : detectBlocker reconnaît file / CAPTCHA / limite d'achat (fixtures)", { todo: true }, () => {});
`,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [id, ...rest] = process.argv.slice(2);
  if (!id) {
    console.error('Usage : npm run new-site -- <id> "Nom affiché"');
    process.exit(1);
  }
  const files = renderNewSite(id, rest.join(" ") || id);
  for (const path of Object.keys(files)) {
    if (existsSync(path)) {
      console.error(`Refus : ${path} existe déjà.`);
      process.exit(1);
    }
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(path)), { recursive: true });
    writeFileSync(path, content);
    console.log(`créé  ${path}`);
  }
  console.log(`
Prochaines étapes (docs/ADDING_A_SITE.md) :
  1. Lisez les CGU et la doc développeur du site. Automatisation interdite → supprimez ces 3 fichiers et arrêtez-vous.
  2. Renseignez meta.compliance (les TODO(COMPLIANCE)) : sans cela, npm run test:adapters échoue et le cœur refuse de démarrer.
  3. Implémentez les méthodes, puis : npm run sites && npm run test:adapters
  4. Testez sur des pages enregistrées et en simulation, jamais sur une vente réelle sans votre présence.`);
}
