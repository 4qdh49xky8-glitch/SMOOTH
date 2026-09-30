import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { CRITERIA } from "../config/schema.js";

/**
 * PROFIL DE VENTE GÉNÉRIQUE (docs/SALE.md) : un fichier JSON ou YAML, valable pour n'importe quel événement (concert, festival, sport,
 * spectacle…) et n'importe quelle plateforme. Aucun artiste, lieu, plateforme ni événement n'est codé en dur.
 *
 * Ce profil est TRADUIT en configuration standard (BotConfig) : le cœur (décision, sélection, panier) et le modèle d'autorisation
 * ne changent pas. Il ne peut jamais élargir une permission : `channel` ne fait que restreindre, le paiement automatique est refusé.
 */

/** Chaîne vide = non renseignée (les gabarits contiennent des valeurs vides). */
const blank = (v: unknown): unknown => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optStr = z.preprocess(blank, z.string().min(1).optional());
const strList = z.array(z.string().min(1)).default([]);

export const STRATEGY_NAMES = ["priority", "cheapest", "best-seats", "category-first", "fewest-orphans", "custom"] as const;
export type StrategyName = (typeof STRATEGY_NAMES)[number];

/**
 * Stratégies nommées → ordre des critères du cœur (le 1er l'emporte) et sens du prix. Déterministes : le cœur classe, l'adaptateur ne fait que
 * fournir les données (et poser un veto avec matchOffer).
 */
export const STRATEGY_PRESETS: Readonly<Record<Exclude<StrategyName, "custom">, { priority: (typeof CRITERIA)[number][]; priceOrder: "cheapest" | "most-expensive"; help: string }>> = {
  priority: { priority: ["seatsTogether", "category", "placement", "price"], priceOrder: "cheapest", help: "places ensemble, puis catégorie (dans l'ordre donné), puis placement, puis prix le plus bas" },
  cheapest: { priority: ["seatsTogether", "price", "category", "placement"], priceOrder: "cheapest", help: "places ensemble (si demandées), puis le prix le plus bas (pour un prix strictement le plus bas, stratégie custom avec priority: [price])" },
  "best-seats": { priority: ["seatsTogether", "placement", "category", "price"], priceOrder: "most-expensive", help: "places ensemble, meilleur placement, puis le meilleur prix DANS le budget" },
  "category-first": { priority: ["category", "seatsTogether", "placement", "price"], priceOrder: "cheapest", help: "catégorie (dans l'ordre donné) avant tout, puis places ensemble" },
  "fewest-orphans": { priority: ["seatsTogether", "fit", "category", "price"], priceOrder: "cheapest", help: "places ensemble, puis l'offre dont la quantité colle le mieux (évite les places orphelines)" },
};

export const SaleProfileSchema = z
  .object({
    event: z
      .object({
        /** Plateforme (entrée du catalogue / adaptateur). Aucune valeur par défaut : à renseigner. */
        platform: z.preprocess(blank, z.string({ required_error: "event.platform requis (identifiant de la plateforme)" }).min(1, "event.platform requis")),
        eventUrl: optStr.pipe(z.string().url("event.eventUrl : URL invalide").optional()),
        eventId: optStr,
        name: z.preprocess(blank, z.string({ required_error: "event.name requis" }).min(1, "event.name requis")),
        venue: optStr,
        /** Date de l'événement (informative) AAAA-MM-JJ. */
        date: optStr,
      })
      .strict(),
    sale: z
      .object({
        /** Heure d'ouverture : ISO 8601 avec décalage, OU heure locale « AAAA-MM-JJTHH:MM[:SS] » accompagnée de `timezone`. */
        startTime: z.preprocess(blank, z.string({ required_error: "sale.startTime requis" }).min(1, "sale.startTime requis")),
        /** Fuseau IANA (ex. Europe/Paris). Requis si startTime n'a pas de décalage ; sinon contrôlé contre le décalage. */
        timezone: optStr,
      })
      .strict(),
    tickets: z
      .object({
        quantity: z.number().int().min(1).max(10),
        seatsTogether: z.boolean().default(true),
        strictTogether: z.boolean().default(false),
      })
      .strict(),
    budget: z
      .object({
        /** Prix MAXIMUM par billet : contrainte DURE, jamais dépassée. `null` = non renseigné → refus (pas de budget illimité). */
        maxPrice: z.number().positive("budget.maxPrice doit être > 0").nullable(),
      })
      .strict(),
    selection: z
      .object({
        strategy: z.enum(STRATEGY_NAMES).default("priority"),
        /** Ordre des critères (uniquement avec strategy: custom). */
        priority: z.array(z.enum(CRITERIA)).min(1).optional(),
        priceOrder: z.enum(["cheapest", "most-expensive"]).optional(),
        /** Catégories acceptées, l'ordre = préférence. Vide = toutes. */
        categories: strList,
        /** Catégories à tenter avant les autres catégories acceptées. */
        priorityCategories: strList,
        preferredSections: strList,
        avoidedSections: strList,
        /** Sections exclues d'office. */
        excludedSections: strList,
        preferredRows: strList,
        avoidedRows: strList,
        rowPreference: z.enum(["front", "back", "any"]).default("any"),
      })
      .strict()
      .default({}),
    behavior: z
      .object({
        autoAddToCart: z.boolean().default(true),
        /** Le paiement automatique n'existe pas : il reste toujours manuel. */
        autoPayment: z.literal(false, { errorMap: () => ({ message: "behavior.autoPayment doit rester false : le paiement est toujours effectué manuellement." }) }).default(false),
      })
      .strict()
      .default({}),
    /** Restriction de canal (jamais une extension) : auto | official-api | browser | human. */
    channel: z.enum(["auto", "official-api", "browser", "human"]).optional(),
    /** Réglages techniques optionnels (validés par le schéma standard) : timing, browser, cart, claude, notifications, telemetry, logging, siteOptions. */
    advanced: z.record(z.unknown()).optional(),
  })
  .strict();
