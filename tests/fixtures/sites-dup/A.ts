import { BaseSiteAdapter } from "../../../src/sites/BaseSiteAdapter.js";
import type { AdapterMeta, CartSummary, SaleSnapshot } from "../../../src/sites/SiteAdapter.js";

/** Adaptateur minimal : prouve qu'un fichier déposé dans un dossier de sites est découvert sans toucher au cœur. */
export default class DupA extends BaseSiteAdapter {
  readonly meta: AdapterMeta = {
    id: "good",
    displayName: "Bon site",
    compliance: { policy: "official-api", termsUrl: "https://api.example.com/terms", reviewedAt: "2026-09-01" },
    capabilities: { officialApi: true, preciseServerTime: false, lightweightAvailability: true, reportsSeatAdjacency: false, seatSelection: "none" },
  };
  protected async isLoggedIn(): Promise<boolean> {
    return true;
  }
  async fetchSale(): Promise<SaleSnapshot> {
    return { open: false, offers: [] };
  }
  async selectOffer(): Promise<void> {}
  async addToCart(): Promise<void> {}
  async readCart(): Promise<CartSummary> {
    return { itemCount: 0, totalPrice: 0, currency: "EUR", items: [] };
  }
}
