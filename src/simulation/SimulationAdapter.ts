import { seatsAreContiguous } from "../agent/matcher.js";
import type { BotConfig } from "../config/schema.js";
import { BaseSiteAdapter } from "../sites/BaseSiteAdapter.js";
import type { AdapterContext, AdapterMeta, Blocker, CartSummary, Offer, SaleSnapshot } from "../sites/SiteAdapter.js";
import { BlockerError, NotLoggedInError, OfferUnavailableError, RateLimitedError } from "../utils/errors.js";
import { canarySuffix, type ErrorCode, type Scenario } from "./scenario.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Faux site entièrement en mémoire, piloté par un Scénario. N'ouvre aucune connexion réseau et
 * n'utilise ni page ni navigateur : il sert à exercer TOUTE la logique du cœur (horloge, matching,
 * stratégie, états, cession de la main, télémétrie) sans contacter un vrai site.
 * Volontairement hors de src/sites/ : il n'est pas découvert par le registre et ne peut pas être
 * sélectionné dans une config de production.
 */
export class SimulationAdapter extends BaseSiteAdapter {
  readonly meta: AdapterMeta;
  override readonly paymentUrlPatterns = [/\/payment(\/|\?|$)/];

  readonly calls: string[] = [];
  /** Horodatage (epoch ms local) de chaque appel : sert à prouver qu'aucune action n'a lieu pendant un blocage. */
  readonly callLog: { step: string; at: number }[] = [];
  /** Étapes d'action appelées alors que le faux site était bloqué (file/CAPTCHA/anti-bot) : doit rester vide. */
  readonly violations: { step: string; state: string }[] = [];
  private counts: Record<string, number> = {};
  private selected: Offer | null = null;
  private saleStartMs = 0;

  constructor(private readonly scenario: Scenario) {
    super();
    this.meta = {
      id: "simulation",
      displayName: "Simulation (aucun contact réseau)",
      compliance: { policy: "demo", termsUrl: "http://localhost/simulation", reviewedAt: "2026-01-01" },
      capabilities: {
        officialApi: false,
        preciseServerTime: true,
        lightweightAvailability: true,
        reportsSeatAdjacency: true,
        seatSelection: "automatic",
        ...(scenario.purchaseLimit && scenario.declareLimit ? { maxTicketsPerOrder: scenario.purchaseLimit } : {}),
      },
    };
  }

  private leak(): string {
    return this.scenario.leakCanaries ? canarySuffix() : "";
  }

  /** Blocage actif à cet instant (heure serveur simulée), s'il y en a un. */
  private activeBlock(): { state: "QUEUE" | "CAPTCHA" | "BLOCKED" } | null {
    const since = this.serverNow() - this.saleStartMs;
    return this.scenario.blockWindows.find((w) => since >= w.fromMs && since < w.untilMs) ?? null;
  }

  /** Doit être appelé avec l'heure de vente utilisée par l'agent. */
  setSaleStart(epochMs: number): void {
    this.saleStartMs = epochMs;
  }

  override resolveEventUrl(_config: BotConfig): string {
    return "http://localhost/simulation";
  }

  private async hit(step: string): Promise<void> {
    this.calls.push(step);
    this.callLog.push({ step, at: Date.now() });
    // Un vrai site afficherait sa file / son CAPTCHA à toute action : on enregistre la violation.
    const block = ["selectOffer", "selectSeats", "addToCart"].includes(step) ? this.activeBlock() : null;
    if (block) {
      this.violations.push({ step, state: block.state });
      throw new BlockerError({ state: block.state, message: `simulé : ${block.state}${this.leak()}` });
    }
    const latency = (this.scenario.latencyMs as Record<string, number | undefined>)[step] ?? 0;
    if (latency) await sleep(latency);
    const n = (this.counts[step] = (this.counts[step] ?? 0) + 1);
    const f = this.scenario.failures.find((x) => x.step === step && x.nth === n);
    if (f) throw toError(f.error, this.leak());
  }

  private serverNow(): number {
    return Date.now() + this.scenario.serverClockSkewMs;
  }
  async getServerTime(): Promise<number> {
    return this.serverNow();
  }

  protected async isLoggedIn(): Promise<boolean> {
    return true;
  }
  override async ensureLoggedIn(): Promise<void> {
    await this.hit("login");
  }
  override async prepare(): Promise<void> {
    this.calls.push("prepare");
  }

  async fetchSale(ctx: AdapterContext): Promise<SaleSnapshot> {
    await this.hit("fetchSale");
    const elapsed = this.serverNow() - this.saleStartMs;
    const open = elapsed >= this.scenario.saleOpensAfterMs;
    if (!open) return { open: false, offers: [] };
    const since = elapsed - this.scenario.saleOpensAfterMs;
    const offers: Offer[] = this.scenario.offers
      .filter((o) => o.appearsAtMs <= since && !(o.soldAtMs !== undefined && o.soldAtMs <= since))
      .map((o) => ({
        id: o.id,
        category: o.category,
        pricePerTicket: o.price,
        currency: o.currency,
        available: o.available,
        seatsTogether: seatsAreContiguous(o.seats, ctx.config.tickets.quantity),
        section: o.section,
        row: o.row,
        seats: o.seats,
      }));
    return { open, offers, soldOut: this.scenario.soldOut || undefined };
  }

  async selectOffer(_ctx: AdapterContext, offer: Offer, quantity: number): Promise<void> {
    await this.hit("selectOffer");
    const limit = this.scenario.purchaseLimit;
    if (limit !== undefined && quantity > limit) {
      throw new BlockerError({ state: "PURCHASE_LIMIT", message: `simulé : limite de ${limit} billets par commande atteinte${this.leak()}` });
    }
    const spec = this.scenario.offers.find((o) => o.id === offer.id);
    const since = this.serverNow() - this.saleStartMs - this.scenario.saleOpensAfterMs;
    if (spec?.soldAtMs !== undefined && spec.soldAtMs <= since) throw new OfferUnavailableError("vendue");
    this.selected = offer;
  }

  async selectSeats(): Promise<void> {
    await this.hit("selectSeats");
  }

  async addToCart(): Promise<void> {
    await this.hit("addToCart");
  }

  async readCart(ctx: AdapterContext): Promise<CartSummary> {
    await this.hit("readCart");
    const o = this.selected;
    const q = ctx.config.tickets.quantity;
    const count = this.scenario.cart?.itemCount ?? q;
    const unit = this.scenario.cart?.unitPrice ?? o?.pricePerTicket ?? 0;
    return {
      itemCount: count,
      totalPrice: unit * count,
      currency: o?.currency ?? "EUR",
      items: [{ label: "simulation", quantity: count, unitPrice: unit }],
      expiresAt: Date.now() + 10 * 60_000,
    };
  }

  override async detectBlocker(): Promise<Blocker | null> {
    const b = this.activeBlock();
    return b ? { state: b.state, message: `simulé : ${b.state}${this.leak()}` } : null;
  }
}

function toError(code: ErrorCode, leak: string): Error {
  switch (code) {
    case "OFFER_UNAVAILABLE":
      return new OfferUnavailableError(`simulé : offre vendue${leak}`);
    case "RATE_LIMITED":
      return new RateLimitedError(100);
    case "LOGIN_REQUIRED":
      return new NotLoggedInError(`simulé : connexion requise${leak}`);
    case "ERROR":
      return new Error(`simulé : erreur technique${leak}`);
    default:
      return new BlockerError({ state: code, message: `simulé : ${code}${leak}` });
  }
}
