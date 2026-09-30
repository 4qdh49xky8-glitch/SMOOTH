import { BaseSiteAdapter } from "../../src/sites/BaseSiteAdapter.js";
import type { AdapterContext, AdapterMeta, Blocker, CartSummary, Offer, SaleSnapshot } from "../../src/sites/SiteAdapter.js";

/** Adaptateur scripté, sans navigateur : sert à tester le cœur indépendamment de tout site. */
export class FakeAdapter extends BaseSiteAdapter {
  meta: AdapterMeta = {
    id: "fake",
    displayName: "Faux site",
    testOnly: true,
    compliance: { policy: "demo", termsUrl: "http://localhost/", reviewedAt: "2026-01-01" },
    capabilities: { officialApi: false, preciseServerTime: true, lightweightAvailability: true, reportsSeatAdjacency: true, seatSelection: "none" },
  };
  calls: string[] = [];
  /** Latences simulées (ms) et chronologie détaillée de chaque appel (début/fin), pour mesurer parallélisme et attentes. */
  latency: Partial<Record<"fetchSale" | "detectBlocker" | "selectOffer" | "addToCart" | "readCart", number>> = {};
  timeline: { name: string; start: number; end: number }[] = [];
  private async timed<T>(name: keyof FakeAdapter["latency"] & string, fn: () => T | Promise<T>): Promise<T> {
    const start = performance.now();
    const ms = this.latency[name];
    if (ms) await new Promise((r) => setTimeout(r, ms));
    try {
      return await fn();
    } finally {
      this.timeline.push({ name, start, end: performance.now() });
    }
  }
  count(name: string): number {
    return this.timeline.filter((t) => t.name === name).length;
  }
  offers: Offer[] = [];
  /** Erreurs à lever, dans l'ordre, par étape (consommées une fois). */
  failures: Record<string, (Error | undefined)[]> = {};
  blocker: Blocker | null = null;
  selectSeats?: (ctx: AdapterContext, o: Offer, q: number) => Promise<void>;

  private maybeFail(step: string): void {
    const next = this.failures[step]?.shift();
    if (next) throw next;
  }
  async getServerTime(): Promise<number> {
    return Date.now();
  }
  protected async isLoggedIn(): Promise<boolean> {
    this.calls.push("isLoggedIn");
    return true;
  }
  override async prepare(): Promise<void> {
    this.calls.push("prepare");
  }
  async fetchSale(): Promise<SaleSnapshot> {
    return this.timed("fetchSale", () => {
      this.calls.push("fetchSale");
      return { open: this.saleOpen, offers: this.offers };
    });
  }
  saleOpen = true;
  async selectOffer(_c: AdapterContext, offer: Offer): Promise<void> {
    return this.timed("selectOffer", () => {
      this.calls.push(`selectOffer:${offer.id}`);
      this.maybeFail("selectOffer");
    });
  }
  async addToCart(): Promise<void> {
    return this.timed("addToCart", () => {
      this.calls.push("addToCart");
      this.maybeFail("addToCart");
    });
  }
  async readCart(): Promise<CartSummary> {
    return this.timed("readCart", () => {
      this.calls.push("readCart");
      return { itemCount: 2, totalPrice: 240, currency: "EUR", items: [{ label: "x", quantity: 2, unitPrice: 120 }] };
    });
  }
  override async detectBlocker(): Promise<Blocker | null> {
    return this.timed("detectBlocker", () => this.blocker);
  }
}

export const offer = (o: Partial<Offer> & { id: string }): Offer => ({
  category: "A", pricePerTicket: 100, currency: "EUR", available: 2, seatsTogether: true, ...o,
});
