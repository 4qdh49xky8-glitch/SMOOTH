import { randomUUID } from "node:crypto";
import { ApiClient, type ApiResponse } from "../../api/ApiClient.js";
import { BaseApiAdapter } from "../../api/BaseApiAdapter.js";
import type { BotConfig } from "../../config/schema.js";
import type { AdapterContext, AdapterMeta, Availability, CartSummary, Offer, SaleSnapshot } from "../SiteAdapter.js";
import { BlockerError, NotLoggedInError, OfferUnavailableError, RateLimitedError, StopRunError } from "../../utils/errors.js";
import { trackSecretEnv } from "../../utils/redact.js";

/**
 * pretix — canal API officielle, API REST documentée de pretix (https://docs.pretix.eu/dev/api/index.html).
 *
 * AUTHORIZED_SCOPE = CONTROLLED_PRETIX_INSTANCE_ONLY : cet adaptateur est destiné à un organisateur/événement que l'utilisateur administre,
 * ou pour lequel il détient explicitement les identifiants et permissions (clé d'API d'équipe). Il ne constitue PAS une autorisation
 * d'automatiser l'achat sur les événements de tiers : la clé d'API est la limite naturelle (un jeton n'ouvre que les événements de son équipe).
 *
 * Garanties propres à l'adaptateur (en plus de celles du cœur et d'ApiClient, inchangés) :
 *  - hôte unique et fixe (pretix.eu) ; organisateur/événement lus dans l'URL de l'événement `https://pretix.eu/<organisateur>/<événement>/` ;
 *  - secret uniquement dans PRETIX_API_TOKEN (environnement) ; jamais journalisé ;
 *  - AUCUNE opération de paiement : aucun chemin ni champ de paiement, aucune marque « payé » ;
 *  - mode `simulate` (défaut) : validation à blanc (`"simulate": true`), aucune commande créée, jamais présentée comme un panier ;
 *  - mode `create` (opt-in explicite `siteOptions.pretix.orderMode: "create"`) : UNE commande en attente (`n`), jamais plus : pas de nouvel envoi
 *    après une tentative au résultat incertain (la commande a peut-être été créée) ; relue et vérifiée avant tout CART_SUCCESS.
 */
export const PRETIX_HOST = "pretix.eu";
export const PRETIX_API_BASE = `https://${PRETIX_HOST}/api/v1`;
export const PRETIX_TOKEN_ENV = "PRETIX_API_TOKEN";
export const PRETIX_EMAIL_ENV = "PRETIX_ORDER_EMAIL";
const AUTH_ENV = "PRETIX_AUTH_HEADER";
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UNLIMITED_CAP = 1000;
const TODAY = "2026-09-30";

/** Résultats internes distincts : une simulation n'est jamais un panier. */
export type PretixResult = "PRETIX_SIMULATION_SUCCESS" | "PRETIX_ORDER_CREATED";
const EXTRA_FORBIDDEN_PATH = /(^|\/)(payments?|refunds?|mark_[a-z_]+|confirm[a-z_]*|transition|execute|change|extend|reactivate|resend_link)(\/|$)/i;

interface Names {
  [lang: string]: string;
}
interface PxItem {
  id: number;
  name?: string | Names;
  category?: number | null;
  active?: boolean;
  admission?: boolean;
  default_price?: string | null;
  min_per_order?: number | null;
  max_per_order?: number | null;
  available_from?: string | null;
  available_until?: string | null;
  variations?: { id: number; value?: string | Names; active?: boolean; default_price?: string | null; price?: string | null }[];
}
interface PxQuota {
  id: number;
  items?: number[];
  variations?: number[];
}
interface PxPosition {
  item?: number;
  variation?: number | null;
  price?: string;
}
interface PxOrder {
  code?: string;
  status?: string;
  total?: string;
  expires?: string | null;
  positions?: PxPosition[];
  fees?: { value?: string }[];
}
interface Page<T> {
  results?: T[];
  next?: string | null;
}

/** Montant décimal « 12.50 » → centimes entiers (jamais de flottants pour comparer des prix). */
export function toCents(v: unknown): number {
  const s = typeof v === "number" ? v.toFixed(2) : String(v ?? "").trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new Error("montant pretix mal formé");
  const [i, d = ""] = s.replace("-", "").split(".");
  const c = Number(i) * 100 + Number(d.padEnd(2, "0"));
  return s.startsWith("-") ? -c : c;
}
const label = (n: string | Names | undefined, fallback: string): string => (typeof n === "string" ? n : n ? Object.values(n)[0] ?? fallback : fallback);

