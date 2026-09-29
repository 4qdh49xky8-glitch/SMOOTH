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

export function listScenarios(dir = SCENARIOS_DIR): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => basename(f, ".json")).sort();
  } catch {
    return [];
  }
}
