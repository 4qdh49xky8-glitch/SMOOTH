import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent } from "../src/agent/Agent.js";
import { ClaudeAssistant } from "../src/agent/claude.js";
import { ADAPTER_STATES, CORE_ONLY_STATES, State } from "../src/agent/states.js";
import { BaseApiAdapter } from "../src/api/BaseApiAdapter.js";
import { ApiClient } from "../src/api/ApiClient.js";
import { ConfigSchema } from "../src/config/schema.js";
import { authorizationOf } from "../src/platforms/authorize.js";
import { AUTHORIZATION_MODEL, STATUSES, findPlatform, loadCatalog } from "../src/platforms/catalog.js";
import { SelectorResolver } from "../src/selectors/resolver.js";
import { BaseSiteAdapter } from "../src/sites/BaseSiteAdapter.js";
import ExampleSite from "../src/sites/ExampleSite.js";
import { checkAdapterContract } from "../src/sites/contract.js";
import { discoverAdapterEntries } from "../src/sites/registry.js";
import type { AdapterContext, AdapterMeta, CartSummary, Offer, SaleSnapshot } from "../src/sites/SiteAdapter.js";
import { Clock } from "../src/utils/clock.js";
import { silentLogger } from "../src/utils/logger.js";
import { sitesCommand } from "../src/cli/sites.js";
import { FakeApiAdapter, fakeApi } from "./helpers/fakeApi.js";
import { FakeAdapter, offer } from "./helpers/fakeAdapter.js";
import { NOW, adapter, catalogWith, daysAgo, ev, plat } from "./helpers/platformFixtures.js";

const CAPS = ["getEvent", "getAvailability", "getOffers", "matchOffer", "selectOffer", "addToCart", "getCartState"] as const;
const meta = (over: Partial<AdapterMeta> = {}): AdapterMeta => ({
  id: "x-web", displayName: "X", platform: "p", channel: "browser",
  compliance: { policy: "permitted-by-terms", termsUrl: "https://www.p.example/cgu", reviewedAt: daysAgo(2) },
  capabilities: { officialApi: false, preciseServerTime: false, lightweightAvailability: true, reportsSeatAdjacency: true, seatSelection: "none" }, ...over,
});
const config = ConfigSchema.parse({ site: "p", event: { name: "Concert", url: "https://www.p.example/e/1" }, sale: { startTime: "2030-01-01T00:00:00Z" }, tickets: { quantity: 2, maxPricePerTicket: 150 } });
const ctx = { config, context: {} as never, page: {} as never, log: silentLogger, env: {}, selectors: new SelectorResolver("x", "/nonexistent/x.json") } as AdapterContext;
const snap = (offers: Offer[] = [offer({ id: "a" })], open = true): SaleSnapshot => ({ open, offers });
const cart: CartSummary = { itemCount: 2, totalPrice: 200, currency: "EUR", items: [] };

/** Adaptateur écrit avec les NOUVEAUX noms (getAvailability + getOffers + getCartState). */
class NewStyle extends BaseSiteAdapter {
  meta = meta();
  protected async isLoggedIn(): Promise<boolean> { return true; }
  override async getAvailability() { return { open: true, soldOut: false }; }
  override async getOffers() { return [offer({ id: "n1" })]; }
  async selectOffer(): Promise<void> {}
  async addToCart(): Promise<void> {}
  override async getCartState() { return cart; }
}
/** Adaptateur écrit avec les ANCIENS noms (fetchSale + readCart). */
class OldStyle extends BaseSiteAdapter {
  meta = meta();
  protected async isLoggedIn(): Promise<boolean> { return true; }
  override async fetchSale() { return snap([offer({ id: "o1" }), offer({ id: "o2", available: 0 })]); }
  async selectOffer(): Promise<void> {}
  async addToCart(): Promise<void> {}
  override async readCart() { return cart; }
}
class Nothing extends BaseSiteAdapter {
  meta = meta();
  protected async isLoggedIn(): Promise<boolean> { return true; }
  async selectOffer(): Promise<void> {}
  async addToCart(): Promise<void> {}
}

test("contrat : les sept capacités existent sur toutes les classes de base (navigateur et API) et sur l'adaptateur de test", () => {
  const api = new FakeApiAdapter(fakeApi().fetchImpl);
  for (const a of [new NewStyle(), new OldStyle(), new ExampleSite(), new FakeAdapter(), api]) for (const c of CAPS) assert.equal(typeof a[c], "function", `${a.meta.id}.${c}`);
});

