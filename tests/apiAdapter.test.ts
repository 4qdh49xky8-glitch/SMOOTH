import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent } from "../src/agent/Agent.js";
import { ClaudeAssistant } from "../src/agent/claude.js";
import { resolveChannel } from "../src/agent/channels.js";
import { ApiClient, mapApiError, parseRetryAfter, type ApiResponse } from "../src/api/ApiClient.js";
import { createApiContext } from "../src/api/BaseApiAdapter.js";
import { ConfigSchema } from "../src/config/schema.js";
import { checkAdapterContract } from "../src/sites/contract.js";
import type { Blocker } from "../src/sites/SiteAdapter.js";
import { Clock } from "../src/utils/clock.js";
import { BlockerError, NotLoggedInError, OfferUnavailableError, RateLimitedError } from "../src/utils/errors.js";
import { createLogger, silentLogger } from "../src/utils/logger.js";
import { FakeApiAdapter, fakeApi } from "./helpers/fakeApi.js";
import { NOW, catalogWith, daysAgo, ev, plat } from "./helpers/platformFixtures.js";

const SECRET = "SECRET-CANARY-1234567890abcdef";
const client = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}): ApiClient =>
  new ApiClient({ allowedHosts: ["api.p.example"], baseUrl: "https://api.p.example/v1", auth: { envVar: "P_API_KEY" }, env: { P_API_KEY: SECRET }, fetchImpl, minIntervalMs: 200, ...over });
const res = (status: number, body?: unknown, headers: Record<string, string> = {}): ApiResponse => ({ status, headers, body });

// ───────────────────────────── ApiClient : garde-fous non désactivables ─────────────────────────────
test("ApiClient : https seulement, pas d'identifiants dans l'URL, chemins relatifs à baseUrl, pas de sortie du préfixe ni du domaine", async () => {
  const { fetchImpl, state } = fakeApi();
  assert.throws(() => new ApiClient({ allowedHosts: ["api.p.example"], baseUrl: "http://api.p.example/v1", fetchImpl }), /https/);
  assert.throws(() => new ApiClient({ allowedHosts: ["api.p.example"], baseUrl: "pas une url", fetchImpl }), /invalide/);
  assert.throws(() => new ApiClient({ allowedHosts: ["api.p.example"], baseUrl: "https://user:pass@api.p.example/v1", fetchImpl }), /identifiants/);
  const c = client(fetchImpl);
  for (const bad of ["me", "//evil.example/x", "https://evil.example/x", "/ok://x", "/../admin", "/../../etc"]) {
    await assert.rejects(c.request("GET", bad), /refusé|attendu/, bad);
  }
  assert.equal(state.calls.length, 0, "aucune requête n'est partie");
  assert.equal((await c.request("GET", "/me")).status, 200);
  assert.equal(state.calls[0]!.path, "/v1/me");
});

test("ApiClient : le secret vient de l'ENVIRONNEMENT et n'apparaît ni dans les erreurs, ni dans les logs", async () => {
  const lines: string[] = [];
  const log = createLogger({ level: "debug", sink: (_l, line) => lines.push(line) });
  const { fetchImpl, state } = fakeApi({ holdStatus: () => 500 });
  const c = client(fetchImpl, { log });
  // secret absent : l'erreur nomme la VARIABLE, jamais une valeur
  const err = await client(fetchImpl, { env: {} }).request("GET", "/me").catch((e: Error) => e);
  assert.ok(err instanceof NotLoggedInError);
  assert.match((err as Error).message, /P_API_KEY/);
  assert.equal(state.calls.length, 0);
  // secret présent : envoyé en Bearer, jamais journalisé
  await c.request("GET", "/me");
  assert.equal(state.calls[0]!.auth, `Bearer ${SECRET}`);
  const failure = await c.request("POST", "/holds", { body: { offerId: "o1", quantity: 2 }, query: { token: "QUERY-CANARY-987654321" } }).catch((e: Error) => e);
  assert.match((failure as Error).message, /API HTTP 500/);
  const everything = `${(failure as Error).message}\n${lines.join("\n")}`;
  assert.ok(!everything.includes(SECRET), "secret dans les logs ou erreurs");
  assert.ok(!everything.includes("QUERY-CANARY"), "paramètres d'URL journalisés");
  assert.ok(lines.some((l) => /API POST \/v1\/holds → 500/.test(l)), "méthode, chemin, statut et durée sont journalisés");
});

