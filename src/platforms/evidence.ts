import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Preuves officielles : UN fichier JSON par relevé dans `platforms/evidence/`. C'est la SEULE source d'autorisation.
 * Personne (ni le code, ni un assistant) ne déclare une plateforme autorisée sans qu'un fichier de preuve valide existe.
 */
export const EVIDENCE_MAX_AGE_DAYS = 180;
export const EVIDENCE_DIR = "platforms/evidence";

/** api : l'API officielle est autorisée · browser : l'automatisation de l'interface l'est · both : les deux · human : ni l'une ni l'autre (achat humain seulement). */
export const CHANNELS = ["api", "browser", "both", "human"] as const;
export type EvidenceChannel = (typeof CHANNELS)[number];

/** automation décide de l'autorisation ; les autres sujets documentent (API, file d'attente, limites d'achat, panier). */
export const TOPICS = ["automation", "api", "queue", "limits", "cart"] as const;
export type Topic = (typeof TOPICS)[number];

export const TOPIC_VALUES: Record<Exclude<Topic, "automation">, readonly string[]> = {
  api: ["none", "read-only", "partner-only", "open-transactional"],
  queue: ["none", "official-queue", "lottery"],
  limits: ["documented", "not-documented"],
  cart: ["none", "official-api", "web-only"],
};

export interface EvidenceRecord {
  platform: string;
  /** Date de consultation de la page officielle (AAAA-MM-JJ). */
  checkedAt: string;
  source: { url: string; title: string };
  topic: Topic;
  /** Requis pour `automation`. */
  channel?: EvidenceChannel;
  /** Requis pour les autres sujets (voir TOPIC_VALUES). */
  value?: string;
  /** Ce que la source autorise ou interdit, en une phrase. */
  authorization: string;
  /** Passage EXACT de la page officielle (≥ 30 caractères). */
  excerpt: string;
  note?: string;
  /** Fichier d'origine (renseigné au chargement). */
  file: string;
}

export type IssueCode =
  | "INVALID_JSON" | "NOT_OBJECT" | "UNKNOWN_FIELD" | "NO_PLATFORM" | "UNKNOWN_PLATFORM" | "NO_DATE" | "FUTURE_DATE" | "TOO_OLD"
  | "NO_SOURCE" | "NO_HTTPS_URL" | "NO_TITLE" | "DOMAIN_MISMATCH" | "NO_EXCERPT" | "NO_AUTHORIZATION" | "BAD_TOPIC" | "BAD_CHANNEL" | "BAD_VALUE";

export interface EvidenceIssue {
  code: IssueCode;
  message: string;
}

export interface RejectedEvidence {
  file: string;
  issues: EvidenceIssue[];
}

const DAY = 86_400_000;
const day = (ms: number): number => Math.floor(ms / DAY);
const dayOf = (date: string): number => day(Date.parse(`${date}T00:00:00Z`));

/** Jours écoulés depuis la consultation (en jours calendaires UTC). */
export const ageDays = (checkedAt: string, now: number): number => day(now) - dayOf(checkedAt);
/** Dernier jour de validité : consultation + 180 jours. */
export const expiresAt = (checkedAt: string): string => new Date((dayOf(checkedAt) + EVIDENCE_MAX_AGE_DAYS) * DAY).toISOString().slice(0, 10);
export const isExpired = (checkedAt: string, now: number): boolean => ageDays(checkedAt, now) > EVIDENCE_MAX_AGE_DAYS;
export const daysUntilExpiry = (checkedAt: string, now: number): number => EVIDENCE_MAX_AGE_DAYS - ageDays(checkedAt, now);

const KNOWN_FIELDS = new Set(["platform", "checkedAt", "source", "topic", "channel", "value", "authorization", "excerpt", "note"]);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export interface PlatformRef {
  id: string;
  officialHosts: string[];
}

/** L'hôte de l'URL doit être un domaine officiel de la plateforme (ou l'un de ses sous-domaines). */
export const hostMatches = (url: string, hosts: string[]): boolean => {
  const h = new URL(url).hostname.toLowerCase();
  return hosts.some((o) => h === o || h.endsWith(`.${o}`));
};

export interface ValidateOptions {
  platforms: PlatformRef[];
  now: number;
  /** false (ajout d'une preuve) : une preuve de plus de 180 jours est REFUSÉE. true (chargement) : elle est conservée dans l'historique comme expirée. */
  allowExpired: boolean;
}

export interface ValidationResult {
  record?: Omit<EvidenceRecord, "file">;
  issues: EvidenceIssue[];
  expired: boolean;
}

