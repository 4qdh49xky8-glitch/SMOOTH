import { z } from "zod";
import nodemailer from "nodemailer";
import { readStructuredFile } from "../sale/profile.js";
import { resolveConfigPath } from "../config/load.js";
import { redact, secretValues, trackSecretEnv } from "../utils/redact.js";

/**
 * Notification e-mail immédiate de `sale:instant` (couche au-dessus du cœur gelé ; le schéma standard ignore simplement la clé
 * `notifications.email`, elle est lue et validée ici).
 *
 *   notifications:
 *     email:
 *       enabled: true
 *       to: "vous@exemple.org"        # ou toEnv: "NOM_DE_VARIABLE"
 *       on: "CART_SUCCESS"
 *       provider: smtp                # smtp | api : uniquement un fournisseur EXPLICITEMENT configuré
 *       from: "bot@exemple.org"
 *       smtp: { host, port, secure, userEnv, passEnv }   # les secrets ne sont jamais dans le fichier : NOMS de variables
 *       api:  { url, tokenEnv }                          # POST JSON https, jeton en variable d'environnement
 *
 * Le message ne contient que : CART_SUCCESS, événement, plateforme, date de l'événement, quantité, catégorie, prix total, heure exacte
 * et « PAYMENT REQUIRED — PAYMENT MANUAL ». Jamais de secret, cookie, jeton, URL, donnée de session ou donnée bancaire.
 */
export class EmailConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Configuration e-mail invalide : ${problems.join(" ; ")}`);
    this.name = "EmailConfigError";
  }
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const ADDRESS = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const envName = z.string().regex(ENV_NAME, "nom de variable d'environnement attendu (MAJUSCULES, chiffres, _), jamais une valeur secrète");

const EmailSchema = z
  .object({
    enabled: z.boolean().default(false),
    to: z.string().optional(),
    toEnv: envName.optional(),
    on: z.literal("CART_SUCCESS", { errorMap: () => ({ message: 'seul l\'événement "CART_SUCCESS" est pris en charge' }) }).default("CART_SUCCESS"),
    provider: z.enum(["smtp", "api"]).optional(),
    from: z.string().regex(ADDRESS, "adresse d'expéditeur invalide").optional(),
    smtp: z.object({ host: z.string().min(1), port: z.number().int().min(1).max(65535).default(587), secure: z.boolean().default(false), userEnv: envName.optional(), passEnv: envName.optional() }).strict().optional(),
    api: z.object({ url: z.string().url(), tokenEnv: envName }).strict().optional(),
  })
  .strict();

export interface EmailConfig {
  enabled: true;
  to: string;
  on: "CART_SUCCESS";
  provider: "smtp" | "api";
  from: string;
  smtp?: { host: string; port: number; secure: boolean; userEnv?: string; passEnv?: string };
  api?: { url: string; tokenEnv: string };
}

/** Valide une section `notifications.email`. `null` = désactivée. Jamais d'effet de bord réseau ; ne lit que la PRÉSENCE des variables. */
export function parseEmailConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): EmailConfig | null {
  if (raw === undefined || raw === null) return null;
  const r = EmailSchema.safeParse(raw);
  if (!r.success) throw new EmailConfigError(r.error.issues.map((i) => `${i.path.join(".") || "email"} : ${i.message}`));
  const c = r.data;
  if (!c.enabled) return null;
  const p: string[] = [];
  const to = c.to ?? (c.toEnv ? env[c.toEnv] : undefined);
  if (c.to && c.toEnv) p.push("`to` et `toEnv` sont exclusifs");
  if (!to) p.push(c.toEnv ? `variable ${c.toEnv} absente` : "`to` requis");
  else if (!ADDRESS.test(to.trim())) p.push("destinataire : une seule adresse e-mail valide attendue");
  if (!c.provider) p.push("`provider` (smtp | api) requis : aucun fournisseur par défaut");
  if (!c.from) p.push("`from` requis");
  if (c.provider === "smtp") {
    if (!c.smtp) p.push("section `smtp` requise");
    else {
      if (!!c.smtp.userEnv !== !!c.smtp.passEnv) p.push("smtp.userEnv et smtp.passEnv vont ensemble");
      for (const n of [c.smtp.userEnv, c.smtp.passEnv]) if (n && !env[n]) p.push(`variable ${n} absente`);
    }
    if (c.api) p.push("section `api` inutile avec provider smtp");
  }
  if (c.provider === "api") {
    if (!c.api) p.push("section `api` requise");
    else {
      let u: URL | undefined;
      try {
        u = new URL(c.api.url);
      } catch {
        /* message ci-dessous */
      }
      if (!u || u.protocol !== "https:" || u.username || u.password || u.search || u.hash) p.push("api.url : https uniquement, sans identifiants, requête ni fragment");
      if (!env[c.api.tokenEnv]) p.push(`variable ${c.api.tokenEnv} absente`);
    }
    if (c.smtp) p.push("section `smtp` inutile avec provider api");
  }
  if (p.length) throw new EmailConfigError(p);
  trackSecretEnv(c.smtp?.userEnv, c.smtp?.passEnv, c.api?.tokenEnv, c.toEnv);
  return { enabled: true, to: to!.trim(), on: "CART_SUCCESS", provider: c.provider!, from: c.from!, smtp: c.smtp, api: c.api };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Lit `notifications.email` (ou `advanced.notifications.email` d'un profil de vente) dans le fichier de configuration. */
export function readEmailConfig(target: string, env: NodeJS.ProcessEnv = process.env): EmailConfig | null {
  const raw = readStructuredFile(resolveConfigPath(target));
  if (!isObj(raw)) return null;
  const top = isObj(raw.notifications) ? raw.notifications.email : undefined;
  const adv = isObj(raw.advanced) && isObj(raw.advanced.notifications) ? raw.advanced.notifications.email : undefined;
  return parseEmailConfig(top ?? adv, env);
}

// ───────────────────────────── contenu ─────────────────────────────
export interface CartSuccessInfo {
  eventName: string;
  platform: string;
  eventDate?: string;
  quantity?: number;
  category?: string;
  totalPrice?: number;
  currency?: string;
  /** Instant exact du CART_SUCCESS (epoch ms). */
  at: number;
}
export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export const PAYMENT_LINE = "PAYMENT REQUIRED — PAYMENT MANUAL";

/** Texte libre → une ligne, sans caractère de contrôle (pas d'injection d'en-tête), sans URL, sans identifiant opaque, bornée. */
const clean = (v: string): string => redact(v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " "), { urls: "drop", tokens: true }).replace(/\s+/g, " ").trim().slice(0, 120);

/** Refuse un contenu qui ressemblerait à un secret (défense en profondeur ; les champs sont déjà assainis). */
export function assertSafeContent(text: string, env: NodeJS.ProcessEnv = process.env): void {
  for (const s of secretValues(env)) if (text.includes(s)) throw new Error("CONTENT_REJECTED");
  if (/\b\d(?:[ -]?\d){12,18}\b/.test(text)) throw new Error("CONTENT_REJECTED"); // numéro de carte potentiel
  if (/\b(cvv2?|cvc2?|authorization|bearer|cookie|set-cookie|token|password|passwd|session[_-]?id|api[_-]?key)\b/i.test(text)) throw new Error("CONTENT_REJECTED");
  if (/[a-z][a-z0-9+.-]*:\/\/\S*/i.test(text)) throw new Error("CONTENT_REJECTED"); // aucune URL (donc aucun identifiant dans une URL)
}

export function buildEmail(cfg: Pick<EmailConfig, "from" | "to">, i: CartSuccessInfo, env: NodeJS.ProcessEnv = process.env): EmailMessage {
  const money = i.totalPrice !== undefined && Number.isFinite(i.totalPrice) ? `${i.totalPrice} ${clean(i.currency ?? "")}`.trim() : undefined;
  const lines = [
    "CART_SUCCESS",
    "",
    `Événement : ${clean(i.eventName)}`,
    `Plateforme : ${clean(i.platform)}`,
    ...(i.eventDate && /^\d{4}-\d{2}-\d{2}$/.test(i.eventDate) ? [`Date de l'événement : ${i.eventDate}`] : []),
    ...(i.quantity !== undefined ? [`Quantité : ${Math.floor(i.quantity)}`] : []),
    ...(i.category ? [`Catégorie / section : ${clean(i.category)}`] : []),
    ...(money ? [`Prix total : ${money}`] : []),
    `Heure du CART_SUCCESS : ${new Date(i.at).toISOString()}`,
    "",
    PAYMENT_LINE,
  ];
  const text = lines.join("\n");
  assertSafeContent(text, env);
  return { from: cfg.from, to: cfg.to, subject: `CART_SUCCESS — ${clean(i.eventName)}`.slice(0, 150), text };
}

