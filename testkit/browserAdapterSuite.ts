import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { verifyCart } from "../src/agent/matcher.js";
import { installNetworkGuards } from "../src/browser/guards.js";
import type { BotConfig } from "../src/config/schema.js";
import { SelectorResolver } from "../src/selectors/resolver.js";
import { checkAdapterContract } from "../src/sites/contract.js";
import type { AdapterContext, Offer, SiteAdapter } from "../src/sites/SiteAdapter.js";
import { BlockerError, NotLoggedInError, OfferUnavailableError } from "../src/utils/errors.js";
import { silentLogger } from "../src/utils/logger.js";
import { startFixtureSite, DEFAULT_CREDENTIALS, type FixtureSite } from "./fixtureSite.js";
import { CANONICAL_OFFERS, EXPECTED_ADJACENT, type FixtureScenario } from "./scenarios.js";

/**
 * SUITE DE CONFORMITÉ d'un adaptateur NAVIGATEUR contre les fixtures locales (docs/FIXTURES.md). TEST_ONLY · NOT_A_REAL_PLATFORM.
 *
 *   defineBrowserAdapterSuite({ label, makeAdapter, configFor })                      ← balisage du faux site par défaut
 *   defineBrowserAdapterSuite({ …, serve: (scenario) => startFixtureSite({ scenario, skin: maPlateforme }) })   ← balisage enregistré
 *
 * Elle enregistre un test par scénario (nominal, not-open, sold-out, queue, captcha, blocked, login-required, purchase-limit,
 * contention, cart-mismatch) et vérifie le CONTRAT : offres normalisées (prix, catégorie, quantité, adjacence), états détectés sans
 * jamais être contournés, aucune action pendant une file/un CAPTCHA, aucune connexion automatique, arrêt à la limite d'achat,
 * panier relaté fidèlement, JAMAIS de requête de paiement, garde réseau (paiement + hôtes) installé comme en production.
 * Nécessite Chromium (CHROMIUM_PATH) ; sinon les tests sont ignorés avec la raison.
 */
export interface BrowserSuiteOptions {
  label: string;
  makeAdapter: () => SiteAdapter;
  /** Configuration d'événement pour l'URL du faux site (quantité 2, budget 150 € attendus par les assertions). */
  configFor: (siteUrl: string) => BotConfig;
  /** Démarre le faux site d'un scénario (défaut : balisage par défaut du kit). */
  serve?: (scenario: FixtureScenario) => Promise<FixtureSite>;
  /** Connexion du compte de test (équivalent de `npm run login`). Défaut : formulaire du faux site. */
  login?: (page: Page, siteUrl: string) => Promise<void>;
}

