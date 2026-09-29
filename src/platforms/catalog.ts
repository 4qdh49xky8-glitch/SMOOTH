import { readFileSync } from "node:fs";
import { z } from "zod";

/** Une preuve doit venir d'un hôte officiel de la plateforme, être datée et citer le passage lu. */
const MAX_EVIDENCE_AGE_DAYS = 180;

export const EVENT_TYPES = ["concert", "festival", "spectacle", "theatre", "sport", "grand-evenement", "associatif", "revente"] as const;

const Evidence = z.object({
  url: z.string().url().refine((u) => u.startsWith("https://"), "https obligatoire"),
  verifiedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "AAAA-MM-JJ"),
  /** Passage exact de la page officielle qui fonde la valeur (≥ 30 caractères). */
  excerpt: z.string().min(30, "citez le passage lu (≥ 30 caractères)"),
});
export type Evidence = z.infer<typeof Evidence>;

/** Champ d'analyse : « unknown » n'exige rien ; toute autre valeur EXIGE une preuve. */
const field = <T extends [string, ...string[]]>(values: T) =>
  z
    .object({ status: z.enum(["unknown", ...values]), evidence: Evidence.optional(), value: z.string().optional() })
    .refine((f) => f.status === "unknown" || f.evidence !== undefined, { message: "une valeur autre que « unknown » exige une preuve officielle (evidence)" });

export const PlatformSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  regions: z.array(z.string()).min(1),
  eventTypes: z.array(z.enum(EVENT_TYPES)).min(1),
  /** Domaines officiels : seules des preuves hébergées sur ces domaines sont acceptées. */
  officialHosts: z.array(z.string().min(3)).min(1),
  verification: z.object({ status: z.enum(["NON_VERIFIE", "VERIFIE"]), verifiedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), note: z.string().optional() }),
  /** none | read-only (recherche d'événements) | partner-only (réservé aux partenaires) | open-transactional (réservation/achat ouverts à un utilisateur ordinaire). */
  officialApi: field(["none", "read-only", "partner-only", "open-transactional"]),
  /** Ce que les conditions disent de l'automatisation : prohibited | not-addressed (silence) | permitted-interface | permitted-api | permitted-both (interface ET API). */
  automation: field(["prohibited", "not-addressed", "permitted-interface", "permitted-api", "permitted-both"]),
  queue: field(["none", "official-queue", "lottery"]),
  purchaseLimits: field(["documented", "not-documented"]),
  cart: field(["none", "official-api", "web-only"]),
  /** Pistes NON vérifiées (jamais prises en compte pour une décision). */
  clues: z.array(z.object({ url: z.string().url(), note: z.string(), verified: z.literal(false), origin: z.string() })).default([]),
});
export type Platform = z.infer<typeof PlatformSchema>;

export const CatalogSchema = z.object({ schemaVersion: z.literal(1), note: z.string().optional(), platforms: z.array(PlatformSchema) });
export type Catalog = z.infer<typeof CatalogSchema>;

/**
 * NON_VERIFIE      rien de fiable : le cœur n'automatise rien (canal humain seulement)
 * NON_AUTORISE     les conditions interdisent l'automatisation : aucun adaptateur
 * API_FIRST        API officielle transactionnelle ouverte ET automatisation permise par API
 * BROWSER          les conditions autorisent explicitement l'automatisation de l'interface
 * MANUEL_SEULEMENT les conditions ne l'autorisent pas (silence) : intervention humaine uniquement
 */
export type AdapterVerdict = "NON_VERIFIE" | "NON_AUTORISE" | "API_FIRST" | "BROWSER" | "MANUEL_SEULEMENT";

const ageDays = (date: string, now: number): number => (now - Date.parse(date)) / 86_400_000;

export interface Verdict {
  verdict: AdapterVerdict;
  /** Canaux automatisés autorisés par les preuves (vide si NON_VERIFIE / NON_AUTORISE / MANUEL_SEULEMENT). */
  channels: ("official-api" | "browser")[];
  reasons: string[];
}