export function parseEventUrl(url: string): { organizer: string; event: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("pretix : event.url invalide");
  }
  if (u.protocol !== "https:" || u.hostname.toLowerCase() !== PRETIX_HOST || u.username || u.password) throw new Error(`pretix : event.url doit être https://${PRETIX_HOST}/<organisateur>/<événement>/ (hôte fixe, sans identifiants)`);
  const [organizer, event] = u.pathname.split("/").filter(Boolean);
  if (!organizer || !event || !SLUG.test(organizer) || !SLUG.test(event)) throw new Error("pretix : organisateur/événement introuvables dans event.url");
  return { organizer, event };
}

export interface PretixOptions {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  minIntervalMs?: number;
  /** Attente (ms) après un 429 d'une écriture avant l'unique nouvel essai ; injectable pour les tests. */
  sleep?: (ms: number) => Promise<void>;
}

export default class PretixAdapter extends BaseApiAdapter {
  meta: AdapterMeta = {
    id: "pretix",
    displayName: "pretix (API REST officielle — instance contrôlée)",
    platform: "pretix",
    channel: "official-api",
    requires: { env: [PRETIX_TOKEN_ENV] },
    compliance: { policy: "official-api", termsUrl: "https://docs.pretix.eu/dev/api/index.html", reviewedAt: TODAY, notes: "AUTHORIZED_SCOPE = CONTROLLED_PRETIX_INSTANCE_ONLY" },
    capabilities: { officialApi: true, preciseServerTime: false, lightweightAvailability: true, reportsSeatAdjacency: false, seatSelection: "none" },
  };
  readonly client: ApiClient;
  /** Dernier résultat interne (simulation ≠ commande). */
  lastResult?: PretixResult;
  /** Journal des clés d'idempotence utilisées (tests). */
  readonly idempotencyKeys: string[] = [];
  private readonly env: NodeJS.ProcessEnv;
  private readonly sleep: (ms: number) => Promise<void>;
  private pendingKey: string | undefined;
  private currency = "EUR";
  private catalogLoaded?: { items: PxItem[]; categories: Map<number, string>; quotas: PxQuota[] };
  private offerMeta = new Map<string, { item: PxItem; variation?: number; cents: number; min: number }>();
  private selected?: { offer: Offer; quantity: number };
  private orderAttempted = false;
  private orderCode?: string;
  private orderId?: { organizer: string; event: string };

  constructor(o: PretixOptions = {}) {
    super();
    const raw = o.env ?? process.env;
    // L'en-tête d'authentification est construit À L'APPEL depuis PRETIX_API_TOKEN : la valeur n'est ni copiée ni conservée.
    this.env = new Proxy(raw, { get: (t, k: string) => (k === AUTH_ENV ? (t[PRETIX_TOKEN_ENV] ? `Token ${t[PRETIX_TOKEN_ENV]}` : undefined) : t[k]) });
    trackSecretEnv(PRETIX_TOKEN_ENV, AUTH_ENV);
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const base: typeof fetch = o.fetchImpl ?? globalThis.fetch;
    // Clé d'idempotence posée uniquement sur la création de commande (un seul en-tête ajouté, rien d'autre).
    const withKey = ((input: string | URL | Request, init?: RequestInit) => {
      const key = this.pendingKey;
      const headers = key ? { ...(init?.headers as Record<string, string> | undefined), "X-Idempotency-Key": key } : init?.headers;
      return base(input, { ...init, headers });
    }) as typeof fetch;
    this.client = new ApiClient({
      baseUrl: PRETIX_API_BASE,
      allowedHosts: [PRETIX_HOST],
      auth: { envVar: AUTH_ENV, header: "authorization", scheme: "raw" },
      fetchImpl: withKey,
      env: this.env,
      minIntervalMs: o.minIntervalMs,
      classify: (res) => (res.status === 400 ? new OfferUnavailableError("commande refusée par la validation de pretix") : undefined),
    });
  }

  allowedHosts(): string[] {
    return [PRETIX_HOST];
  }

  resolveEventUrl(config: BotConfig): string {
    const url = super.resolveEventUrl(config);
    parseEventUrl(url);
    return url;
  }

  private ids(ctx: AdapterContext): { organizer: string; event: string } {
    this.orderId = parseEventUrl(this.resolveEventUrl(ctx.config));
    return this.orderId;
  }
  private base(ctx: AdapterContext): string {
    const { organizer, event } = this.ids(ctx);
    return `/organizers/${organizer}/events/${event}`;
  }
  private mode(ctx: AdapterContext): "simulate" | "create" {
    const o = (ctx.config.siteOptions as { pretix?: { orderMode?: unknown } }).pretix?.orderMode;
    if (o === undefined || o === "simulate") return "simulate";
    if (o === "create") return "create";
    throw new Error('pretix : siteOptions.pretix.orderMode ∈ "simulate" | "create"');
  }