test("lecture : fetchSale dérivé de getAvailability + getOffers, et l'inverse ; panier : getCartState ↔ readCart ; rien d'implémenté → erreur explicite", async () => {
  const n = new NewStyle();
  assert.deepEqual((await n.fetchSale(ctx)).offers.map((o) => o.id), ["n1"]);
  assert.equal((await n.fetchSale(ctx)).open, true);
  assert.equal((await n.readCart(ctx)).itemCount, 2);
  const o = new OldStyle();
  assert.equal((await o.getAvailability(ctx)).open, true);
  assert.deepEqual((await o.getOffers(ctx)).map((x) => x.id), ["o1", "o2"]);
  assert.equal((await o.getCartState(ctx)).totalPrice, 200);
  assert.equal((await new OldStyle().getAvailability(ctx)).soldOut, false);
  class Sold extends OldStyle { override async fetchSale() { return snap([offer({ id: "z", available: 0 })]); } }
  assert.equal((await new Sold().getAvailability(ctx)).soldOut, true, "ouverte mais plus rien d'achetable → soldOut");
  const none = new Nothing();
  await assert.rejects(none.fetchSale(ctx), /implémentez fetchSale\(\) ou getAvailability\(\) \+ getOffers\(\)/);
  await assert.rejects(none.getAvailability(ctx), /implémentez/);
  await assert.rejects(none.getCartState(ctx), /implémentez getCartState\(\) ou readCart\(\)/);
  await assert.rejects(none.readCart(ctx), /implémentez/);
  const codes = (a: Nothing) => checkAdapterContract(a).filter((i) => i.severity === "error").map((i) => i.code);
  assert.ok(codes(none).includes("CAPABILITY_UNIMPLEMENTED"), "le contrat signale l'adaptateur incomplet");
  assert.ok(!checkAdapterContract(n, {}).some((i) => i.code === "CAPABILITY_UNIMPLEMENTED"));
  assert.ok(!checkAdapterContract(o, {}).some((i) => i.code === "CAPABILITY_UNIMPLEMENTED"));
});

test("déclarations explicites : authorization (statuts exigés = modèle figé), channel, capabilities, allowedHosts", () => {
  const web = new NewStyle();
  assert.deepEqual(web.authorization, { platform: "p", channel: "browser", policy: "permitted-by-terms", evidenceRequired: true, requiresStatus: ["BROWSER_ONLY", "API_AND_BROWSER"] });
  const apiAd = new FakeApiAdapter(fakeApi().fetchImpl);
  assert.deepEqual(apiAd.authorization.requiresStatus, ["API_ONLY", "API_AND_BROWSER"]);
  assert.equal(apiAd.channel, "official-api");
  assert.equal(web.channel, "browser");
  assert.equal(web.capabilities, web.meta.capabilities);
  // la déclaration se déduit STRICTEMENT du modèle figé
  for (const a of [web, apiAd]) for (const s of STATUSES) assert.equal(a.authorization.requiresStatus.includes(s), a.channel === "official-api" ? AUTHORIZATION_MODEL[s].api : AUTHORIZATION_MODEL[s].browser, `${a.channel}/${s}`);
  // fixture de test : aucune preuve exigée, aucun statut
  assert.deepEqual(authorizationOf(new ExampleSite().meta), { platform: "example", channel: "browser", policy: "demo", evidenceRequired: false, requiresStatus: [] });
  assert.deepEqual(web.allowedHosts(config), ["www.p.example"], "navigateur : l'hôte de la page d'événement");
  assert.deepEqual(apiAd.allowedHosts(config), ["api.p.example"], "API : les hôtes du client HTTP encadré");
});

test("contrat : déclarations incohérentes, hôtes invalides, client API absent ou hors domaines officiels", () => {
  const cat = catalogWith([plat("p")], [ev("p", "both")]);
  const codes = (a: unknown, catalog?: typeof cat) => checkAdapterContract(a as BaseSiteAdapter, { now: NOW, catalog }).map((i) => `${i.severity}:${i.code}`);
  const lying = Object.create(new NewStyle(), { authorization: { value: { platform: "p", channel: "browser", policy: "permitted-by-terms", evidenceRequired: true, requiresStatus: ["BROWSER_ONLY", "API_AND_BROWSER", "HUMAN_ONLY"] } } });
  assert.ok(codes(lying).includes("error:AUTHORIZATION_DECL"), "une déclaration qui exigerait HUMAN_ONLY contredit le modèle figé");
  assert.ok(codes(Object.create(new NewStyle(), { channel: { value: "official-api" } })).includes("error:CHANNEL_DECL"));
  assert.ok(codes(Object.create(new NewStyle(), { allowedHosts: { value: () => ["https://x.example/chemin"] } })).includes("error:ALLOWED_HOSTS"));
  assert.ok(codes(Object.create(new NewStyle(), { allowedHosts: { value: undefined } })).includes("error:ALLOWED_HOSTS"));
  // API : client hors domaines officiels → erreur ; sans client → avertissement (aucune API contactable)
  const f = fakeApi().fetchImpl;
  class Evil extends FakeApiAdapter {
    override readonly client = new ApiClient({ allowedHosts: ["collect.evil.example"], baseUrl: "https://collect.evil.example/v1", fetchImpl: f });
  }
  assert.ok(codes(new Evil(f), cat).includes("error:API_HOST_NOT_OFFICIAL"));
  assert.ok(!codes(new FakeApiAdapter(f), cat).some((c) => c.startsWith("error:")), codes(new FakeApiAdapter(f), cat).join(","));
  class NoClient extends FakeApiAdapter { override readonly client = undefined as never; }
  assert.ok(codes(new NoClient(f), cat).includes("warning:API_HOSTS"));
});

