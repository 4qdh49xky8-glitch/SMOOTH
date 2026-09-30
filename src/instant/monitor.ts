import { BaseSiteAdapter } from "../sites/BaseSiteAdapter.js";
import type { AdapterContext, Blocker, Offer, SaleSnapshot, SiteAdapter } from "../sites/SiteAdapter.js";
import { RateLimitedError } from "../utils/errors.js";
import type { CompiledSelectionCriteria } from "./compile.js";
import { Timeline, wallNow } from "./timeline.js";

/**
 * INSTANT-ON-SALE — surveillance AUTORISÉE de la disponibilité, au-dessus du cœur (qui reste inchangé et pilote la boucle).
 *
 * Règles :
 *  - jamais plus vite que `minIntervalMs` (≥ cadence de la configuration, plancher 200 ms) : aucune accélération pour « gagner » ;
 *  - un RateLimitedError (429 / Retry-After) est relayé au cœur ET mémorisé : aucune lecture avant l'échéance demandée ;
 *  - une source officielle de disponibilité (flux/webhook exposé par l'adaptateur) passe en priorité ; sans elle, seule la lecture de
 *    l'adaptateur est utilisée (navigateur ou API), jamais un point d'accès non documenté ;
 *  - disponibilité d'abord (légère) : les offres ne sont lues que lorsque la vente est ouverte et non complète ;
 *  - l'état bloquant (file, CAPTCHA, anti-bot, connexion) est lu EN PARALLÈLE, comme le cœur le fait : aucune sélection pendant un blocage.
 */
export type CallName = "getEvent" | "getAvailability" | "getOffers" | "matchOffer" | "selectOffer" | "addToCart" | "getCartState" | "fetchSale" | "readCart" | "pollState" | "detectBlocker" | "prepare";
export type CallCounts = Record<CallName, number>;
export const newCounts = (): CallCounts => ({ getEvent: 0, getAvailability: 0, getOffers: 0, matchOffer: 0, selectOffer: 0, addToCart: 0, getCartState: 0, fetchSale: 0, readCart: 0, pollState: 0, detectBlocker: 0, prepare: 0 });

/** Source OFFICIELLE de disponibilité (flux, webhook, SSE documentés) que certains adaptateurs peuvent exposer. Optionnelle. */
export interface AvailabilityFeed {
  subscribeAvailability(ctx: AdapterContext, onOpen: () => void): Promise<() => void> | (() => void);
}
const hasFeed = (a: unknown): a is AvailabilityFeed => typeof (a as AvailabilityFeed | undefined)?.subscribeAvailability === "function";

const withTimeout = <T,>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then((v) => (clearTimeout(t), resolve(v)), () => (clearTimeout(t), resolve(fallback)));
  });

export interface MonitorMetrics {
  polls: number;
  /** Lectures effectivement émises vers l'adaptateur (hors polls évités par le flux officiel). */
  reads: number;
  skippedByFeed: number;
  rateLimited: number;
  errors: number;
  /** Identifiants distincts d'offres examinées. */
  offersExamined: number;
  feed: "none" | "subscribed" | "signalled";
}

