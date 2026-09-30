import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiContext } from "../src/api/BaseApiAdapter.js";
import { verifyCart } from "../src/agent/matcher.js";
import type { BotConfig } from "../src/config/schema.js";
import { checkAdapterContract } from "../src/sites/contract.js";
import type { SiteAdapter } from "../src/sites/SiteAdapter.js";
import { BlockerError, OfferUnavailableError, RateLimitedError } from "../src/utils/errors.js";
import { silentLogger } from "../src/utils/logger.js";

/**
 * SUITE DE CONFORMITÉ d'un adaptateur API OFFICIELLE (docs/FIXTURES.md). TEST_ONLY · NOT_A_REAL_PLATFORM.
 * L'auteur fournit, par scénario, un faux `fetch` bâti sur des réponses ENREGISTRÉES de l'API officielle documentée (jamais une
 * requête réelle) ; la suite vérifie le contrat : offres normalisées, état de la file, limite d'achat, vente d'une offre,
 * limite de débit, panier relu fidèlement, hôtes (allowedHosts), aucun chemin de paiement.
 */
export type ApiScenario = "nominal" | "sold-out" | "queue" | "purchase-limit" | "contention" | "cart-mismatch" | "rate-limited";

export interface ApiFixtureHandle {
  fetchImpl: typeof fetch;
  calls: { method: string; host: string; path: string }[];
}

export interface ApiSuiteOptions {
  label: string;
  makeAdapter: (fetchImpl: typeof fetch) => SiteAdapter;
  configFor: () => BotConfig;
  /** Faux `fetch` de chaque scénario. */
  fixtures: Record<ApiScenario, () => ApiFixtureHandle>;
  /** Variables d'environnement du secret de test (FICTIVES). */
  env?: NodeJS.ProcessEnv;
}

