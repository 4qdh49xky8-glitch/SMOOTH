import { readFileSync } from "node:fs";
import { z } from "zod";
import { EVIDENCE_DIR, EVIDENCE_MAX_AGE_DAYS, TOPICS, daysUntilExpiry, expiresAt, hostMatches, isExpired, loadEvidence, type EvidenceRecord, type RejectedEvidence, type Topic } from "./evidence.js";

export const EVENT_TYPES = ["concert", "festival", "spectacle", "theatre", "sport", "grand-evenement", "associatif", "revente"] as const;
export const CATALOG_PATH = "platforms/catalog.json";

/**
 * Le catalogue ne contient QUE des données statiques (nom, types, domaines officiels, pistes). Il ne contient aucune
 * autorisation : elles se déduisent exclusivement des fichiers de preuve (platforms/evidence/*.json).
 */
export const PlatformSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  regions: z.array(z.string()).min(1),
  eventTypes: z.array(z.enum(EVENT_TYPES)).min(1),
  /** Domaines officiels : seules des preuves hébergées sur ces domaines sont acceptées. */
  officialHosts: z.array(z.string().min(3)).min(1),
  /** Pistes NON vérifiées (jamais prises en compte pour une décision). */
  clues: z.array(z.object({ url: z.string().url(), note: z.string(), verified: z.literal(false), origin: z.string() })).default([]),
});
export type Platform = z.infer<typeof PlatformSchema>;

export interface Catalog {
  platforms: Platform[];
  evidence: EvidenceRecord[];
  /** Fichiers de preuve refusés (invalides) : ils ne comptent pour rien mais sont toujours signalés. */
  rejected: RejectedEvidence[];
}

/**
 * NOT_VERIFIED              aucune preuve d'automatisation
 * VERIFIED_API              une preuve autorise l'API officielle
 * VERIFIED_BROWSER          une preuve autorise l'automatisation de l'interface
 * VERIFIED_API_AND_BROWSER  une preuve autorise les deux
 * NOT_ALLOWED               les preuves n'autorisent aucun canal automatisé (interdit, ou preuves contradictoires)
 * EXPIRED                   il existe des preuves, mais toutes datent de plus de 180 jours
 */
export const STATUSES = ["NOT_VERIFIED", "VERIFIED_API", "VERIFIED_BROWSER", "VERIFIED_API_AND_BROWSER", "NOT_ALLOWED", "EXPIRED"] as const;
export type PlatformStatus = (typeof STATUSES)[number];

export const STATUS_HELP: Record<PlatformStatus, string> = {
  NOT_VERIFIED: "aucune preuve officielle valide : rien n'est automatisé",
  VERIFIED_API: "API officielle autorisée par une preuve valide",
  VERIFIED_BROWSER: "automatisation de l'interface autorisée par une preuve valide",
  VERIFIED_API_AND_BROWSER: "API officielle et interface autorisées par des preuves valides",
  NOT_ALLOWED: "automatisation non autorisée (interdite ou preuves contradictoires) : achat humain seulement",
  EXPIRED: `preuves de plus de ${EVIDENCE_MAX_AGE_DAYS} jours : à revérifier, rien n'est automatisé`,
};

export type Channel = "official-api" | "browser";

export interface HistoryEntry {
  checkedAt: string;
  url: string;
  source: string;
  topic: Topic;
  /** Canal autorisé par ce relevé (sujet automation) : api | browser | both | human. */
  channel?: string;
  value?: string;
  authorization: string;
  expiresAt: string;
  expired: boolean;
  note?: string;
  file: string;
}

export interface Missing {
  topic: Topic;
  /** true : empêche toute automatisation ; false : information complémentaire. */
  blocking: boolean;
  reason: string;
}

export interface PlatformState {
  status: PlatformStatus;
  /** Canaux automatisés autorisés par les preuves valides (intersection : le plus restrictif l'emporte). */
  channels: Channel[];
  /** Première échéance parmi les preuves d'automatisation qui fondent le statut. */
  expiresAt?: string;
  expiresInDays?: number;
  history: HistoryEntry[];
  facts: Partial<Record<Exclude<Topic, "automation">, { value: string; checkedAt: string; url: string; expired: boolean }>>;
  missing: Missing[];
  conflicts: string[];
  reasons: string[];
}

const TOPIC_LABEL: Record<Topic, string> = {
  automation: "règles sur robots, scripts et automatisation",
  api: "API officielle",
  queue: "file d'attente officielle",
  limits: "limites d'achat",
  cart: "mécanisme officiel de réservation/panier",
};
export const topicLabel = (t: Topic): string => TOPIC_LABEL[t];

const CHANNEL_SET: Record<string, Channel[]> = { api: ["official-api"], browser: ["browser"], both: ["official-api", "browser"], human: [] };