  /** Point d'entrée unique vers l'API : refuse tout chemin de paiement ou de transition de commande en plus des garde-fous d'ApiClient. */
  private async call<T>(method: "GET" | "POST", path: string, opts: { body?: unknown; query?: Record<string, string | number> } = {}): Promise<ApiResponse<T>> {
    if (EXTRA_FORBIDDEN_PATH.test(path)) throw new Error("pretix : chemin refusé (paiement / transition de commande) — le paiement reste manuel");
    return this.client.request<T>(method, path, opts);
  }

  private async pages<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let next: { path: string; query?: Record<string, string> } | undefined = { path };
    for (let i = 0; next && i < 20; i++) {
      const r: ApiResponse<Page<T>> = await this.call<Page<T>>("GET", next.path, { query: next.query });
      if (!r.body || !Array.isArray(r.body.results)) throw new Error("pretix : réponse mal formée (liste attendue)");
      out.push(...r.body.results);
      next = undefined;
      if (r.body.next) {
        const u = new URL(r.body.next, PRETIX_API_BASE);
        if (u.hostname !== PRETIX_HOST || !u.pathname.startsWith("/api/v1/")) throw new Error("pretix : page suivante hors de l'hôte autorisé refusée");
        next = { path: u.pathname.slice("/api/v1".length), query: Object.fromEntries(u.searchParams) };
      }
    }
    return out;
  }

  async authenticate(ctx: AdapterContext): Promise<void> {
    if (!this.env[PRETIX_TOKEN_ENV]) throw new NotLoggedInError(`variable d'environnement ${PRETIX_TOKEN_ENV} absente (clé d'API de votre équipe pretix)`);
    const r = await this.call<{ currency?: string }>("GET", `${this.base(ctx)}/`).catch((e: unknown) => {
      if (e instanceof OfferUnavailableError) throw new Error("pretix : organisateur/événement introuvable ou inaccessible avec cette clé");
      throw e;
    });
    if (!r.body || typeof r.body !== "object") throw new Error("pretix : réponse mal formée (événement)");
    if (typeof r.body.currency === "string") this.currency = r.body.currency;
  }

  async warmUp(ctx: AdapterContext): Promise<void> {
    await this.loadCatalog(ctx);
  }

  private async loadCatalog(ctx: AdapterContext): Promise<NonNullable<PretixAdapter["catalogLoaded"]>> {
    if (this.catalogLoaded) return this.catalogLoaded;
    const b = this.base(ctx);
    const [items, cats, quotas] = await Promise.all([this.pages<PxItem>(`${b}/items/`), this.pages<{ id: number; name?: string | Names }>(`${b}/categories/`), this.pages<PxQuota>(`${b}/quotas/`)]);
    this.catalogLoaded = { items, categories: new Map(cats.map((c) => [c.id, label(c.name, "Général")])), quotas };
    return this.catalogLoaded;
  }

  async listOffers(ctx: AdapterContext): Promise<SaleSnapshot> {
    const b = this.base(ctx);
    const cat = await this.loadCatalog(ctx);
    const ev = await this.call<{ live?: boolean; presale_start?: string | null; presale_end?: string | null; currency?: string }>("GET", `${b}/`);
    if (!ev.body || typeof ev.body !== "object") throw new Error("pretix : réponse mal formée (événement)");
    if (typeof ev.body.currency === "string") this.currency = ev.body.currency;
    const now = Date.now();
    const inWindow = (from?: string | null, until?: string | null): boolean => (!from || Date.parse(from) <= now) && (!until || Date.parse(until) >= now);
    const open = ev.body.live === true && inWindow(ev.body.presale_start, ev.body.presale_end);
    if (!open) return { open: false, offers: [] };

    // Disponibilité des quotas (un appel par quota ; séquentiel, cadence plafonnée par ApiClient).
    const avail = new Map<number, number>();
    for (const q of cat.quotas) {
      const r = await this.call<{ available?: boolean; available_number?: number | null }>("GET", `${b}/quotas/${q.id}/availability/`);
      if (!r.body || typeof r.body.available !== "boolean") throw new Error("pretix : réponse mal formée (disponibilité)");
      avail.set(q.id, r.body.available ? (r.body.available_number ?? UNLIMITED_CAP) : 0);
    }
    const offers: Offer[] = [];
    this.offerMeta.clear();
    for (const item of cat.items) {
      if (item.active === false || item.admission === false || !inWindow(item.available_from, item.available_until)) continue;
      const variations = item.variations ?? [];
      const targets: { id: string; variation?: number; name: string; price: string | null | undefined }[] = variations.length
        ? variations.filter((v) => v.active !== false).map((v) => ({ id: `${item.id}:${v.id}`, variation: v.id, name: label(v.value, String(v.id)), price: v.default_price ?? v.price ?? item.default_price }))
        : [{ id: String(item.id), name: label(item.name, String(item.id)), price: item.default_price }];
      for (const t of targets) {
        if (t.price === null || t.price === undefined) continue;
        const cents = toCents(t.price);
        const quotas = cat.quotas.filter((q) => (t.variation === undefined ? (q.items ?? []).includes(item.id) : (q.variations ?? []).includes(t.variation)));
        let available = quotas.length ? Math.min(...quotas.map((q) => avail.get(q.id) ?? 0)) : 0;
        // La limite par commande annoncée par pretix est appliquée telle quelle : jamais de commandes multiples pour la contourner.
        if (item.max_per_order) available = Math.min(available, item.max_per_order);
        const min = item.min_per_order ?? 1;
        this.offerMeta.set(t.id, { item, variation: t.variation, cents, min });
        offers.push({
          id: t.id,
          category: item.category ? cat.categories.get(item.category) ?? "Général" : "Général",
          pricePerTicket: cents / 100,
          currency: this.currency,
          available: Math.max(0, available),
          seatsTogether: "unknown",
        });
      }
    }
    return { open: true, offers, soldOut: offers.every((o) => o.available <= 0) };
  }

  async getAvailability(ctx: AdapterContext): Promise<Availability> {
    const s = await this.listOffers(ctx);
    return { open: s.open, soldOut: s.soldOut ?? false };
  }

  /** Veto : la quantité minimale par commande annoncée par pretix. */
  matchOffer(offer: Offer, criteria: BotConfig["tickets"]): boolean {
    const m = this.offerMeta.get(offer.id);
    return !m || criteria.quantity >= m.min;
  }

  private body(offer: Offer, quantity: number, simulate: boolean): Record<string, unknown> {
    const m = this.offerMeta.get(offer.id);
    if (!m) throw new OfferUnavailableError("offre inconnue (relisez les offres)");
    const email = this.env[PRETIX_EMAIL_ENV];
    return {
      ...(simulate ? { simulate: true } : {}),
      ...(email ? { email } : {}),
      locale: "en",
      status: "n",
      positions: Array.from({ length: quantity }, () => ({ item: m.item.id, ...(m.variation === undefined ? {} : { variation: m.variation }) })),
    };
  }

  /** Écriture (POST) : une attente `Retry-After` puis UN seul nouvel essai sur 429 ; jamais de boucle. */
  private async write(ctx: AdapterContext, body: Record<string, unknown>): Promise<ApiResponse<PxOrder>> {
    const path = `${this.base(ctx)}/orders/`;
    try {
      return await this.call<PxOrder>("POST", path, { body });
    } catch (e) {
      if (!(e instanceof RateLimitedError)) throw e;
      await this.sleep(e.retryAfterMs);
      try {
        return await this.call<PxOrder>("POST", path, { body });
      } catch (e2) {
        if (e2 instanceof RateLimitedError) throw new OfferUnavailableError("limite de débit pretix persistante : arrêt des tentatives");
        throw e2;
      }
    }
  }

  private checkOrderShape(o: PxOrder | undefined, quantity: number, unitCents: number): PxOrder {
    if (!o || !Array.isArray(o.positions) || o.total === undefined) throw new Error("pretix : réponse mal formée (commande)");
    if (o.positions.length !== quantity) throw new OfferUnavailableError("commande incohérente : nombre de billets différent de la demande");
    const sum = o.positions.reduce((s, p) => s + toCents(p.price), 0) + (o.fees ?? []).reduce((s, f) => s + toCents(f.value), 0);
    if (sum !== toCents(o.total)) throw new OfferUnavailableError("commande incohérente : total ≠ somme des lignes");
    if (o.positions.some((p) => toCents(p.price) !== unitCents)) throw new OfferUnavailableError("prix pretix différent du prix annoncé");
    return o;
  }

  /** Sélection = validation à blanc (`simulate: true`) : aucune commande n'est créée, le résultat est PRETIX_SIMULATION_SUCCESS. */
  async holdOffer(ctx: AdapterContext, offer: Offer, quantity: number): Promise<void> {
    const m = this.offerMeta.get(offer.id);
    if (!m) throw new OfferUnavailableError("offre inconnue (relisez les offres)");
    const r = await this.write(ctx, this.body(offer, quantity, true));
    this.checkOrderShape(r.body, quantity, m.cents);
    this.selected = { offer, quantity };
    this.pendingKey = undefined;
    this.lastResult = "PRETIX_SIMULATION_SUCCESS";
    ctx.log.info("PRETIX_SIMULATION_SUCCESS : validation à blanc réussie (aucune commande créée, ce n'est pas un panier)");
  }

  /** Création de la commande en attente — uniquement en mode `create`. En mode `simulate`, rien n'est créé et le run s'arrête explicitement. */
  async reserve(ctx: AdapterContext): Promise<void> {
    if (this.mode(ctx) === "simulate") {
      throw new StopRunError({ state: "BLOCKED", message: "PRETIX_SIMULATION_SUCCESS — mode simulation : aucune commande créée, donc aucun panier (siteOptions.pretix.orderMode: \"create\" pour créer une commande en attente sur VOTRE instance)" });
    }
    if (!this.selected) throw new Error("pretix : aucune offre sélectionnée");
    if (!this.env[PRETIX_EMAIL_ENV]) throw new Error(`pretix : ${PRETIX_EMAIL_ENV} requis pour créer une commande (adresse de contact de la commande)`);
    if (this.orderAttempted) throw new StopRunError({ state: "BLOCKED", message: "pretix : une création de commande a déjà été tentée — aucune seconde commande (vérifiez sur votre instance)" });
    this.orderAttempted = true;
    const { offer, quantity } = this.selected;
    this.pendingKey = randomUUID();
    this.idempotencyKeys.push(this.pendingKey);
    let r: ApiResponse<PxOrder>;
    try {
      r = await this.write(ctx, this.body(offer, quantity, false));
    } catch (e) {
      // Refus définitif connu (validation, droits, limite de débit) : rien n'a été créé ; le reste est incertain → aucune nouvelle tentative.
      if (e instanceof OfferUnavailableError || e instanceof NotLoggedInError || e instanceof BlockerError) {
        this.orderAttempted = false;
        throw e;
      }
      throw new StopRunError({ state: "BLOCKED", message: "pretix : création de commande au résultat incertain — aucune nouvelle tentative, vérifiez sur votre instance" });
    } finally {
      this.pendingKey = undefined;
    }
    // La requête a été acceptée : une commande existe peut-être. Toute anomalie ici est une erreur définitive, jamais une invitation à recréer.
    try {
      const order = this.checkOrderShape(r.body, quantity, toCents(offer.pricePerTicket));
      if (!order.code) throw new Error("réponse sans code de commande");
      this.orderCode = order.code;
      this.lastResult = "PRETIX_ORDER_CREATED";
    } catch {
      throw new StopRunError({ state: "BLOCKED", message: "pretix : commande créée mais réponse incohérente — aucune nouvelle tentative, vérifiez sur votre instance" });
    }
  }

  /** Relit la commande et vérifie code, événement, positions, quantité, prix, statut (pending ≠ paid) et expiration. */
  async readReservation(ctx: AdapterContext): Promise<CartSummary> {
    if (!this.orderCode || !this.selected) throw new Error("pretix : aucune commande créée (mode simulation : pas de panier)");
    const r = await this.call<PxOrder>("GET", `${this.base(ctx)}/orders/${encodeURIComponent(this.orderCode)}/`);
    const o = r.body;
    const { offer, quantity } = this.selected;
    const m = this.offerMeta.get(offer.id)!;
    this.checkOrderShape(o, quantity, m.cents);
    if (o!.code !== this.orderCode) throw new Error("pretix : code de commande différent de celui créé");
    if (o!.status !== "n") throw new Error(`pretix : statut de commande « ${String(o!.status)} » ≠ « n » (en attente) — pas un panier prêt pour un paiement manuel`);
    if (o!.positions!.some((p) => p.item !== m.item.id || (m.variation !== undefined && p.variation !== m.variation))) throw new Error("pretix : positions de commande différentes de l'offre choisie");
    const expiresAt = o!.expires ? Date.parse(o!.expires) : undefined;
    if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) throw new Error("pretix : commande expirée");
    return {
      itemCount: o!.positions!.length,
      totalPrice: toCents(o!.total) / 100,
      currency: this.currency,
      items: [{ label: offer.category, quantity: o!.positions!.length, unitPrice: m.cents / 100 }],
      ...(expiresAt ? { expiresAt } : {}),
    };
  }
}
