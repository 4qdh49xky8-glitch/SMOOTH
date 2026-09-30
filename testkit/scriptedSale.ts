import type { BotConfig } from "../src/config/schema.js";
import { BaseSiteAdapter } from "../src/sites/BaseSiteAdapter.js";
import type { AdapterContext, AdapterMeta, Blocker, CartSummary, Offer } from "../src/sites/SiteAdapter.js";
import { BlockerError, OfferUnavailableError, RateLimitedError } from "../src/utils/errors.js";

/**
 * TEST_ONLY · NOT_A_REAL_PLATFORM — adaptateur SCRIPTÉ pour mesurer le chemin critique d'une vente sans aucun navigateur ni réseau.
 * Le scénario est une fonction du temps et du numéro de lecture : vente fermée, ouverture, offres qui n'ont rien à voir avec vos critères
 * d'abord, file d'attente, CAPTCHA, limite d'achat, panier incohérent… Chaque opération est consignée avec son horodatage.
 * Il implémente `getAvailability` + `getOffers` (lecture en deux temps) : les offres ne sont lues que lorsque la vente est ouverte.
 */
export interface SaleFrame {
  open: boolean;
  soldOut?: boolean;
  offers?: Offer[];
  blocker?: Blocker | null;
}

export interface ScriptedSaleOptions {
  /** Ouverture de la vente (epoch ms). */
  t0: number;
  /** État du site à la lecture n° `poll` (1, 2…), `ms` après l'ouverture (négatif avant). */
  frame: (p: { poll: number; ms: number }) => SaleFrame;
  selectMs?: number;
  addMs?: number;
  cartMs?: number;
  /** Issue de la n-ième tentative d'ajout au panier. */
  onAdd?: (attempt: number) => "ok" | "unavailable" | "limit";
  /** Quantité réellement présente dans le panier relu (défaut : celle demandée). */
  cartQuantity?: (requested: number) => number;
  /** Limite de débit (429) à la lecture n° `poll`. */
  rateLimit?: { poll: number; retryAfterMs: number };
  /** Exception à lever à la sélection (ex. SelectorNotFoundError : ambiguïté explicite). */
  selectError?: (attempt: number) => Error | undefined;
  /** Veto de la plateforme. */
  veto?: (o: Offer) => boolean;
}

export interface OpRecord {
  op: string;
  at: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class ScriptedSaleAdapter extends BaseSiteAdapter {
  meta: AdapterMeta = {
    id: "scripted",
    displayName: "Vente scriptée (TEST_ONLY · NOT_A_REAL_PLATFORM)",
    testOnly: true,
    compliance: { policy: "demo", termsUrl: "http://localhost/scripted", reviewedAt: "2026-01-01" },
    capabilities: { officialApi: false, preciseServerTime: true, lightweightAvailability: true, reportsSeatAdjacency: true, seatSelection: "none" },
  };
  readonly ops: OpRecord[] = [];
  polls = 0;
  private cur: SaleFrame = { open: false };
  private selected?: Offer;
  private adds = 0;
  private selects = 0;
  private requested = 0;
  constructor(readonly o: ScriptedSaleOptions) {
    super();
  }
  private rec(op: string): void {
    this.ops.push({ op, at: Date.now() });
  }
  count(op: string): number {
    return this.ops.filter((x) => x.op === op).length;
  }
  async getServerTime(): Promise<number> {
    return Date.now();
  }
  protected async isLoggedIn(): Promise<boolean> {
    return true;
  }
  override async prepare(_ctx: AdapterContext): Promise<void> {
    this.rec("prepare");
  }
  override async getAvailability() {
    this.rec("getAvailability");
    this.polls++;
    const rl = this.o.rateLimit;
    if (rl && this.polls === rl.poll) throw new RateLimitedError(rl.retryAfterMs);
    this.cur = this.o.frame({ poll: this.polls, ms: Date.now() - this.o.t0 });
    return { open: this.cur.open, soldOut: !!this.cur.soldOut };
  }
  override async getOffers(): Promise<Offer[]> {
    this.rec("getOffers");
    return this.cur.offers ?? [];
  }
  override async detectBlocker(): Promise<Blocker | null> {
    return this.cur.blocker ?? null;
  }
  override matchOffer(o: Offer, _c: BotConfig["tickets"]): boolean {
    return this.o.veto ? this.o.veto(o) : true;
  }
  async selectOffer(ctx: AdapterContext, offer: Offer, quantity: number): Promise<void> {
    this.rec("selectOffer");
    this.selects++;
    const err = this.o.selectError?.(this.selects);
    if (err) throw err;
    await sleep(this.o.selectMs ?? 5);
    this.selected = offer;
    this.requested = quantity;
    void ctx;
  }
  async addToCart(): Promise<void> {
    this.rec("addToCart");
    this.adds++;
    await sleep(this.o.addMs ?? 5);
    const r = this.o.onAdd?.(this.adds) ?? "ok";
    if (r === "unavailable") throw new OfferUnavailableError("vendu entre-temps");
    if (r === "limit") throw new BlockerError({ state: "PURCHASE_LIMIT", message: "limite d'achat atteinte" });
  }
  override async getCartState(): Promise<CartSummary> {
    this.rec("getCartState");
    await sleep(this.o.cartMs ?? 5);
    const q = this.o.cartQuantity?.(this.requested) ?? this.requested;
    const price = this.selected?.pricePerTicket ?? 0;
    return { itemCount: q, totalPrice: q * price, currency: "EUR", items: [{ label: this.selected?.id ?? "?", quantity: q, unitPrice: price }] };
  }
}
