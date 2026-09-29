import { z } from "zod";

const isoWithOffset = (s: string): boolean =>
  !Number.isNaN(Date.parse(s)) && /(Z|[+-]\d{2}:\d{2})$/.test(s);

export const TicketsSchema = z.object({
  quantity: z.number().int().min(1).max(10),
  maxPricePerTicket: z.number().positive(),
  /** Catégories acceptées, l'ordre = préférence. Liste vide = toutes les catégories. */
  categories: z.array(z.string().min(1)).default([]),
  /** Préférer les places côte à côte (quand le site fournit l'information). */
  seatsTogether: z.boolean().default(true),
  /** Si true, refuser les offres dont la contiguïté n'est pas confirmée. */
  seatsTogetherStrict: z.boolean().default(false),
});

export const ConfigSchema = z.object({
  /** Identifiant d'un adaptateur présent dans src/sites/ (voir `npm run check -- --list-sites`). */
  site: z.string().min(1),
  /** Réglages propres à l'adaptateur (libres, validés par l'adaptateur lui-même). */
  siteOptions: z.record(z.unknown()).default({}),
  event: z.object({
    name: z.string().min(1),
    /** Date de l'événement (informative), AAAA-MM-JJ. */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Format AAAA-MM-JJ").optional(),
    /** URL de la page de l'événement (sinon celle par défaut de l'adaptateur). */
    url: z.string().url().optional(),
  }),
  sale: z.object({
    /** Heure officielle d'ouverture, ISO 8601 AVEC fuseau (ex. 2026-10-01T10:00:00+02:00). */
    startTime: z.string().refine(isoWithOffset, "Format ISO 8601 avec fuseau horaire requis"),
  }),
  tickets: TicketsSchema,
  behavior: z
    .object({
      autoAddToCart: z.boolean().default(true),
      /** Le paiement automatique n'existe pas : le paiement reste toujours manuel. */
      autoPayment: z
        .literal(false, {
          errorMap: () => ({
            message: "behavior.autoPayment doit rester false : le paiement est toujours effectué manuellement.",
          }),
        })
        .default(false),
    })
    .default({}),
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

export type TicketCriteria = BotConfig["tickets"];
