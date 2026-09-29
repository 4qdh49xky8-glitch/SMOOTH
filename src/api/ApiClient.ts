import { BlockerError, NotLoggedInError, OfferUnavailableError, RateLimitedError } from "../utils/errors.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";

/**
 * Client HTTP pour les API OFFICIELLES documentées. Il n'est utilisé que par un adaptateur dont la plateforme est au
 * statut VERIFIED_API / VERIFIED_API_AND_BROWSER (preuve officielle valide). Garanties, non désactivables :
 *  - https uniquement, et l'hôte est verrouillé sur `baseUrl` (aucune requête vers un autre domaine, redirections refusées) ;
 *  - le secret vient d'une VARIABLE D'ENVIRONNEMENT nommée : jamais dans le code, la config, les logs ni les erreurs ;
 *  - cadence plafonnée (≥ 200 ms entre deux requêtes) ; 429/Retry-After respecté (jamais contourné) ;
 *  - 401/403/blocages/files d'attente/limites d'achat sont REMONTÉS au cœur (cession de main ou arrêt), jamais contournés.
 */
export interface ApiResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  body: T | undefined;
}

export interface ApiClientOptions {
  /** Base https de l'API officielle documentée (ex. `https://api.exemple-officiel.fr/v1`). */
  baseUrl: string;
  /** Nom de la variable d'environnement qui contient le secret, et façon de l'envoyer. */
  auth?: { envVar: string; header?: string; scheme?: "Bearer" | "raw" };
  /** Intervalle minimal entre deux requêtes (≥ 200 ms). */
  minIntervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  log?: Logger;
  /** Classification propre à l'API (codes d'erreur documentés) : retourne l'erreur à lever, ou undefined pour la classification par défaut. */
  classify?: (res: ApiResponse) => Error | undefined;
}

export interface RequestOptions {
  query?: Record<string, string | number>;
  body?: unknown;
  /** Statuts HTTP acceptés en plus de 2xx (ex. 404 pour « pas encore ouvert »). */
  allow?: number[];
}

const MAX_BODY = 1_000_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Retry-After : secondes ou date HTTP → millisecondes (borné 200 ms – 60 s). */
export function parseRetryAfter(v: string | undefined, now = Date.now()): number {
  if (!v) return 2000;
  const secs = Number(v);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(v) - now;
  return Math.min(60_000, Math.max(200, Number.isFinite(ms) ? ms : 2000));
}

/**
 * Classification par défaut (prudente) d'une réponse en erreur. Rien ici ne contourne quoi que ce soit :
 * chaque cas est remonté au cœur, qui cède la main à l'humain ou s'arrête.
 */
export function mapApiError(res: ApiResponse): Error {
  const code = String((res.body as { code?: unknown } | undefined)?.code ?? "").toLowerCase();
  if (/queue|waiting[_-]?room/.test(code)) return new BlockerError({ state: "QUEUE", message: "file d'attente officielle de l'API" });
  if (/captcha/.test(code)) return new BlockerError({ state: "CAPTCHA", message: "vérification humaine demandée par l'API" });
  if (/(purchase|ticket|order|quantity)[_-]?limit|limit[_-]?(exceeded|reached)/.test(code)) return new BlockerError({ state: "PURCHASE_LIMIT", message: "limite d'achat atteinte" });
  if (res.status === 429) return new RateLimitedError(parseRetryAfter(res.headers["retry-after"]));
  if (res.status === 401) return new NotLoggedInError("authentification API refusée : vérifiez la variable d'environnement du secret");
  if (res.status === 403) return new BlockerError({ state: "BLOCKED", message: "accès refusé par l'API : le bot ne contourne pas les refus" });
  if (res.status === 404 || res.status === 409 || res.status === 410) return new OfferUnavailableError(`API HTTP ${res.status}`);
  return new Error(`API HTTP ${res.status}`);
}

export class ApiClient {
  private readonly base: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: Logger;
  private readonly minInterval: number;
  private lastStart = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: ApiClientOptions) {
    let base: URL;
    try {
      base = new URL(o.baseUrl);
    } catch {
      throw new Error(`ApiClient : baseUrl invalide « ${o.baseUrl} »`);
    }
    if (base.protocol !== "https:") throw new Error("ApiClient : baseUrl doit être en https");
    if (base.username || base.password) throw new Error("ApiClient : pas d'identifiants dans l'URL (utilisez auth.envVar)");
    this.base = base;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.env = o.env ?? process.env;
    this.log = o.log ?? silentLogger;
    this.minInterval = Math.max(200, o.minIntervalMs ?? 400);
  }

  /** Requêtes séquentielles espacées d'au moins `minIntervalMs` : aucun martèlement, même appelé en parallèle. */
  private async gate<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.lastStart + this.minInterval - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastStart = Date.now();
      return fn();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private url(path: string, query?: Record<string, string | number>): URL {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("://")) throw new Error("ApiClient : chemin relatif à baseUrl attendu (commence par « / »)");
    const u = new URL(this.base.href.replace(/\/$/, "") + path);
    if (u.origin !== this.base.origin) throw new Error("ApiClient : requête vers un autre domaine refusée");
    const prefix = this.base.pathname.replace(/\/$/, "");
    if (!(u.pathname === prefix || u.pathname.startsWith(`${prefix}/`))) throw new Error("ApiClient : chemin hors du préfixe de baseUrl refusé");
    for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, String(v));
    return u;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
    const a = this.o.auth;
    if (a) {
      const secret = this.env[a.envVar];
      if (!secret) throw new NotLoggedInError(`variable d'environnement ${a.envVar} absente (secret de l'API officielle)`);
      h[a.header ?? "authorization"] = (a.scheme ?? "Bearer") === "Bearer" ? `Bearer ${secret}` : secret;
    }
    return h;
  }

  async request<T = unknown>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
    const url = this.url(path, opts.query);
    const headers = this.headers();
    return this.gate(async () => {
      const t0 = Date.now();
      const res = await this.fetchImpl(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        redirect: "manual", // jamais de redirection suivie : le secret ne quitte pas l'hôte
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 8000),
      });
      const text = (await res.text()).slice(0, MAX_BODY);
      let body: unknown;
      try {
        body = text && /json/i.test(res.headers.get("content-type") ?? "") ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
      const headersOut: Record<string, string> = {};
      res.headers.forEach((v, k) => (headersOut[k.toLowerCase()] = v));
      const out: ApiResponse<T> = { status: res.status, headers: headersOut, body: body as T | undefined };
      // Journal : méthode, chemin (sans paramètres), statut, durée — jamais d'en-têtes ni de corps.
      this.log.debug(`API ${method} ${url.pathname} → ${res.status} (${Date.now() - t0} ms)`);
      if (res.status >= 300 && res.status < 400) throw new Error(`redirection refusée (HTTP ${res.status}) : l'API officielle ne doit pas rediriger vers un autre hôte`);
      if (res.status >= 200 && res.status < 300) return out;
      if (opts.allow?.includes(res.status)) return out;
      throw this.o.classify?.(out) ?? mapApiError(out);
    });
  }
}
