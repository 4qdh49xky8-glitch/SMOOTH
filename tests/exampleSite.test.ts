import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { request, type APIRequestContext } from "playwright";
import { startDemoServer } from "../demo/server.js";
import { ConfigSchema } from "../src/config/schema.js";
import { SelectorResolver } from "../src/selectors/resolver.js";
import ExampleSite from "../src/sites/ExampleSite.js";
import type { AdapterContext } from "../src/sites/SiteAdapter.js";

let demo: Awaited<ReturnType<typeof startDemoServer>>;
let api: APIRequestContext;
let ctx: AdapterContext;
const site = new ExampleSite();

before(async () => {
  demo = await startDemoServer({ openAt: Date.now() - 1000 });
  api = await request.newContext();
  await api.post(`${demo.url}/login`, { form: { email: "demo@example.com", password: "demo" }, maxRedirects: 0 }).catch(() => undefined);
  const config = ConfigSchema.parse({
    site: "example",
    event: { name: "t", url: `${demo.url}/event` },
    sale: { startTime: new Date().toISOString() },
    tickets: { quantity: 2, maxPricePerTicket: 150 },
  });
  ctx = { config, context: { request: api } as never, page: {} as never, log: console as never, env: {}, selectors: new SelectorResolver("example", "/nonexistent/x.json") };
});
after(async () => {
  await api.dispose();
  await demo.close();
});

test("fetchSale normalise prix, catégorie, quantité, URL et adjacence des places", async () => {
  const sale = await site.fetchSale(ctx);
  assert.equal(sale.open, true);
  const byId = Object.fromEntries(sale.offers.map((o) => [o.id, o]));
  assert.equal(byId.o2?.pricePerTicket, 139);
  assert.equal(byId.o2?.category, "Catégorie 2");
  assert.equal(byId.o2?.seatsTogether, true); // sièges 5,6
  assert.equal(byId.o3?.seatsTogether, false); // sièges 8,20
  assert.equal(byId.o4?.available, 1);
  assert.ok(byId.o2?.url?.startsWith(demo.url));
});

test("getServerTime : l'heure serveur est exploitable pour caler l'horloge", async () => {
  const t = await site.getServerTime(ctx);
  assert.ok(Math.abs(t - Date.now()) < 500);
});

test("garde-fou de paiement de l'adaptateur", () => {
  assert.ok(site.paymentUrlPatterns.some((p) => p.test(`${demo.url}/payment`)));
  assert.ok(!site.paymentUrlPatterns.some((p) => p.test(`${demo.url}/cart`)));
});