export function defineApiAdapterSuite(o: ApiSuiteOptions): void {
  const t = (name: string, fn: () => Promise<void> | void): void => void test(`[${o.label}] ${name}`, fn);
  const setup = (scenario: ApiScenario) => {
    const fx = o.fixtures[scenario]();
    const adapter = o.makeAdapter(fx.fetchImpl);
    const config = o.configFor();
    const ctx = createApiContext(config, silentLogger, o.env ?? {});
    const done = (): void => {
      const hosts = adapter.allowedHosts(config);
      assert.ok(fx.calls.every((c) => hosts.includes(c.host)), `requête hors allowedHosts : ${fx.calls.map((c) => c.host).join(", ")}`);
      assert.ok(!fx.calls.some((c) => /\b(pay|payment|payments|paiement|checkout|billing|charge|cards?|wallet)\b/i.test(c.path)), "chemin de paiement appelé");
    };
    return { fx, adapter, config, ctx, done };
  };

  t("contrat : sept capacités, déclarations, canal API, hôtes déclarés", () => {
    const { adapter, config } = setup("nominal");
    const errors = checkAdapterContract(adapter).filter((i) => i.severity === "error");
    assert.deepEqual(errors, [], errors.map((e) => `${e.code}: ${e.message}`).join(" | "));
    assert.equal(adapter.channel, "official-api");
    assert.ok(adapter.allowedHosts(config).length > 0, "un adaptateur API déclare les hôtes de son client HTTP");
  });

  t("nominal : offres normalisées, sélection, réservation, panier relu, arrêt avant paiement, aucune requête hors allowedHosts", async () => {
    const { adapter, config, ctx, fx, done } = setup("nominal");
    await adapter.ensureLoggedIn(ctx);
    assert.equal((await adapter.getAvailability(ctx)).open, true);
    const offers = await adapter.getOffers(ctx);
    assert.ok(offers.length > 0);
    for (const x of offers) {
      assert.equal(typeof x.id, "string");
      assert.ok(Number.isFinite(x.pricePerTicket) && x.pricePerTicket >= 0, "prix");
      assert.ok(x.category.length > 0, "catégorie");
      assert.ok(Number.isInteger(x.available) && x.available >= 0, "quantité");
      assert.ok([true, false, "unknown"].includes(x.seatsTogether as never), "adjacence");
    }
    const best = offers.filter((x) => x.available >= config.tickets.quantity && x.pricePerTicket <= config.tickets.maxPricePerTicket)[0]!;
    await adapter.selectOffer(ctx, best, config.tickets.quantity);
    await adapter.addToCart(ctx);
    const cart = await adapter.getCartState(ctx);
    assert.ok(verifyCart(cart, config.tickets).ok);
    assert.ok(fx.calls.length > 0);
    done();
  });

  t("sold-out : vente ouverte, rien d'achetable → soldOut", async () => {
    const { adapter, ctx, done } = setup("sold-out");
    const a = await adapter.getAvailability(ctx);
    assert.equal(a.open, true);
    assert.equal(a.soldOut, true);
    done();
  });

  t("queue : file d'attente officielle « waiting » → QUEUE détecté, aucune réservation tentée", async () => {
    const { adapter, ctx, fx, done } = setup("queue");
    assert.equal((await adapter.detectBlocker(ctx))?.state, "QUEUE");
    const state = await adapter.pollState?.(ctx);
    if (state) assert.equal(state.blocker?.state, "QUEUE");
    assert.ok(!fx.calls.some((c) => c.method === "POST"), "aucune écriture pendant la file");
    done();
  });

  t("purchase-limit : limite d'achat renvoyée par l'API → BlockerError PURCHASE_LIMIT, pas de nouvelle tentative", async () => {
    const { adapter, config, ctx, fx, done } = setup("purchase-limit");
    const offers = await adapter.getOffers(ctx);
    await adapter.selectOffer(ctx, offers.filter((x) => x.available >= config.tickets.quantity)[0]!, config.tickets.quantity);
    const err = await adapter.addToCart(ctx).then(() => undefined, (e: unknown) => e);
    assert.ok(err instanceof BlockerError && err.blocker.state === "PURCHASE_LIMIT", String(err));
    assert.equal(fx.calls.filter((c) => c.method === "POST" && /reserv/i.test(c.path)).length, 1, "une seule tentative");
    done();
  });

  t("contention : offre vendue entre-temps → OfferUnavailableError", async () => {
    const { adapter, config, ctx, done } = setup("contention");
    const offers = await adapter.getOffers(ctx);
    const err = await adapter.selectOffer(ctx, offers.filter((x) => x.available >= config.tickets.quantity)[0]!, config.tickets.quantity).then(() => undefined, (e: unknown) => e);
    assert.ok(err instanceof OfferUnavailableError, String(err));
    done();
  });

  t("cart-mismatch : la réservation relue compte moins de billets → relatée fidèlement, refusée par le cœur", async () => {
    const { adapter, config, ctx, done } = setup("cart-mismatch");
    const offers = await adapter.getOffers(ctx);
    await adapter.selectOffer(ctx, offers.filter((x) => x.available >= config.tickets.quantity)[0]!, config.tickets.quantity);
    await adapter.addToCart(ctx);
    const cart = await adapter.getCartState(ctx);
    assert.ok(cart.itemCount < config.tickets.quantity);
    assert.equal(verifyCart(cart, config.tickets).ok, false);
    done();
  });

  t("rate-limited : 429 → RateLimitedError avec l'attente demandée ; aucun contournement ni nouvelle requête immédiate", async () => {
    const { adapter, ctx, fx, done } = setup("rate-limited");
    const err = await adapter.getOffers(ctx).then(() => undefined, (e: unknown) => e);
    assert.ok(err instanceof RateLimitedError, String(err));
    assert.ok((err as RateLimitedError).retryAfterMs >= 200);
    const n = fx.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fx.calls.length, n, "aucune requête de plus de la part de l'adaptateur");
    done();
  });
}