/** Verdict déduit UNIQUEMENT des preuves consignées ; le silence des conditions n'est jamais une autorisation. */
export function adapterVerdict(p: Platform, now = Date.now()): Verdict {
  const none = (verdict: AdapterVerdict, reasons: string[]): Verdict => ({ verdict, channels: [], reasons });
  if (p.verification.status !== "VERIFIE") return none("NON_VERIFIE", ["plateforme non vérifiée à partir de sources officielles"]);
  const reasons: string[] = [];
  for (const [label, f] of [["automatisation", p.automation], ["API officielle", p.officialApi]] as const) {
    if (f.status === "unknown") reasons.push(`${label} : inconnue`);
    else if (f.evidence && ageDays(f.evidence.verifiedAt, now) > MAX_EVIDENCE_AGE_DAYS) reasons.push(`${label} : preuve datée de plus de ${MAX_EVIDENCE_AGE_DAYS} jours (à revérifier)`);
  }
  if (reasons.length) return none("NON_VERIFIE", reasons);

  const a = p.automation.status;
  if (a === "prohibited") return none("NON_AUTORISE", ["les conditions interdisent l'automatisation"]);
  const channels: Verdict["channels"] = [];
  // API : automatisation par API permise ET API transactionnelle réellement ouverte à un utilisateur ordinaire.
  if ((a === "permitted-api" || a === "permitted-both") && p.officialApi.status === "open-transactional") channels.push("official-api");
  // Interface : uniquement si les conditions l'autorisent EXPLICITEMENT.
  if (a === "permitted-interface" || a === "permitted-both") channels.push("browser");
  if (channels.length === 0) {
    return none("MANUEL_SEULEMENT", [
      a === "not-addressed" ? "les conditions ne traitent pas l'automatisation : silence = non autorisé" : "automatisation par API permise mais aucune API transactionnelle ouverte à un utilisateur ordinaire",
    ]);
  }
  return { verdict: channels[0] === "official-api" ? "API_FIRST" : "BROWSER", channels, reasons: [`canaux autorisés par les preuves : ${channels.join(" → ")}`] };
}

/** Contrôles d'intégrité du catalogue (preuves issues d'hôtes officiels, cohérence de la vérification). */
export function checkCatalogIntegrity(c: Catalog): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const p of c.platforms) {
    if (seen.has(p.id)) problems.push(`${p.id} : identifiant en double`);
    seen.add(p.id);
    const isOfficial = (url: string): boolean => {
      const h = new URL(url).hostname;
      return p.officialHosts.some((o) => h === o || h.endsWith(`.${o}`));
    };
    for (const [label, f] of Object.entries({ officialApi: p.officialApi, automation: p.automation, queue: p.queue, purchaseLimits: p.purchaseLimits, cart: p.cart })) {
      if (f.evidence && !isOfficial(f.evidence.url)) problems.push(`${p.id}.${label} : preuve hors des domaines officiels (${new URL(f.evidence.url).hostname})`);
    }
    if (p.verification.status === "VERIFIE") {
      if (!p.verification.verifiedAt) problems.push(`${p.id} : VERIFIE sans date`);
      if (p.automation.status === "unknown" || p.officialApi.status === "unknown") problems.push(`${p.id} : VERIFIE alors que l'automatisation ou l'API officielle est inconnue`);
    }
  }
  return problems;
}

export function parseCatalog(raw: unknown): Catalog {
  const parsed = CatalogSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Catalogue invalide :\n${parsed.error.issues.map((i) => `  - ${i.path.join(".")} : ${i.message}`).join("\n")}`);
  const problems = checkCatalogIntegrity(parsed.data);
  if (problems.length) throw new Error(`Catalogue incohérent :\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  return parsed.data;
}

export const CATALOG_PATH = "platforms/catalog.json";

export function loadCatalog(path = CATALOG_PATH): Catalog {
  return parseCatalog(JSON.parse(readFileSync(path, "utf8")));
}

export const findPlatform = (c: Catalog, id: string): Platform | undefined => c.platforms.find((p) => p.id === id);
