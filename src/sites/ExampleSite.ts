import type { BotConfig } from "../config/schema.js";
import { detectCommonBlocker } from "../selectors/blockers.js";
import { exampleSelectors as S } from "../selectors/example.js";
import { seatsAreContiguous } from "../agent/matcher.js";
import { NotLoggedInError, OfferUnavailableError, RateLimitedError } from "../utils/errors.js";
import type { AdapterContext, Blocker, CartSummary, Offer, SaleSnapshot, SiteAdapter } from "./SiteAdapter.js";

interface ApiOffer {
  id: string;
  category: string;
  price: number;
  currency: string;
  available: number;
  section?: string;
  row?: string;
  seats?: string[];
  url: string;
}

/**
 * Adaptateur de référence, écrit pour le site de démonstration local (demo/server.ts).
 * Copiez ce fichier pour un vrai site : seules les méthodes ci-dessous changent.
 *
 * Choix de latence illustrés ici :
 *  - fetchSale() utilise context.request (HTTP direct, cookies du navigateur partagés) : pas de rendu ;
 *  - selectOffer() navigue directement vers l'URL de l'offre (deep link), sans passer par la liste ;
 *  - aucune attente fixe : uniquement des waitFor sur des éléments/événements.
 */
export class ExampleSite implements SiteAdapter {
  readonly id = "example";
  readonly paymentUrlPatterns = [/\/payment(\/|\?|$)/];

  resolveEventUrl(config: BotConfig): string {
    return config.eventUrl ?? "http://127.0.0.1:4173/event";
  }

  private origin(ctx: AdapterContext): string {
    return new URL(this.resolveEventUrl(ctx.config)).origin;
  }

  async getServerTime(ctx: AdapterContext): Promise<number> {
    const res = await ctx.context.request.get(`${this.origin(ctx)}/api/time`);
    return ((await res.json()) as { now: number }).now;
  }

  async ensureLoggedIn(ctx: AdapterContext): Promise<void> {
    const { page, selectors, env } = ctx;
    await page.goto(`${this.origin(ctx)}/account`, { waitUntil: "domcontentloaded" });
    if (page.url().includes("/login")) {
      const email = env.EXAMPLE_EMAIL;
      const password = env.EXAMPLE_PASSWORD;
      if (!email || !password) throw new NotLoggedInError("Connectez-vous dans la fenêtre du navigateur.");
      await (await selectors.wait(page, S.loginEmail)).fill(email);
      await (await selectors.wait(page, S.loginPassword)).fill(password);
      await selectors.click(page, S.loginSubmit);
      await page.waitForURL(/\/account/);
    }
    await selectors.wait(page, S.accountName);
  }

  async prepare(ctx: AdapterContext): Promise<void> {
    await ctx.page.goto(this.resolveEventUrl(ctx.config), { waitUntil: "domcontentloaded" });
    // Ouvre la connexion HTTP/TLS de l'API : la première requête réelle n'a pas de handshake à payer.
    await ctx.context.request.get(`${this.origin(ctx)}/api/offers`).catch(() => undefined);
  }

  async fetchSale(ctx: AdapterContext): Promise<SaleSnapshot> {
    const res = await ctx.context.request.get(`${this.origin(ctx)}/api/offers`);
    if (res.status() === 429) {
      throw new RateLimitedError(Number(res.headers()["retry-after"] ?? 2) * 1000);
    }
    if (!res.ok()) throw new Error(`API offres : HTTP ${res.status()}`);
    const body = (await res.json()) as { open: boolean; offers: ApiOffer[] };
    const qty = ctx.config.quantity;
    const offers: Offer[] = body.offers.map((o) => ({
      id: o.id,
      category: o.category,
      pricePerTicket: o.price,
      currency: o.currency,
      available: o.available,
      seatsTogether: seatsAreContiguous(o.seats, qty),
      section: o.section,
      row: o.row,
      seats: o.seats,
      url: new URL(o.url, this.origin(ctx)).toString(),
    }));
    return { open: body.open, offers };
  }

  async selectOffer(ctx: AdapterContext, offer: Offer, quantity: number): Promise<void> {
    if (!offer.url) throw new Error("Offre sans URL");
    await ctx.page.goto(offer.url, { waitUntil: "domcontentloaded" });
    const select = await ctx.selectors.wait(ctx.page, S.quantity);
    try {
      await select.selectOption(String(quantity));
    } catch {
      throw new OfferUnavailableError(`Quantité ${quantity} non proposée pour ${offer.id}`);
    }
  }

  async addToCart(ctx: AdapterContext): Promise<void> {
    const { page, selectors } = ctx;
    await selectors.click(page, S.addToCart);
    // Course entre « article dans le panier » et « erreur » : le premier événement gagne, sans sleep.
    const ok = selectors.locator(page, S.cartItem).waitFor({ state: "visible" }).then(() => "ok" as const);
    const err = selectors.locator(page, S.addError).waitFor({ state: "visible" }).then(() => "error" as const);
    const outcome = await Promise.any([ok, err]).catch(() => "timeout" as const);
    if (outcome === "error") throw new OfferUnavailableError("Ces billets ne sont plus disponibles");
    if (outcome === "timeout") throw new Error("Ni confirmation ni erreur après l'ajout au panier");
  }

  async readCart(ctx: AdapterContext): Promise<CartSummary> {
    const { page, selectors } = ctx;
    if (!page.url().includes("/cart")) await page.goto(`${this.origin(ctx)}/cart`, { waitUntil: "domcontentloaded" });
    await selectors.wait(page, S.cartItem);
    const data = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('[data-testid="cart-item"]')).map((e) => ({
        label: (e.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 120),
        quantity: Number((e as HTMLElement).dataset.quantity),
        unitPrice: Number((e as HTMLElement).dataset.unitPrice),
      }));
      const root = document.querySelector('[data-testid="cart"]') as HTMLElement | null;
      return { items, total: Number(root?.dataset.total ?? 0), expiresAt: Number(root?.dataset.expiresAt ?? 0) };
    });
    return {
      itemCount: data.items.reduce((n, i) => n + i.quantity, 0),
      totalPrice: data.total,
      currency: "EUR",
      items: data.items,
      expiresAt: data.expiresAt || undefined,
    };
  }

  detectBlocker(ctx: AdapterContext): Promise<Blocker | null> {
    return detectCommonBlocker(ctx.page);
  }
}
