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

export const CRITERIA = ["seatsTogether", "category", "placement", "price", "fit"] as const;
export type Criterion = (typeof CRITERIA)[number];

/**
 * Stratégie de classement des offres (après filtrage par `tickets`). Tout est optionnel :
 * sans bloc `strategy`, l'ordre est : côte à côte → catégorie (ordre de tickets.categories) → prix croissant.
 */
export const StrategySchema = z.object({
  /**
   * Ordre de priorité des critères (le 1er l'emporte). Un critère absent de la liste est ignoré.
   *  seatsTogether : places côte à côte d'abord (si tickets.seatsTogether)
   *  category      : ordre priorityCategories puis tickets.categories
   *  placement     : sections préférées/évitées puis rang (avant/arrière)
   *  price         : selon priceOrder
   *  fit           : l'offre dont la quantité disponible colle le mieux (évite de laisser des places orphelines)
   */
  priority: z
    .array(z.enum(CRITERIA))
    .min(1)
    .refine((a) => new Set(a).size === a.length, "critères en double")
    .default(["seatsTogether", "category", "placement", "price"]),
  priceOrder: z.enum(["cheapest", "most-expensive"]).default("cheapest"),
  /** Catégories à tenter avant les autres catégories acceptées (dans cet ordre). */
  priorityCategories: z.array(z.string().min(1)).default([]),
  placement: z
    .object({
      preferSections: z.array(z.string().min(1)).default([]),
      avoidSections: z.array(z.string().min(1)).default([]),
      /** Offres exclues d'office si leur section correspond. */
      excludeSections: z.array(z.string().min(1)).default([]),
      rowPreference: z.enum(["front", "back", "any"]).default("any"),
    })
    .default({}),
});
export type Strategy = z.infer<typeof StrategySchema>;

export const ConfigSchema = z.object({
  /** Profil parent (chemin relatif) dont on hérite ; résolu par le chargeur. */
  extends: z.string().optional(),
  /** Identifiant d'un adaptateur présent dans src/sites/ (voir `npm run check -- --list-sites`). */
  site: z.string().min(1),
  /**
   * Canal d'exécution. « auto » (défaut) : API officielle → navigateur → intervention humaine, selon ce que les
   * adaptateurs déclarent ET ce que le catalogue autorise. Un canal forcé ne peut jamais être plus permissif que ce qui est autorisé.
   */
  channel: z.enum(["auto", "official-api", "browser", "human"]).default("auto"),
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
  strategy: StrategySchema.default({}),
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
      /** Intervalle entre deux lectures quand la vente est ouverte mais COMPLÈTE (SOLD_OUT) : évite une surveillance agressive inutile. */
      soldOutPollIntervalMs: z.number().min(200).default(1000),
      maxWaitAfterSaleSeconds: z.number().min(1).default(900),
      actionTimeoutMs: z.number().min(500).default(4000),
    })
    .default({}),
  cart: z
    .object({
      /** Nombre max de tentatives d'ajout (offres épuisées entre-temps, etc.). */
      maxAttempts: z.number().int().min(1).default(5),
      /** Une offre signalée indisponible n'est pas retentée avant ce délai (évite de marteler une liste périmée). */
      unavailableCooldownMs: z.number().min(0).default(3000),
    })
    .default({}),
  browser: z
    .object({
      headless: z.boolean().default(false),
      /** Profil Chromium (votre session). Défaut : `.profile/<nom du profil>` — un navigateur par profil, jamais partagé. */
      userDataDir: z.string().optional(),
      /** Port CDP. 0 (défaut) = choisi automatiquement et lu dans le profil : deux instances ne se heurtent jamais. */
      debugPort: z.number().int().min(0).default(0),
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
  /** Télémétrie locale (aucune donnée envoyée, aucune donnée personnelle). */
  telemetry: z
    .object({
      enabled: z.boolean().default(true),
      dir: z.string().default("runs"),
    })
    .default({}),
  logging: z
    .object({
      level: z.enum(["error", "warn", "info", "debug"]).default("info"),
      file: z.string().optional(),
    })
    .default({}),
});

export type BotConfig = z.infer<typeof ConfigSchema>;

export type TicketCriteria = BotConfig["tickets"];