export type SaleProfile = z.infer<typeof SaleProfileSchema>;

const ADVANCED_KEYS = new Set(["timing", "browser", "cart", "claude", "notifications", "telemetry", "logging", "siteOptions"]);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Un fichier est un profil de vente générique s'il porte `event.platform`, `budget` ou `selection`. */
export function isSaleProfile(raw: unknown): boolean {
  if (!isObj(raw)) return false;
  return (isObj(raw.event) && "platform" in raw.event) || isObj(raw.budget) || isObj(raw.selection);
}

/** JSON ou YAML (selon l'extension). */
export function readStructuredFile(path: string): unknown {
  const text = readFileSync(path, "utf8");
  const ext = extname(path).toLowerCase();
  return ext === ".yaml" || ext === ".yml" ? parseYaml(text) : JSON.parse(text);
}

// ───────────────────────────── fuseau horaire ─────────────────────────────
/** Décalage (ms) du fuseau `tz` à l'instant `epoch`. */
export function tzOffsetMs(epoch: number, tz: string): number {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(new Date(epoch)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(epoch / 1000) * 1000;
}

export const isValidTimezone = (tz: string): boolean => {
  if (!(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$/.test(tz) || tz === "UTC")) return false; // IANA seulement (pas « CET », pas « GMT+2 »)
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const fmtOffset = (ms: number): string => {
  const sign = ms < 0 ? "-" : "+";
  const m = Math.abs(Math.round(ms / 60_000));
  return `${sign}${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

export interface ResolvedStart {
  /** ISO 8601 AVEC décalage (format attendu par la configuration standard). */
  iso?: string;
  epochMs?: number;
  timezone?: string;
  offset?: string;
  issues: string[];
}

/**
 * Résout l'heure d'ouverture. Heure locale + fuseau : le décalage (heure d'été comprise) est calculé ; une heure qui n'existe pas (saut d'heure)
 * ou qui existe deux fois (retour d'heure) est REFUSÉE plutôt que devinée. Décalage explicite + fuseau : ils doivent concorder.
 */
export function resolveStartTime(startTime: string, timezone?: string): ResolvedStart {
  const issues: string[] = [];
  if (timezone !== undefined && !isValidTimezone(timezone)) issues.push(`sale.timezone « ${timezone} » invalide (fuseau IANA attendu, ex. Europe/Paris)`);
  const explicit = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(startTime);
  const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(startTime);
  if (explicit) {
    const epoch = Date.parse(startTime.replace(" ", "T"));
    if (Number.isNaN(epoch)) return { issues: [`sale.startTime « ${startTime} » n'est pas une date réelle`] };
    const iso = startTime.replace(" ", "T");
    // « Z » est un instant sans intention d'heure locale : rien à contrôler. Un décalage (+02:00) exprime une heure locale : il doit être celui du fuseau à cette date.
    if (timezone !== undefined && isValidTimezone(timezone) && !issues.length && explicit[3] !== "Z") {
      const want = fmtOffset(tzOffsetMs(epoch, timezone));
      const got = explicit[3] === "Z" ? "+00:00" : explicit[3]!;
      if (want !== got) issues.push(`sale.startTime a le décalage ${explicit[3]} mais ${timezone} est à ${want} à cette date : corrigez l'un des deux`);
    }
    return { iso, epochMs: epoch, timezone, offset: explicit[3], issues };
  }
  if (!local) return { issues: [...issues, `sale.startTime « ${startTime} » : format attendu AAAA-MM-JJTHH:MM[:SS] avec sale.timezone, ou ISO 8601 avec décalage (…+02:00 / …Z)`] };
  if (timezone === undefined) return { issues: [...issues, "sale.timezone requis (fuseau IANA, ex. Europe/Paris) : sale.startTime n'a pas de décalage"] };
  if (issues.length) return { issues };
  const [y, mo, d, h, mi] = [1, 2, 3, 4, 5].map((i) => Number(local[i]));
  const s = local[6] === undefined ? undefined : Number(local[6]);
  const naive = Date.UTC(y!, mo! - 1, d!, h!, mi!, s ?? 0);
  const check = new Date(naive);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo! - 1 || check.getUTCDate() !== d || check.getUTCHours() !== h || check.getUTCMinutes() !== mi)
    return { issues: [`sale.startTime « ${startTime} » n'est pas une date/heure réelle`] };
  const candidates = new Set<number>();
  for (const off of new Set([tzOffsetMs(naive - 86_400_000, timezone), tzOffsetMs(naive + 86_400_000, timezone)])) {
    const e = naive - off;
    if (tzOffsetMs(e, timezone) === off) candidates.add(e);
  }
  if (candidates.size === 0) return { issues: [`sale.startTime « ${startTime} » n'existe pas à ${timezone} (saut d'heure lors du passage à l'heure d'été)`] };
  if (candidates.size > 1) return { issues: [`sale.startTime « ${startTime} » est ambigu à ${timezone} (l'heure existe deux fois lors du retour à l'heure d'hiver) : indiquez le décalage explicite`] };
  const epoch = [...candidates][0]!;
  const offset = fmtOffset(tzOffsetMs(epoch, timezone));
  return { iso: `${startTime.replace(" ", "T")}${s === undefined ? ":00" : ""}${offset}`, epochMs: epoch, timezone, offset, issues: [] };
}