/** Refuse une preuve : sans URL https, sans date, sans extrait, trop ancienne, ou dont le domaine ne correspond pas à la plateforme. */
export function validateEvidence(raw: unknown, o: ValidateOptions): ValidationResult {
  const issues: EvidenceIssue[] = [];
  const add = (code: IssueCode, message: string): void => void issues.push({ code, message });
  if (!isObj(raw)) return { issues: [{ code: "NOT_OBJECT", message: "la preuve doit être un objet JSON" }], expired: false };

  for (const k of Object.keys(raw)) if (!KNOWN_FIELDS.has(k)) add("UNKNOWN_FIELD", `champ inconnu « ${k} » (faute de frappe ?)`);

  const platformId = str(raw.platform);
  const platform = o.platforms.find((p) => p.id === platformId);
  if (!platformId) add("NO_PLATFORM", "champ « platform » manquant");
  else if (!platform) add("UNKNOWN_PLATFORM", `plateforme « ${platformId} » absente de platforms/catalog.json`);

  const checkedAt = str(raw.checkedAt);
  let expired = false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkedAt) || Number.isNaN(Date.parse(`${checkedAt}T00:00:00Z`))) add("NO_DATE", "« checkedAt » (AAAA-MM-JJ) manquant ou invalide");
  else if (ageDays(checkedAt, o.now) < 0) add("FUTURE_DATE", "« checkedAt » est dans le futur");
  else if (isExpired(checkedAt, o.now)) {
    expired = true;
    if (!o.allowExpired) add("TOO_OLD", `« checkedAt » date de plus de ${EVIDENCE_MAX_AGE_DAYS} jours (expirée le ${expiresAt(checkedAt)}) : reconsultez la page officielle`);
  }

  const source = isObj(raw.source) ? raw.source : undefined;
  if (!source) add("NO_SOURCE", "« source » ({ url, title }) manquant");
  const url = str(source?.url);
  let parsed: URL | undefined;
  try {
    parsed = url ? new URL(url) : undefined;
  } catch {
    parsed = undefined;
  }
  if (source && (!parsed || parsed.protocol !== "https:")) add("NO_HTTPS_URL", "« source.url » doit être une URL https");
  if (source && !str(source.title)) add("NO_TITLE", "« source.title » (titre de la page officielle) manquant");
  if (platform && parsed?.protocol === "https:" && !hostMatches(url, platform.officialHosts))
    add("DOMAIN_MISMATCH", `le domaine ${parsed.hostname} n'est pas un domaine officiel de « ${platform.id} » (${platform.officialHosts.join(", ")})`);

  if (str(raw.excerpt).length < 30) add("NO_EXCERPT", "« excerpt » : citez le passage exact de la page officielle (≥ 30 caractères)");
  if (str(raw.authorization).length < 10) add("NO_AUTHORIZATION", "« authorization » : dites ce que la source autorise ou interdit");

  const topic = raw.topic === undefined ? "automation" : raw.topic;
  if (!(TOPICS as readonly unknown[]).includes(topic)) add("BAD_TOPIC", `« topic » ∈ ${TOPICS.join(" | ")}`);
  else if (topic === "automation") {
    if (!(CHANNELS as readonly unknown[]).includes(raw.channel)) add("BAD_CHANNEL", `« channel » ∈ ${CHANNELS.join(" | ")} (requis pour le sujet automation)`);
  } else if (!TOPIC_VALUES[topic as Exclude<Topic, "automation">].includes(str(raw.value))) {
    add("BAD_VALUE", `« value » ∈ ${TOPIC_VALUES[topic as Exclude<Topic, "automation">].join(" | ")} (sujet ${String(topic)})`);
  }

  if (issues.length) return { issues, expired };
  return {
    issues,
    expired,
    record: {
      platform: platformId,
      checkedAt,
      source: { url, title: str(source!.title) },
      topic: topic as Topic,
      ...(topic === "automation" ? { channel: raw.channel as EvidenceChannel } : { value: str(raw.value) }),
      authorization: str(raw.authorization),
      excerpt: str(raw.excerpt),
      ...(str(raw.note) ? { note: str(raw.note) } : {}),
    },
  };
}

export interface LoadedEvidence {
  records: EvidenceRecord[];
  rejected: RejectedEvidence[];
}

/**
 * Charge tous les `*.json` du dossier (les fichiers commençant par « _ » sont ignorés). Une preuve invalide est
 * REFUSÉE : elle n'entre jamais dans le calcul des autorisations et est signalée (`rejected`). Une preuve valide
 * mais ancienne est conservée dans l'historique et comptée comme expirée.
 */
export function loadEvidence(dir: string, platforms: PlatformRef[], now: number): LoadedEvidence {
  const out: LoadedEvidence = { records: [], rejected: [] };
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort();
  } catch {
    return out; // dossier absent : aucune preuve
  }
  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch (e) {
      out.rejected.push({ file, issues: [{ code: "INVALID_JSON", message: `JSON illisible : ${(e as Error).message}` }] });
      continue;
    }
    const v = validateEvidence(raw, { platforms, now, allowExpired: true });
    if (v.record) out.records.push({ ...v.record, file });
    else out.rejected.push({ file, issues: v.issues });
  }
  return out;
}