export function defineBrowserAdapterSuite(o: BrowserSuiteOptions): void {
  let browser: Browser | undefined;
  let skipReason: string | undefined;
  const dir = mkdtempSync(join(tmpdir(), "adapter-suite-"));
  const serve = o.serve ?? ((scenario: FixtureScenario) => startFixtureSite({ scenario }));
  const login =
    o.login ??
    (async (page: Page, url: string): Promise<void> => {
      await page.goto(`${url}/login`);
      await page.fill('[data-testid="login-email"]', DEFAULT_CREDENTIALS.email);
      await page.fill('[data-testid="login-password"]', DEFAULT_CREDENTIALS.password);
      await page.click('[data-testid="login-submit"]');
      await page.waitForURL(/\/account/);
    });

  before(async () => {
    try {
      browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] });
    } catch (e) {
      skipReason = `Chromium indisponible (${(e as Error).message.split("\n")[0]}) — définissez CHROMIUM_PATH`;
    }
  });
  after(async () => {
    await browser?.close().catch(() => undefined);
  });

  /** Un scénario = un faux site + un contexte de navigateur neuf + le garde réseau de production. */
  async function withScenario(scenario: FixtureScenario, fn: (t: { site: FixtureSite; adapter: SiteAdapter; ctx: AdapterContext; page: Page; config: BotConfig }) => Promise<void>, loggedIn = true): Promise<void> {
    const site = await serve(scenario);
    const context = await browser!.newContext();
    try {
      const adapter = o.makeAdapter();
      const config = o.configFor(site.url);
      const page = await context.newPage();
      // Comme en production : paiement bloqué, navigations limitées aux hôtes déclarés par l'adaptateur.
      await installNetworkGuards(context, { paymentPatterns: adapter.paymentUrlPatterns, allowedHosts: adapter.allowedHosts(config), log: silentLogger });
      if (loggedIn) await login(page, site.url);
      const ctx: AdapterContext = { config, context, page, log: silentLogger, env: {}, selectors: new SelectorResolver(adapter.meta.id, join(dir, `${adapter.meta.id}-${scenario}.json`)) };
      await fn({ site, adapter, ctx, page, config });
      assert.equal(site.state.paymentHits, 0, "AUCUNE requête de paiement ne doit jamais partir");
      assert.ok(!site.state.requests.some((r) => /\/(payment|paiement|pay)\b/.test(r)), `requête de paiement : ${site.state.requests.join(", ")}`);
    } finally {
      await context.close().catch(() => undefined);
      await site.close();
    }
  }
  const t = (name: string, fn: () => Promise<void>): void => void test(`[${o.label}] ${name}`, async (ctx) => (skipReason ? ctx.skip(skipReason) : fn()));
  const cheapestOk = (offers: Offer[], quantity: number): Offer => offers.filter((x) => x.available >= quantity && x.pricePerTicket <= 150).sort((a, b) => b.pricePerTicket - a.pricePerTicket)[0]!;

  test(`[${o.label}] contrat : sept capacités, déclarations (authorization, channel, capabilities, allowedHosts), fixture locale uniquement`, () => {
    const adapter = o.makeAdapter();
    const errors = checkAdapterContract(adapter).filter((i) => i.severity === "error");
    assert.deepEqual(errors, [], errors.map((e) => `${e.code}: ${e.message}`).join(" | "));
    for (const c of ["getEvent", "getAvailability", "getOffers", "matchOffer", "selectOffer", "addToCart", "getCartState"] as const) assert.equal(typeof adapter[c], "function", c);
    const hosts = adapter.allowedHosts(o.configFor("http://127.0.0.1:1"));
    assert.ok(hosts.length > 0 && hosts.every((h) => ["127.0.0.1", "localhost"].includes(h)), `hôtes hors fixture locale : ${hosts.join(", ")}`);
  });

  t("nominal : offres normalisées (prix, catégorie, quantité, sièges adjacents), sélection, panier relu, arrêt avant paiement", async () => {
    await withScenario("nominal", async ({ adapter, ctx, site, config }) => {
      await adapter.prepare(ctx);
      assert.equal(await adapter.detectBlocker(ctx), null, "aucun blocage sur une page normale");
      const ev = await adapter.getEvent(ctx);
      assert.equal(new URL(ev.url).hostname, "127.0.0.1");
      const a = await adapter.getAvailability(ctx);
      assert.deepEqual(a, { open: true, soldOut: false });
      const offers = await adapter.getOffers(ctx);
      assert.equal(offers.length, CANONICAL_OFFERS.length, "toutes les offres sont détectées");
      for (const c of CANONICAL_OFFERS) {
        const got = offers.find((x) => x.id === c.id);
        assert.ok(got, `offre ${c.id} absente`);
        assert.equal(got.pricePerTicket, c.price, `${c.id} : prix`);
        assert.equal(got.category, c.category, `${c.id} : catégorie`);
        assert.equal(got.available, c.available, `${c.id} : quantité`);
        assert.equal(got.currency, "EUR");
        if (adapter.capabilities.reportsSeatAdjacency) assert.equal(got.seatsTogether, EXPECTED_ADJACENT[c.id], `${c.id} : sièges adjacents (quantité 2)`);
        else assert.equal(got.seatsTogether, "unknown", `${c.id} : adjacence non renseignée → "unknown", jamais inventée`);
      }
      assert.ok(offers.every((x) => adapter.matchOffer(x, config.tickets) === true), "matchOffer n'exclut rien sans raison propre à la plateforme");
      const best = cheapestOk(offers, config.tickets.quantity);
      await adapter.selectOffer(ctx, best, config.tickets.quantity);
      await adapter.addToCart(ctx);
      const cart = await adapter.getCartState(ctx);
      assert.equal(cart.itemCount, config.tickets.quantity);
      assert.ok(verifyCart(cart, config.tickets).ok, "le panier relu satisfait quantité et budget");
      assert.equal(cart.items[0]!.unitPrice, best.pricePerTicket);
      assert.equal(site.state.cart.length, 1);
    });
  });

  t("not-open : vente pas encore ouverte → open:false, aucune offre", async () => {
    await withScenario("not-open", async ({ adapter, ctx }) => {
      await adapter.prepare(ctx);
      const a = await adapter.getAvailability(ctx);
      assert.equal(a.open, false);
      assert.deepEqual(await adapter.getOffers(ctx), []);
    });
  });

  t("sold-out : vente ouverte mais complète → SOLD_OUT (aucune offre achetable, pas d'insistance)", async () => {
    await withScenario("sold-out", async ({ adapter, ctx }) => {
      await adapter.prepare(ctx);
      const a = await adapter.getAvailability(ctx);
      assert.equal(a.open, true);
      assert.equal(a.soldOut, true);
      assert.equal((await adapter.getOffers(ctx)).filter((x) => x.available > 0).length, 0);
    });
  });

  for (const [scenario, state] of [["queue", "QUEUE"], ["captcha", "CAPTCHA"], ["blocked", "BLOCKED"]] as const) {
    t(`${scenario} : ${state} détecté, AUCUNE action sur le site (ni sélection, ni panier), jamais contourné`, async () => {
      await withScenario(scenario, async ({ adapter, ctx, site }) => {
        await adapter.prepare(ctx).catch(() => undefined);
        const b = await adapter.detectBlocker(ctx);
        assert.equal(b?.state, state, `attendu ${state}, reçu ${JSON.stringify(b)}`);
        assert.ok(!site.state.requests.some((r) => r.includes("/cart/add")), "aucune action d'achat pendant un blocage");
        assert.equal(site.state.addAttempts, 0);
        assert.equal(site.state.cart.length, 0);
      });
    });
  }

  t("login-required : non connecté → NotLoggedInError, aucune connexion automatique, aucune saisie d'identifiants", async () => {
    await withScenario("login-required", async ({ adapter, ctx, site }) => {
      await adapter.prepare(ctx).catch(() => undefined);
      await assert.rejects(adapter.ensureLoggedIn(ctx), NotLoggedInError);
      assert.ok(!site.state.requests.some((r) => r.startsWith("POST /login")), "le bot ne se connecte jamais tout seul");
      assert.equal(site.state.loggedIn.size, 0);
    }, false);
  });

  t("purchase-limit : limite d'achat atteinte → arrêt (PURCHASE_LIMIT), panier vide, jamais contournée (pas de nouvelle tentative, pas de quantité réduite)", async () => {
    await withScenario("purchase-limit", async ({ adapter, ctx, site, config }) => {
      await adapter.prepare(ctx);
      const offers = await adapter.getOffers(ctx);
      const best = cheapestOk(offers, config.tickets.quantity);
      await adapter.selectOffer(ctx, best, config.tickets.quantity);
      let state: string | undefined;
      try {
        await adapter.addToCart(ctx);
      } catch (e) {
        if (e instanceof BlockerError) state = e.blocker.state;
        else throw e;
      }
      state ??= (await adapter.detectBlocker(ctx))?.state;
      assert.equal(state, "PURCHASE_LIMIT");
      assert.equal(site.state.addAttempts, 1, "une seule tentative : la limite n'est pas contournée");
      assert.equal(site.state.cart.length, 0);
    });
  });

  t("contention : offre vendue entre-temps → OfferUnavailableError (le cœur passe à l'offre suivante), aucun paiement", async () => {
    await withScenario("contention", async ({ adapter, ctx, config }) => {
      await adapter.prepare(ctx);
      const offers = await adapter.getOffers(ctx);
      await adapter.selectOffer(ctx, cheapestOk(offers, config.tickets.quantity), config.tickets.quantity);
      await assert.rejects(adapter.addToCart(ctx), OfferUnavailableError);
    });
  });

  t("cart-mismatch : le site ajoute moins de billets → le panier est relaté FIDÈLEMENT (le cœur refuse alors de le déclarer réussi)", async () => {
    await withScenario("cart-mismatch", async ({ adapter, ctx, config }) => {
      await adapter.prepare(ctx);
      const offers = await adapter.getOffers(ctx);
      await adapter.selectOffer(ctx, cheapestOk(offers, config.tickets.quantity), config.tickets.quantity);
      await adapter.addToCart(ctx);
      const cart = await adapter.getCartState(ctx);
      assert.equal(cart.itemCount, config.tickets.quantity - 1, "l'adaptateur rapporte ce que le site contient réellement");
      assert.equal(verifyCart(cart, config.tickets).ok, false);
    });
  });

  t("garde réseau : une navigation vers un hôte hors allowedHosts est annulée pour cet adaptateur, comme en production", async () => {
    await withScenario("nominal", async ({ adapter, ctx, site }) => {
      const port = new URL(site.url).port;
      const other = await ctx.context.newPage();
      await assert.rejects(other.goto(`http://localhost:${port}/event`), /ERR_FAILED|aborted|net::/);
      assert.ok(adapter.allowedHosts(ctx.config).includes("127.0.0.1"));
    });
  });
}