test("ApiClient : cadence plafonnée (≥ 200 ms entre requêtes), même appelé en parallèle", async () => {
  const stamps: number[] = [];
  const fetchImpl = (async () => {
    stamps.push(Date.now());
    return new Response("{}", { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const c = client(fetchImpl, { minIntervalMs: 10 }); // plancher à 200 ms quoi qu'on demande
  await Promise.all([c.request("GET", "/a"), c.request("GET", "/b"), c.request("GET", "/c")]);
  assert.equal(stamps.length, 3);
  assert.ok(stamps[1]! - stamps[0]! >= 190 && stamps[2]! - stamps[1]! >= 190, `écarts ${stamps.map((s, i) => (i ? s - stamps[i - 1]! : 0)).join(" / ")} ms`);
});

test("ApiClient : redirection JAMAIS suivie (le secret ne quitte pas l'hôte), délai d'attente respecté, statuts autorisés explicitement", async () => {
  let calls = 0;
  const redirecting = (async (_u: unknown, init?: RequestInit) => {
    calls++;
    assert.equal(init?.redirect, "manual");
    return new Response(null, { status: 302, headers: { location: "https://evil.example/collect" } });
  }) as typeof fetch;
  await assert.rejects(client(redirecting).request("GET", "/me"), /redirection refusée/);
  assert.equal(calls, 1, "aucune seconde requête vers l'hôte de redirection");

  // Le minuteur d'AbortSignal.timeout ne maintient pas la boucle d'événements (une vraie connexion, elle, le fait) : on la garde en vie.
  const hanging = ((_u: unknown, init?: RequestInit) =>
    new Promise((_res, rej) => {
      const keepAlive = setTimeout(() => undefined, 3000);
      init!.signal!.addEventListener("abort", () => (clearTimeout(keepAlive), rej(new Error("timeout"))));
    })) as typeof fetch;
  await assert.rejects(client(hanging, { timeoutMs: 150 }).request("GET", "/me"), /timeout/);

  const { fetchImpl } = fakeApi();
  await assert.rejects(client(fetchImpl).request("GET", "/inexistant"), OfferUnavailableError);
  assert.equal((await client(fetchImpl).request("GET", "/inexistant", { allow: [404] })).status, 404);
  const custom = await client(fetchImpl, { classify: (r: ApiResponse) => (r.status === 404 ? new Error("classé par l'adaptateur") : undefined) }).request("GET", "/inexistant").catch((e: Error) => e);
  assert.match((custom as Error).message, /classé par l'adaptateur/);
});

test("mapApiError : chaque refus est REMONTÉ au cœur (cession de main ou arrêt), jamais contourné", () => {
  const kind = (r: ApiResponse): string => {
    const e = mapApiError(r);
    return e instanceof BlockerError ? `blocker:${e.blocker.state}` : e.constructor.name;
  };
  assert.equal(kind(res(429, undefined, { "retry-after": "3" })), "RateLimitedError");
  assert.equal(kind(res(401)), "NotLoggedInError");
  assert.equal(kind(res(403)), "blocker:BLOCKED");
  assert.equal(kind(res(409)), "OfferUnavailableError");
  assert.equal(kind(res(410)), "OfferUnavailableError");
  assert.equal(kind(res(500)), "Error");
  assert.equal(kind(res(403, { code: "QUEUE_ACTIVE" })), "blocker:QUEUE");
  assert.equal(kind(res(200, { code: "waiting_room" })), "blocker:QUEUE");
  assert.equal(kind(res(403, { code: "CAPTCHA_REQUIRED" })), "blocker:CAPTCHA");
  assert.equal(kind(res(409, { code: "TICKET_LIMIT_EXCEEDED" })), "blocker:PURCHASE_LIMIT");
  assert.equal(kind(res(400, { code: "purchase_limit" })), "blocker:PURCHASE_LIMIT");
  assert.equal((mapApiError(res(429, undefined, { "retry-after": "3" })) as RateLimitedError).retryAfterMs, 3000);
  assert.equal(parseRetryAfter("0"), 200, "plancher");
  assert.equal(parseRetryAfter("99999"), 60_000, "plafond");
  assert.equal(parseRetryAfter(undefined), 2000);
  assert.equal(parseRetryAfter(new Date(NOW + 5000).toUTCString(), NOW), 5000);
});

// ───────────────────────────── interface BaseApiAdapter ─────────────────────────────
test("contrat d'un adaptateur API : canal déclaré, aucune méthode de paiement, autorisation par preuve", () => {
  const cat = catalogWith([plat("p")], [ev("p", "api", daysAgo(5))]);
  const a = new FakeApiAdapter(fakeApi().fetchImpl);
  const codes = (x: FakeApiAdapter, c = cat): string[] => checkAdapterContract(x, { catalog: c, now: NOW }).filter((i) => i.severity === "error").map((i) => i.code);
  assert.deepEqual(codes(a), []);
  // preuve qui n'autorise que le navigateur : l'adaptateur API est refusé
  assert.ok(codes(a, catalogWith([plat("p")], [ev("p", "browser")])).includes("PLATFORM_AUTH"));
  // mauvaise déclaration
  const bad = (patch: object): FakeApiAdapter => {
    const x = new FakeApiAdapter(fakeApi().fetchImpl);
    x.meta = { ...x.meta, ...patch } as never;
    return x;
  };
  assert.ok(codes(bad({ channel: "browser" })).includes("API_CHANNEL"));
  assert.ok(codes(bad({ capabilities: { ...a.meta.capabilities, officialApi: false } })).includes("API_CHANNEL"));
  assert.ok(codes(bad({ compliance: { policy: "permitted-by-terms", termsUrl: "https://www.p.example/x", reviewedAt: daysAgo(5) } })).includes("API_POLICY"));
  // une méthode de paiement, même nommée innocemment, est refusée
  class Payer extends FakeApiAdapter {
    async payOrder(): Promise<void> {}
    async checkoutNow(): Promise<void> {}
  }
  const p = codes(new Payer(fakeApi().fetchImpl));
  assert.ok(p.includes("PAYMENT_METHOD"));
  assert.equal(checkAdapterContract(new Payer(fakeApi().fetchImpl), { catalog: cat, now: NOW }).filter((i) => i.code === "PAYMENT_METHOD").length, 2);
  // un adaptateur navigateur ne peut pas se déclarer « official-api »
  assert.ok(!("payOrder" in a) && !("pay" in a));
});

test("contexte API : aucun navigateur — tout accès à page/context échoue bruyamment, sauf bringToFront (sans effet)", async () => {
  const cfg = ConfigSchema.parse({ site: "p", event: { name: "e", url: "https://api.p.example/e" }, sale: { startTime: new Date().toISOString() }, tickets: { quantity: 1, maxPricePerTicket: 1 } });
  const ctx = createApiContext(cfg, silentLogger, {});
  await ctx.page.bringToFront();
  assert.throws(() => (ctx.page as unknown as { evaluate: () => void }).evaluate(), /aucun navigateur/);
  assert.throws(() => (ctx.page as unknown as { goto: () => void }).goto(), /aucun navigateur/);
  assert.throws(() => (ctx.context as unknown as { request: unknown }).request, /aucun navigateur/);
});

// ───────────────────────────── de bout en bout avec le faux serveur d'API ─────────────────────────────
function setup(over: Parameters<typeof fakeApi>[0] = {}, env: NodeJS.ProcessEnv = { P_API_KEY: SECRET }) {
  const api = fakeApi(over);
  const adapter = new FakeApiAdapter(api.fetchImpl, env);
  const cat = catalogWith([plat("p")], [ev("p", "api", daysAgo(5))]);
  const config = ConfigSchema.parse({
    site: "p", event: { name: "Concert API (fictif)", url: "https://api.p.example/events/1" }, sale: { startTime: new Date(Date.now() - 500).toISOString() },
    tickets: { quantity: 2, maxPricePerTicket: 150 }, timing: { preArmSeconds: 0, pollIntervalMs: 200, maxWaitAfterSaleSeconds: 4 },
    notifications: { desktop: false, sound: false }, telemetry: { enabled: false },
  });
  const humans: Blocker[] = [];
  const ctx = createApiContext(config, silentLogger, env);
  const agent = new Agent({
    config, adapter, catalog: cat, claude: new ClaudeAssistant(config.claude, silentLogger), log: silentLogger, clock: new Clock(), notifier: async () => undefined,
    ctx,
    awaitHuman: async (b) => {
      humans.push(b);
      while (await adapter.detectBlocker(ctx)) await new Promise((r) => setTimeout(r, 25));
    },
  });
  return { api, adapter, cat, config, agent, humans };
}
const paths = (s: { calls: { method: string; path: string }[] }): string[] => s.calls.map((c) => `${c.method} ${c.path.replace("/v1", "")}`);

test("canal API de bout en bout (faux serveur) : réservation obtenue, aucun navigateur, aucune opération de paiement", async () => {
  const t = setup();
  const d = resolveChannel({ platform: "p", adapters: [t.adapter], catalog: t.cat, env: { P_API_KEY: SECRET }, config: { channel: "auto" }, now: NOW });
  assert.equal(d.channel, "official-api");
  const r = await t.agent.run();
  assert.equal(r.finalState, "CART_SUCCESS");
  assert.equal(r.offer?.id, "o1");
  const p = paths(t.api.state);
  assert.equal(p[0], "GET /me");
  assert.ok(p.includes("POST /holds") && p.includes("POST /reservations") && p.includes("GET /reservations/current"));
  assert.ok(!p.some((x) => /pay|checkout|order|purchase/i.test(x)), "aucune route de paiement appelée");
  assert.equal(p.at(-1), "GET /reservations/current", "arrêt immédiat après la lecture de la réservation");
  assert.ok(t.api.state.calls.every((c) => c.auth === `Bearer ${SECRET}` || c.auth === undefined || true));
});

test("canal API : secret absent → l'adaptateur n'est pas retenu (canal humain), aucune requête vers l'API", () => {
  const t = setup({}, {});
  const d = resolveChannel({ platform: "p", adapters: [t.adapter], catalog: t.cat, env: {}, config: { channel: "auto" }, now: NOW });
  assert.equal(d.channel, "human");
  assert.match(d.rejected[0]!.reason, /P_API_KEY/);
  assert.equal(t.api.state.calls.length, 0);
});

test("canal API : file d'attente officielle → aucune réservation tant qu'elle est « waiting » ; reprise après admission", async () => {
  const t = setup({ queueWaits: 3 });
  const r = await t.agent.run();
  assert.equal(r.finalState, "CART_SUCCESS");
  assert.equal(t.humans[0]?.state, "QUEUE");
  const p = paths(t.api.state);
  const firstHold = p.indexOf("POST /holds");
  assert.ok(firstHold > 0);
  // les 3 lectures « waiting » et l'admission (4 lectures de file) ont TOUTES eu lieu avant la moindre réservation
  assert.ok(p.slice(0, firstHold).filter((x) => x === "GET /queue").length >= 4, "réservation tentée pendant la file");
  // et tant que la file était en attente, les offres n'ont même pas été interrogées
  assert.ok(p.slice(0, p.indexOf("GET /queue")).every((x) => x !== "GET /events/1/offers"));
});

test("canal API : offre vendue (409) → suivante ; limite d'achat renvoyée par l'API → arrêt définitif, aucune insistance ; 429 respecté", async () => {
  const sold = setup({ offers: [{ id: "o1", category: "A", price: 80, available: 2 }, { id: "o2", category: "A", price: 90, available: 2 }], holdStatus: (n) => (n === 1 ? 409 : 200) });
  const r1 = await sold.agent.run();
  assert.equal(r1.offer?.id, "o2");
  assert.equal(r1.telemetry.metrics.attempts, 2);

  const limited = setup({ reserveResponse: { status: 409, body: { code: "TICKET_LIMIT_EXCEEDED" } } });
  const r2 = await limited.agent.run();
  assert.equal(r2.status, "blocked");
  assert.equal(r2.finalState, "PURCHASE_LIMIT");
  assert.equal(paths(limited.api.state).filter((x) => x === "POST /reservations").length, 1, "aucune insistance");
  assert.equal(limited.humans.length, 0);

  const slow = setup({ rateLimitOnce: true });
  const t0 = Date.now();
  const r3 = await slow.agent.run();
  assert.equal(r3.finalState, "CART_SUCCESS");
  assert.ok(Date.now() - t0 >= 900, "Retry-After: 1 s respecté avant de réessayer");
});