export interface MonitorOptions {
  /** Adaptateur INSTRUMENTÉ (les appels sont comptés). */
  adapter: SiteAdapter;
  /** Adaptateur d'origine (détection des capacités natives). */
  raw: SiteAdapter;
  ctx: AdapterContext;
  criteria: CompiledSelectionCriteria;
  timeline: Timeline;
  counts: CallCounts;
  /** Intervalle minimal entre deux lectures (ms) ; plancher 200. */
  minIntervalMs: number;
  saleStartMs: number;
  blockerTimeoutMs?: number;
  /** Après T0 + ce délai sans signal du flux officiel, la lecture normale reprend (un signal manqué ne doit pas faire manquer la vente). */
  feedGraceMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class SaleMonitor {
  private readonly o: MonitorOptions;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private started = false;
  private stopped = false;
  private lastStart = 0;
  private notBefore = 0;
  private availability = false;
  private unsubscribe?: () => void;
  private feedState: MonitorMetrics["feed"] = "none";
  private readonly listeners: ((at: number) => void)[] = [];
  private readonly seen = new Set<string>();
  private readonly m = { polls: 0, reads: 0, skippedByFeed: 0, rateLimited: 0, errors: 0 };
  private readonly split: boolean;
  private readonly nativePoll?: (ctx: AdapterContext) => Promise<{ snapshot: SaleSnapshot; blocker: Blocker | null }>;

  constructor(o: MonitorOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const raw = o.raw as unknown as Record<string, unknown>;
    const proto = BaseSiteAdapter.prototype as unknown as Record<string, unknown>;
    // Lecture en deux temps (disponibilité puis offres) seulement si l'adaptateur les implémente VRAIMENT ; sinon une lecture unique (fetchSale).
    this.split = o.raw instanceof BaseSiteAdapter && raw.getAvailability !== proto.getAvailability && raw.getOffers !== proto.getOffers;
    const np = (o.raw as { pollState?: MonitorOptions["raw"]["pollState"] }).pollState;
    this.nativePoll = np ? np.bind(o.raw) : undefined;
  }

  /** Démarre la surveillance (après la préparation, avant T0) : s'abonne au flux OFFICIEL s'il existe. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (hasFeed(this.o.raw)) {
      this.feedState = "subscribed";
      this.unsubscribe = await this.o.raw.subscribeAvailability(this.o.ctx, () => void (this.feedState = "signalled"));
    }
  }

  stop(): void {
    this.stopped = true;
    try {
      this.unsubscribe?.();
    } catch {
      /* déjà fermé */
    }
  }

  /** Appelé UNE fois, dès qu'une vente ouverte et non complète est constatée (avant le filtrage). */
  onAvailability(cb: (at: number) => void): void {
    this.listeners.push(cb);
  }

  getMetrics(): MonitorMetrics {
    return { ...this.m, offersExamined: this.seen.size, feed: this.feedState };
  }

  private markAvailability(): void {
    if (this.availability) return;
    this.availability = true;
    const at = wallNow();
    this.o.timeline.mark("T_AVAILABILITY_DETECTED", at);
    for (const cb of this.listeners) cb(at);
  }

  /** Lecture cohérente « disponibilité + offres + état bloquant » : signature de `pollState` attendue par le cœur. */
  poll = async (): Promise<{ snapshot: SaleSnapshot; blocker: Blocker | null }> => {
    const { adapter, ctx, criteria, timeline } = this.o;
    if (this.stopped) return { snapshot: { open: false, offers: [] }, blocker: null };
    const t = this.now();
    if (t < this.notBefore) throw new RateLimitedError(this.notBefore - t); // Retry-After respecté : AUCUNE lecture avant l'échéance
    const wait = this.lastStart + Math.max(200, this.o.minIntervalMs) - t;
    if (wait > 0) await this.sleep(wait); // jamais plus vite que la cadence autorisée
    this.lastStart = this.now();
    this.m.polls++;
    timeline.mark("T_FIRST_POLL");
    if (this.feedState === "subscribed" && this.now() < this.o.saleStartMs + (this.o.feedGraceMs ?? 3000)) {
      this.m.skippedByFeed++; // le flux officiel n'a pas signalé l'ouverture : aucune lecture
      return { snapshot: { open: false, offers: [] }, blocker: null };
    }
    try {
      this.m.reads++;
      let snapshot: SaleSnapshot;
      let blocker: Blocker | null;
      if (this.nativePoll) {
        this.o.counts.pollState++; // lecture unique coordonnée par l'adaptateur (file officielle d'abord)
        ({ snapshot, blocker } = await this.nativePoll(ctx));
        if (snapshot.open && !snapshot.soldOut && snapshot.offers.some((x) => x.available > 0)) this.markAvailability();
      } else {
        [snapshot, blocker] = await Promise.all([this.read(), withTimeout(adapter.detectBlocker(ctx), this.o.blockerTimeoutMs ?? 250, null)]);
      }
      for (const x of snapshot.offers) this.seen.add(x.id);
      // Filtres durs compilés : les offres que le cœur écarterait de toute façon ne l'atteignent pas (la décision reste celle du cœur).
      return { snapshot: { ...snapshot, offers: criteria.candidates(snapshot.offers) }, blocker };
    } catch (e) {
      if (e instanceof RateLimitedError) {
        this.m.rateLimited++;
        this.notBefore = this.now() + e.retryAfterMs;
      } else this.m.errors++;
      throw e;
    }
  };

  private async read(): Promise<SaleSnapshot> {
    const { adapter, ctx } = this.o;
    if (!this.split) {
      const s = await adapter.fetchSale(ctx);
      if (s.open && !s.soldOut && s.offers.some((x: Offer) => x.available > 0)) this.markAvailability();
      return s;
    }
    const a = await adapter.getAvailability(ctx);
    if (!a.open || a.soldOut) return { open: a.open, ...(a.soldOut ? { soldOut: true } : {}), offers: [] }; // rien d'ouvert ou complet : les offres ne sont PAS lues
    this.markAvailability();
    return { open: true, offers: await adapter.getOffers(ctx) };
  }
}