test("matchOffer = veto seulement : la plateforme peut EXCLURE une offre, jamais en ajouter ni contourner budget/quantité", async () => {
  const run = async (a: FakeAdapter) => {
    const cfg = ConfigSchema.parse({ site: "fake", event: { name: "T", url: "http://127.0.0.1:9/e" }, sale: { startTime: new Date(Date.now() - 300).toISOString() }, tickets: { quantity: 2, maxPricePerTicket: 150 }, timing: { preArmSeconds: 0, pollIntervalMs: 200, maxWaitAfterSaleSeconds: 2 }, notifications: { desktop: false, sound: false }, telemetry: { enabled: false } });
    return new Agent({ config: cfg, adapter: a, claude: new ClaudeAssistant(cfg.claude, silentLogger), log: silentLogger, clock: new Clock(), notifier: async () => undefined,
      ctx: { config: cfg, context: {} as never, page: { bringToFront: async () => undefined } as never, log: silentLogger, env: {}, selectors: new SelectorResolver("fake", "/nonexistent/x.json") } }).run();
  };
  class Veto extends FakeAdapter { override matchOffer(o: Offer): boolean { return o.id !== "reserve-abonnes"; } }
  const a = new Veto();
  a.offers = [offer({ id: "reserve-abonnes", pricePerTicket: 50 }), offer({ id: "ok", pricePerTicket: 100 })];
  assert.equal((await run(a)).offer?.id, "ok", "l'offre la moins chère mais vétoée est exclue");
  // un « oui » de la plateforme n'ajoute pas une offre que le cœur a écartée (hors budget)
  class Yes extends FakeAdapter { override matchOffer(): boolean { return true; } }
  const b = new Yes();
  b.offers = [offer({ id: "trop-cher", pricePerTicket: 999 })];
  const r = await run(b);
  assert.notEqual(r.finalState, "CART_SUCCESS");
  assert.ok(!b.calls.some((c) => c.startsWith("selectOffer")), "aucune sélection d'une offre hors budget");
});

test("états : les 10 états du contrat d'adaptateur + 2 états produits par le cœur seul ; un adaptateur ne remonte que des états bloquants", () => {
  assert.deepEqual([...ADAPTER_STATES], ["AVAILABLE", "SOLD_OUT", "QUEUE", "CAPTCHA", "LOGIN_REQUIRED", "MANUAL_SELECTION", "PURCHASE_LIMIT", "BLOCKED", "CART_SUCCESS", "ERROR"]);
  assert.deepEqual([...CORE_ONLY_STATES], ["MANUAL_INTERVENTION", "AUTHORIZATION_EXPIRED"]);
  assert.deepEqual([...ADAPTER_STATES, ...CORE_ONLY_STATES].sort(), Object.keys(State).sort());
});

test("fixture de développement : ExampleSite est TEST_ONLY / NOT_A_REAL_PLATFORM — hors catalogue, sans autorisation, limité à localhost, jamais une preuve d'architecture réelle", async () => {
  const site = new ExampleSite();
  assert.equal(site.meta.testOnly, true);
  assert.match(site.meta.displayName, /TEST_ONLY · NOT_A_REAL_PLATFORM/);
  assert.equal(site.meta.compliance.policy, "demo");
  assert.equal(site.authorization.evidenceRequired, false);
  const local = ConfigSchema.parse({ site: "example", event: { name: "E", url: "http://127.0.0.1:4173/event" }, sale: { startTime: "2030-01-01T00:00:00Z" }, tickets: { quantity: 1, maxPricePerTicket: 1 } });
  assert.deepEqual(site.allowedHosts(local), ["127.0.0.1"]);
  const src = (await import("node:fs")).readFileSync("src/sites/ExampleSite.ts", "utf8");
  assert.match(src, /TEST_ONLY · NOT_A_REAL_PLATFORM/);
  assert.match(src, /PAS une plateforme réelle/);
  assert.match(src, /ni une preuve d'architecture réelle, ni une autorisation/);
  // hors catalogue : aucune plateforme « example », aucun statut influencé
  const catalog = loadCatalog();
  assert.equal(findPlatform(catalog, "example"), undefined);
  assert.equal(catalog.evidence.length, 0);
  // il ne peut pas viser autre chose que localhost
  const { assertCompliant } = await import("../src/sites/compliance.js");
  assert.throws(() => assertCompliant(site.meta, "https://www.p.example/e"), /localhost/);
  // `npm run sites` l'étiquette
  const lines: string[] = [];
  const log = console.log;
  console.log = (m?: unknown) => void lines.push(String(m));
  try {
    await sitesCommand({ json: false });
  } finally {
    console.log = log;
  }
  assert.ok(lines.some((l) => /example\s.*demo TEST_ONLY/.test(l)), lines.join("\n"));
  // aucun adaptateur du dépôt, hors fixtures de test, ne prétend être réel sans être dans le catalogue
  for (const { adapter: a } of await discoverAdapterEntries()) if (a.meta.compliance.policy !== "demo") assert.ok(findPlatform(catalog, a.authorization.platform), `${a.meta.id} : plateforme absente du catalogue`);
  void adapter;
});
