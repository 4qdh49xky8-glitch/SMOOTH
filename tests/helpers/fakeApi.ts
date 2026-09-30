import { ApiClient } from "../../src/api/ApiClient.js";
import { BaseApiAdapter } from "../../src/api/BaseApiAdapter.js";
import type { AdapterContext, AdapterMeta, CartSummary, Offer, SaleSnapshot } from "../../src/sites/SiteAdapter.js";
import { TODAY } from "./platformFixtures.js";

/** Faux serveur d'API OFFICIELLE FICTIVE, en mémoire : aucune requête réseau réelle n'est jamais émise. */
export interface FakeApiState {
  calls: { method: string; path: string; auth?: string }[];
  /** Lectures de /queue qui répondent « waiting » avant l'admission. */
  queueWaits: number;
  holdStatus: (n: number, offerId: string) => number;
  reserveResponse?: { status: number; body?: unknown };
  offers: { id: string; category: string; price: number; available: number; adjacent?: boolean }[];
  rateLimitOnce?: boolean;
  reservedQuantity?: number;
  quantity: number;
}

export function fakeApi(over: Partial<FakeApiState> = {}): { state: FakeApiState; fetchImpl: typeof fetch } {
  const state: FakeApiState = {
    calls: [], queueWaits: 0, holdStatus: () => 200, quantity: 2,
    offers: [{ id: "o1", category: "A", price: 90, available: 2, adjacent: true }], ...over,
  };
  let holds = 0;
  const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    state.calls.push({ method, path: url.pathname, auth });
    if (url.pathname.endsWith("/me")) return json(200, { ok: true });
    if (url.pathname.endsWith("/queue")) return json(200, { status: state.queueWaits-- > 0 ? "waiting" : "none" });
    if (url.pathname.endsWith("/offers")) {
      if (state.rateLimitOnce) {
        state.rateLimitOnce = false;
        return json(429, { code: "rate_limited" }, { "retry-after": "1" });
      }
      return json(200, { open: true, offers: state.offers });
    }
    if (url.pathname.endsWith("/holds")) {
      const offerId = JSON.parse(String(init?.body)).offerId as string;
      return json(state.holdStatus(++holds, offerId), { code: "hold" });
    }
    if (url.pathname.endsWith("/reservations") && method === "POST") {
      const r = state.reserveResponse ?? { status: 201, body: {} };
      state.reservedQuantity = JSON.parse(String(init?.body)).quantity as number;
      return json(r.status, r.body ?? {});
    }
    if (url.pathname.endsWith("/reservations/current")) {
      const q = state.reservedQuantity ?? state.quantity;
      return json(200, { quantity: q, unitPrice: state.offers[0]!.price, currency: "EUR" });
    }
    return json(404, { code: "not_found" });
  }) as typeof fetch;
  return { state, fetchImpl };
}

/** Adaptateur API de TEST : n'appelle que le faux serveur ci-dessus. Aucune méthode de paiement n'existe. */
export class FakeApiAdapter extends BaseApiAdapter {
  meta: AdapterMeta = {
    id: "api-test", displayName: "API de test (fictive)", platform: "p", channel: "official-api", requires: { env: ["P_API_KEY"] },
    compliance: { policy: "official-api", termsUrl: "https://www.p.example/api-terms", reviewedAt: TODAY },
    capabilities: { officialApi: true, preciseServerTime: false, lightweightAvailability: true, reportsSeatAdjacency: true, seatSelection: "none" },
  };
  readonly client: ApiClient;
  private selected?: Offer;
  constructor(fetchImpl: typeof fetch, env: NodeJS.ProcessEnv = { P_API_KEY: "SECRET-CANARY-1234567890abcdef" }, minIntervalMs = 200) {
    super();
    this.client = new ApiClient({ allowedHosts: ["api.p.example"], baseUrl: "https://api.p.example/v1", auth: { envVar: "P_API_KEY" }, fetchImpl, env, minIntervalMs });
  }
  async authenticate(): Promise<void> {
    await this.client.request("GET", "/me");
  }
  async listOffers(): Promise<SaleSnapshot> {
    const r = await this.client.request<{ open: boolean; offers: { id: string; category: string; price: number; available: number; adjacent?: boolean }[] }>("GET", "/events/1/offers");
    return { open: r.body!.open, offers: r.body!.offers.map((o) => ({ id: o.id, category: o.category, pricePerTicket: o.price, currency: "EUR", available: o.available, seatsTogether: o.adjacent ?? "unknown" })) };
  }
  async holdOffer(_ctx: AdapterContext, offer: Offer, quantity: number): Promise<void> {
    await this.client.request("POST", "/holds", { body: { offerId: offer.id, quantity } });
    this.selected = offer;
  }
  async reserve(ctx: AdapterContext): Promise<void> {
    await this.client.request("POST", "/reservations", { body: { offerId: this.selected!.id, quantity: ctx.config.tickets.quantity } });
  }
  async readReservation(): Promise<CartSummary> {
    const r = await this.client.request<{ quantity: number; unitPrice: number; currency: string }>("GET", "/reservations/current");
    return { itemCount: r.body!.quantity, totalPrice: r.body!.quantity * r.body!.unitPrice, currency: r.body!.currency, items: [{ label: "réservation", quantity: r.body!.quantity, unitPrice: r.body!.unitPrice }] };
  }
  async queueStatus(): Promise<"none" | "waiting" | "admitted"> {
    const r = await this.client.request<{ status: "none" | "waiting" | "admitted" }>("GET", "/queue");
    return r.body!.status;
  }
}