// ───────────────────────────── instrumentation ─────────────────────────────
export interface InstrumentOptions {
  timeline: Timeline;
  counts: CallCounts;
  onSelect?: (o: Offer) => void;
  onCartRequest?: () => void;
  onCartState?: (ok: boolean) => void;
}

const COUNTED: readonly CallName[] = ["getEvent", "getAvailability", "getOffers", "matchOffer", "selectOffer", "addToCart", "getCartState", "fetchSale", "readCart", "detectBlocker", "prepare"];

/**
 * Décore l'adaptateur (Proxy) : compte chaque appel, horodate sélection / requête de panier / relecture du panier, et expose `pollState`
 * (la surveillance). Les méthodes de l'adaptateur sont appelées sur l'adaptateur d'origine (`this` inchangé) : les appels internes
 * (p. ex. getAvailability dérivée de fetchSale) ne sont pas comptés deux fois. Aucune permission n'est ajoutée ni retirée.
 */
export function instrument(raw: SiteAdapter, o: InstrumentOptions, monitor: () => SaleMonitor | undefined): SiteAdapter {
  return new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop === "__counts") return o.counts;
      if (prop === "pollState") return monitor() ? monitor()!.poll : Reflect.get(target, prop);
      const v = Reflect.get(target, prop, target);
      if (typeof v !== "function") return v;
      const name = prop as CallName;
      const bound = (v as (...a: unknown[]) => unknown).bind(target);
      if (!COUNTED.includes(name)) return bound;
      return (...args: unknown[]) => {
        // Le cœur relit le panier par `readCart` : compté sous son nom de contrat « getCartState ».
        o.counts[name === "readCart" ? "getCartState" : name]++;
        if (name === "prepare") o.timeline.mark("T_EVENT_START");
        if (name === "addToCart") {
          o.timeline.mark("T_CART_REQUEST", wallNow(), true);
          o.onCartRequest?.();
        }
        const out = bound(...args);
        if (name === "matchOffer") return out;
        if (!(out instanceof Promise)) return out;
        return out.then((res) => {
          if (name === "selectOffer") {
            o.timeline.mark("T_OFFER_SELECTED", wallNow(), true);
            o.onSelect?.(args[1] as Offer);
          } else if (name === "prepare") o.timeline.mark("T_EVENT_READY");
          else if (name === "getCartState" || name === "readCart") {
            o.timeline.mark("T_CART_SUCCESS", wallNow(), true); // retenu seulement si le cœur valide le panier (voir runner)
            o.onCartState?.(true);
          }
          return res;
        });
      };
    },
    has: (t, p) => p === "pollState" || Reflect.has(t, p),
  });
}