export interface ConvertedProfile {
  /** Configuration standard (entrée de ConfigSchema), absente s'il y a des problèmes. */
  config?: Record<string, unknown>;
  issues: string[];
  start?: ResolvedStart;
  profile?: SaleProfile;
}

/** Profil de vente → configuration standard. Toutes les erreurs sont rassemblées (rapport lisible), aucune n'est devinée. */
export function convertSaleProfile(raw: unknown): ConvertedProfile {
  const parsed = SaleProfileSchema.safeParse(raw);
  if (!parsed.success) return { issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(racine)"} : ${i.message}`) };
  const p = parsed.data;
  const issues: string[] = [];

  if (p.budget.maxPrice === null) issues.push("budget.maxPrice : requis — le budget est une contrainte dure, il n'existe pas de budget illimité (renseignez le prix maximum par billet)");
  if (p.tickets.strictTogether && !p.tickets.seatsTogether) issues.push("tickets.strictTogether exige tickets.seatsTogether=true");
  const sel = p.selection;
  if (sel.strategy === "custom" && !sel.priority) issues.push("selection.priority requis avec selection.strategy=custom");
  if (sel.strategy !== "custom" && (sel.priority || sel.priceOrder)) issues.push("selection.priority / selection.priceOrder ne s'utilisent qu'avec selection.strategy=custom (sinon la stratégie nommée s'applique)");
  for (const k of Object.keys(p.advanced ?? {})) if (!ADVANCED_KEYS.has(k)) issues.push(`advanced.${k} : réglage inconnu (autorisés : ${[...ADVANCED_KEYS].join(", ")})`);

  const start = resolveStartTime(p.sale.startTime, p.sale.timezone);
  issues.push(...start.issues);
  if (issues.length) return { issues, start, profile: p };

  const preset = sel.strategy === "custom" ? { priority: sel.priority!, priceOrder: sel.priceOrder ?? "cheapest" } : STRATEGY_PRESETS[sel.strategy];
  const siteOptions = { ...((p.advanced?.siteOptions as Record<string, unknown> | undefined) ?? {}), ...(p.event.eventId ? { eventId: p.event.eventId } : {}) };
  const advanced = { ...(p.advanced ?? {}) };
  delete advanced.siteOptions;
  const config: Record<string, unknown> = {
    ...advanced,
    site: p.event.platform,
    ...(p.channel ? { channel: p.channel } : {}),
    siteOptions,
    event: { name: p.event.name, ...(p.event.date ? { date: p.event.date } : {}), ...(p.event.eventUrl ? { url: p.event.eventUrl } : {}), ...(p.event.eventId ? { id: p.event.eventId } : {}), ...(p.event.venue ? { venue: p.event.venue } : {}) },
    sale: { startTime: start.iso },
    tickets: { quantity: p.tickets.quantity, maxPricePerTicket: p.budget.maxPrice, categories: sel.categories, seatsTogether: p.tickets.seatsTogether, seatsTogetherStrict: p.tickets.strictTogether },
    strategy: {
      priority: preset.priority,
      priceOrder: preset.priceOrder,
      priorityCategories: sel.priorityCategories,
      placement: { preferSections: sel.preferredSections, avoidSections: sel.avoidedSections, excludeSections: sel.excludedSections, rowPreference: sel.rowPreference, preferRows: sel.preferredRows, avoidRows: sel.avoidedRows },
    },
    behavior: { autoAddToCart: p.behavior.autoAddToCart, autoPayment: p.behavior.autoPayment },
  };
  return { config, issues: [], start, profile: p };
}
