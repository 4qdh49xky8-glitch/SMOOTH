import { BaseSiteAdapter } from "../../src/sites/BaseSiteAdapter.js";
import type { AdapterContext, AdapterMeta, Blocker, CartSummary, Offer, SaleSnapshot } from "../../src/sites/SiteAdapter.js";

/** Adaptateur scripté, sans navigateur : sert à tester le cœur indépendamment de tout site. */
export class FakeAdapter extends BaseSiteAdapter {
  meta: AdapterMeta = {
    id: "fake",
    displayName: "Faux site",
    compliance: { policy: "demo", termsUrl: "http://localhost/", reviewedAt: "2026-01-01" },
    capabilities: { officialApi: false, preciseServerTime: true, lightweightAvailability: true, reportsSeatAdjacency: true, seatSelection: "none" },
  };
  calls: string[] = [];
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
    this.calls.push("fetchSale");
    return { open: true, offers: this.offers };
  }
  async selectOffer(_c: AdapterContext, offer: Offer): Promise<void> {
    this.calls.push(`selectOffer:${offer.id}`);
    this.maybeFail("selectOffer");
  }
  async addToCart(): Promise<void> {
    this.calls.push("addToCart");
    this.maybeFail("addToCart");
  }
  async readCart(): Promise<CartSummary> {
    this.calls.push("readCart");
    return { itemCount: 2, totalPrice: 240, currency: "EUR", items: [{ label: "x", quantity: 2, unitPrice: 120 }] };
  }
  override async detectBlocker(): Promise<Blocker | null> {
    return this.blocker;
  }
}

export const offer = (o: Partial<Offer> & { id: string }): Offer => ({
  category: "A", pricePerTicket: 100, currency: "EUR", available: 2, seatsTogether: true, ...o,
});