/** Statut d'une plateforme, déduit UNIQUEMENT des preuves valides et non expirées à l'instant `now`. */
export function stateOf(c: Catalog, id: string, now = Date.now()): PlatformState {
  const records = c.evidence.filter((r) => r.platform === id).sort((a, b) => b.checkedAt.localeCompare(a.checkedAt) || a.file.localeCompare(b.file));
  const history: HistoryEntry[] = records.map((r) => ({
    checkedAt: r.checkedAt, url: r.source.url, source: r.source.title, topic: r.topic, channel: r.channel, value: r.value,
    authorization: r.authorization, expiresAt: expiresAt(r.checkedAt), expired: isExpired(r.checkedAt, now), note: r.note, file: r.file,
  }));

  const facts: PlatformState["facts"] = {};
  const missing: Missing[] = [];
  for (const topic of TOPICS) {
    const ofTopic = history.filter((h) => h.topic === topic);
    const valid = ofTopic.find((h) => !h.expired);
    if (topic !== "automation") {
      const latest = valid ?? ofTopic[0];
      if (latest?.value) facts[topic] = { value: latest.value, checkedAt: latest.checkedAt, url: latest.url, expired: latest.expired };
    }
    if (!valid) {
      const old = ofTopic[0];
      missing.push({
        topic,
        blocking: topic === "automation",
        reason: old ? `dernière preuve du ${old.checkedAt}, expirée le ${old.expiresAt} : à revérifier` : "aucune preuve",
      });
    }
  }

  const auto = history.filter((h) => h.topic === "automation");
  const valid = auto.filter((h) => !h.expired);
  const base = { history, facts, missing, conflicts: [] as string[] };
  if (auto.length === 0) return { ...base, status: "NOT_VERIFIED", channels: [], reasons: ["aucune preuve officielle d'automatisation"] };
  if (valid.length === 0) return { ...base, status: "EXPIRED", channels: [], reasons: [`toutes les preuves d'automatisation ont expiré (dernière : ${auto[0]!.checkedAt}, expirée le ${auto[0]!.expiresAt})`] };

  // Intersection des canaux autorisés : en cas de preuves divergentes, le plus restrictif l'emporte.
  let channels: Channel[] = ["official-api", "browser"];
  for (const h of valid) channels = channels.filter((ch) => (CHANNEL_SET[h.channel ?? "human"] ?? []).includes(ch));
  const distinct = new Set(valid.map((h) => h.channel));
  const conflicts = distinct.size > 1 ? [`preuves divergentes (${[...distinct].join(" / ")}) : le canal le plus restrictif s'applique jusqu'à expiration ou remplacement`] : [];
  const soonest = valid.map((h) => h.expiresAt).sort()[0]!;
  const common = { ...base, conflicts, expiresAt: soonest, expiresInDays: daysUntilExpiry(valid.map((h) => h.checkedAt).sort()[0]!, now) };
  if (channels.length === 0) return { ...common, status: "NOT_ALLOWED", channels: [], reasons: [valid.some((h) => h.channel === "human") ? "une preuve indique que l'automatisation n'est pas autorisée" : "preuves sans canal commun"] };
  const status: PlatformStatus = channels.length === 2 ? "VERIFIED_API_AND_BROWSER" : channels[0] === "official-api" ? "VERIFIED_API" : "VERIFIED_BROWSER";
  return { ...common, status, channels, reasons: [`canaux autorisés par les preuves : ${channels.join(" → ")}`] };
}

/** Contrôles d'intégrité (identifiants, pistes hors domaine officiel, preuves refusées). */
export function checkCatalogIntegrity(c: Catalog): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const p of c.platforms) {
    if (seen.has(p.id)) problems.push(`${p.id} : identifiant en double`);
    seen.add(p.id);
    for (const cl of p.clues) if (!hostMatches(cl.url, p.officialHosts)) problems.push(`${p.id} : piste hors des domaines officiels (${new URL(cl.url).hostname})`);
  }
  for (const r of c.rejected) problems.push(`preuve refusée ${r.file} : ${r.issues.map((i) => `${i.code} (${i.message})`).join(" ; ")}`);
  return problems;
}

export function buildCatalog(platforms: Platform[], evidence: EvidenceRecord[] = [], rejected: RejectedEvidence[] = []): Catalog {
  return { platforms, evidence, rejected };
}

export function parseCatalogFile(raw: unknown): Platform[] {
  const parsed = z.object({ schemaVersion: z.number(), platforms: z.array(PlatformSchema) }).safeParse(raw);
  if (!parsed.success) throw new Error(`Catalogue invalide :\n${parsed.error.issues.map((i) => `  - ${i.path.join(".")} : ${i.message}`).join("\n")}`);
  return parsed.data.platforms;
}

export interface LoadOptions {
  path?: string;
  evidenceDir?: string;
  now?: number;
}

/** Catalogue statique + preuves du dossier. Une preuve invalide est refusée et signalée, jamais comptée. */
export function loadCatalog(o: LoadOptions = {}): Catalog {
  const platforms = parseCatalogFile(JSON.parse(readFileSync(o.path ?? CATALOG_PATH, "utf8")));
  const ev = loadEvidence(o.evidenceDir ?? EVIDENCE_DIR, platforms, o.now ?? Date.now());
  return buildCatalog(platforms, ev.records, ev.rejected);
}

export const findPlatform = (c: Catalog, id: string): Platform | undefined => c.platforms.find((p) => p.id === id);