// ───────────────────────────── envoi ─────────────────────────────
/** Expéditeur injectable : les tests utilisent un double local, jamais un vrai serveur. */
export type Mailer = (msg: EmailMessage) => Promise<void>;

export function createMailer(cfg: EmailConfig, env: NodeJS.ProcessEnv = process.env, timeoutMs = 10_000): Mailer {
  if (cfg.provider === "smtp") {
    const s = cfg.smtp!;
    return async (m) => {
      const t = nodemailer.createTransport({
        host: s.host,
        port: s.port,
        secure: s.secure,
        requireTLS: !s.secure && !/^(127\.0\.0\.1|localhost|::1)$/.test(s.host), // hors boucle locale : jamais d'authentification en clair
        auth: s.userEnv && s.passEnv ? { user: env[s.userEnv]!, pass: env[s.passEnv]! } : undefined,
        connectionTimeout: timeoutMs,
        greetingTimeout: timeoutMs,
        socketTimeout: timeoutMs,
      });
      try {
        await t.sendMail({ from: m.from, to: m.to, subject: m.subject, text: m.text });
      } finally {
        t.close();
      }
    };
  }
  const a = cfg.api!;
  return async (m) => {
    const res = await fetch(a.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env[a.tokenEnv]!}` },
      body: JSON.stringify({ from: m.from, to: m.to, subject: m.subject, text: m.text }),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  };
}

export type NotificationOutcome = "SENT" | "FAILED";

/** Envoi borné dans le temps : ne lève jamais (un échec n'est jamais une erreur de l'achat) ; l'erreur n'est jamais détaillée (elle pourrait citer un secret). */
export async function sendBounded(mailer: Mailer, msg: EmailMessage, timeoutMs: number): Promise<NotificationOutcome> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([mailer(msg), new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error("TIMEOUT")), timeoutMs)))]);
    return "SENT";
  } catch {
    return "FAILED";
  } finally {
    if (timer) clearTimeout(timer);
  }
}
