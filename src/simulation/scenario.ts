import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";

export const ERROR_CODES = [
  "OFFER_UNAVAILABLE",
  "RATE_LIMITED",
  "QUEUE",
  "CAPTCHA",
  "BLOCKED",
  "LOGIN_REQUIRED",
  "MANUAL_SELECTION",
  "PURCHASE_LIMIT",
  "ERROR",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const STEPS = ["login", "fetchSale", "selectOffer", "selectSeats", "addToCart", "readCart"] as const;

/** Un scénario décrit un « faux site » : offres qui apparaissent/disparaissent, pannes et blocages injectés. */
export const ScenarioSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  /** La vente ouvre N ms après `sale.startTime` (heure serveur simulée). */
  saleOpensAfterMs: z.number().min(0).default(0),
  /** Décalage de l'horloge du faux serveur par rapport à la machine (teste la synchronisation d'horloge). */
  serverClockSkewMs: z.number().default(0),
  /** Latence simulée par étape (ms). */
  latencyMs: z.record(z.enum(STEPS), z.number().min(0)).default({}),
  /** Durée que met « l'humain » à traiter une file/un CAPTCHA/une connexion. */
  humanResolveMs: z.number().min(0).default(150),
  /** Durée maximale de surveillance après l'ouverture. */
  maxWaitMs: z.number().min(200).default(6000),
  /** Le faux site affiche « complet » (SOLD_OUT). */
  soldOut: z.boolean().default(false),
  /** Surcharge partielle de la configuration (fusion profonde) : rend le scénario autonome, indépendant du profil. */
  config: z.record(z.unknown()).optional(),
  /** Limite d'achat du faux site (billets par commande). */
  purchaseLimit: z.number().int().min(1).optional(),
  /** true (défaut) : l'adaptateur déclare la limite (meta) ; false : elle n'est révélée qu'au moment de la sélection. */
  declareLimit: z.boolean().default(true),
  /** Fenêtres pendant lesquelles le faux site est en file d'attente / CAPTCHA / contrôle anti-bot (ms après sale.startTime). */
  blockWindows: z
    .array(z.object({ state: z.enum(["QUEUE", "CAPTCHA", "BLOCKED"]), fromMs: z.number().min(0), untilMs: z.number().min(1) }))
    .default([]),
  /** Ce que le faux site met réellement au panier (simule un ajout partiel). */
  cart: z.object({ itemCount: z.number().int().min(0).optional(), unitPrice: z.number().optional() }).optional(),
  /** false : personne pour traiter les blocages (navigateur headless) — le bot doit s'arrêter proprement. */
  humanAvailable: z.boolean().default(true),
  /** Les messages d'erreur du faux site contiennent des secrets factices (URL à jeton, e-mail, carte) : vérifie l'assainissement. */
  leakCanaries: z.boolean().default(false),
  offers: z
    .array(
      z.object({
        id: z.string(),
        category: z.string(),
        price: z.number(),
        currency: z.string().default("EUR"),
        available: z.number().int().min(0),
        section: z.string().optional(),
        row: z.string().optional(),
        seats: z.array(z.string()).optional(),
        /** Apparition retardée (ms après l'ouverture de la vente). */
        appearsAtMs: z.number().min(0).default(0),
        /** Vendue à ce moment (ms après l'ouverture) : disparaît de la liste. */
        soldAtMs: z.number().min(0).optional(),
      }),
    )
    .default([]),
  /** Pannes/blocages injectés : à la nᵉ exécution de l'étape, lever l'erreur indiquée. */
  failures: z
    .array(z.object({ step: z.enum(STEPS), nth: z.number().int().min(1).default(1), error: z.enum(ERROR_CODES) }))
    .default([]),
  /** Résultat attendu (vérifié par `simulate --all` et les tests). */
  expect: z
    .object({
      status: z.string().optional(),
      finalState: z.string(),
      failureReason: z.string().optional(),
      attempts: z.number().int().optional(),
      humanHandoffs: z.number().int().optional(),
      offerId: z.string().optional(),
      statesInclude: z.array(z.string()).optional(),
    })
    .optional(),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export const SCENARIOS_DIR = "simulations";

/** Secrets factices injectés dans les messages du faux site quand `leakCanaries` est actif. */
export const CANARIES = {
  token: "CANARY_TOKEN_9f8e7d6c5b4a",
  session: "CANARY_SID_a1b2c3d4e5f6",
  email: "canary.user@example.com",
  card: "4970101234567890",
} as const;

export const canarySuffix = (): string =>
  ` [https://shop.example/queue?token=${CANARIES.token}&sid=${CANARIES.session} — compte ${CANARIES.email} — carte ${CANARIES.card} — password=hunter2secret]`;

export function loadScenario(target: string, dir = SCENARIOS_DIR): Scenario {
  const path = existsSync(target) ? target : join(dir, target.endsWith(".json") ? target : `${target}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`Scénario illisible (${path}) : ${(e as Error).message}. Disponibles : ${listScenarios(dir).join(", ")}`);
  }
  const parsed = ScenarioSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Scénario invalide (${path}) :\n${parsed.error.issues.map((i) => `  - ${i.path.join(".")} : ${i.message}`).join("\n")}`);
  }
  return parsed.data;
}

/** Scénarios d'un dossier ; `recursive` ajoute les sous-dossiers (ex. « stress/01-… »). */
export function listScenarios(dir = SCENARIOS_DIR, recursive = false): string[] {
  try {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith(".json")) out.push(basename(e.name, ".json"));
      else if (recursive && e.isDirectory()) out.push(...listScenarios(join(dir, e.name), true).map((n) => `${e.name}/${n}`));
    }
    return out.sort();
  } catch {
    return [];
  }
}
