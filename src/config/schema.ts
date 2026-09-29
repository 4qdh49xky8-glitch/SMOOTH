import { z } from "zod";

const isoWithOffset = (s: string): boolean =>
  !Number.isNaN(Date.parse(s)) && /(Z|[+-]\d{2}:\d{2})$/.test(s);

export const ConfigSchema = z.object({
  event: z.string().min(1),
  /** Identifiant de l'adaptateur (voir src/sites/registry.ts). */
  site: z.string().default("example"),
  /** URL de la page de l'événement (sinon celle par défaut de l'adaptateur). */
  eventUrl: z.string().url().optional(),
  /** Heure officielle d'ouverture, ISO 8601 AVEC fuseau (ex. 2026-10-01T10:00:00+02:00). */
  saleTime: z.string().refine(isoWithOffset, "Format ISO 8601 avec fuseau horaire requis"),
  quantity: z.number().int().min(1).max(10),
  maxPricePerTicket: z.number().positive(),
  /** Catégories acceptées. L'ordre = ordre de préférence. */
  categories: z.array(z.string().min(1)).min(1),
  /** Préférer les places côte à côte. */
  seatsTogether: z.boolean().default(true),
  /** Si true, refuser les offres dont la contiguïté n'est pas confirmée. */
  seatsTogetherStrict: z.boolean().default(false),
  autoAddToCart: z.boolean().default(true),
  /** Le paiement automatique n'existe pas : le paiement reste toujours manuel. */
  autoPayment: z
    .literal(false, {
      errorMap: () => ({
        message: "autoPayment doit rester false : le paiement est toujours effectué manuellement.",
      }),
    })
    .default(false),
  timing: z
    .object({
      /** Préparation (login, chargement de page, connexions) N secondes avant l'ouverture. */
      preArmSeconds: z.number().min(0).default(90),
      /** Intervalle minimal entre deux interrogations (limitation volontaire de débit). */
      pollIntervalMs: z.number().min(200).default(400),
      pollJitterMs: z.number().min(0).default(50),
      /** Fenêtre de spin précis juste avant l'heure cible. */
      spinThresholdMs: z.number().min(0).default(25),
      maxWaitAfterSaleSeconds: z.number().min(1).default(900),
      actionTimeoutMs: z.number().min(500).default(4000),
    })
    .default({}),
  cart: z
    .object({
      /** Nombre max de tentatives d'ajout (offres épuisées entre-temps, etc.). */
      maxAttempts: z.number().int().min(1).default(5),
    })
    .default({}),
  browser: z
    .object({
      headless: z.boolean().default(false),
      userDataDir: z.string().default(".profile"),
      debugPort: z.number().int().default(9222),
      blockHeavyResources: z.boolean().default(true),
      executablePath: z.string().optional(),
    })
    .default({}),
  claude: z
    .object({
      enabled: z.boolean().default(false),
      model: z.string().default("claude-haiku-4-5-20251001"),
      maxCallsPerRun: z.number().int().min(0).default(6),
      timeoutMs: z.number().min(1000).default(8000),
    })
    .default({}),
  notifications: z
    .object({
      desktop: z.boolean().default(true),
      sound: z.boolean().default(true),
    })
    .default({}),
});

export type BotConfig = z.infer<typeof ConfigSchema>;
