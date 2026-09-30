import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiClient, PAYMENT_PATH, parseRetryAfter, type ApiResponse } from "../src/api/ApiClient.js";
import { BaseApiAdapter } from "../src/api/BaseApiAdapter.js";
import { scanSource } from "../src/sites/contract.js";
import { readFileSync, readdirSync } from "node:fs";
import { NotLoggedInError, RateLimitedError } from "../src/utils/errors.js";
import { createLogger } from "../src/utils/logger.js";
import { FakeApiAdapter, fakeApi } from "./helpers/fakeApi.js";

/** AUDIT d'ApiClient : tout se passe contre de faux `fetch` ; aucune requête réseau, aucune vraie API. */
const SECRET = "SECRET-CANARY-1234567890abcdef";
const client = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}): ApiClient =>
  new ApiClient({ baseUrl: "https://api.p.example/v1", auth: { envVar: "P_API_KEY" }, env: { P_API_KEY: SECRET }, fetchImpl, minIntervalMs: 200, ...over });
const ok = (): Response => new Response("{}", { headers: { "content-type": "application/json" } });

test("redirections vers un AUTRE domaine (301/302/303/307/308, absolue, relative, protocole relatif) : refusées, jamais suivies, secret jamais envoyé ailleurs", async () => {
  const targets = ["https://evil.example/collect", "//evil.example/collect", "/v1/other", "http://api.p.example/v1/me", "https://api.p.example.evil.example/v1/me", "https://api.p.example@evil.example/"];
  for (const status of [301, 302, 303, 307, 308]) {
    for (const location of targets) {
      const seen: { url: string; auth?: string }[] = [];
      const fetchImpl = (async (u: unknown, init?: RequestInit) => {
        seen.push({ url: String(u), auth: (init?.headers as Record<string, string>).authorization });
        return new Response(null, { status, headers: { location } });
      }) as typeof fetch;
      const err = await client(fetchImpl).request("GET", "/me").catch((e: Error) => e);
      assert.match((err as Error).message, /redirection refusée/, `${status} → ${location}`);
      assert.equal(seen.length, 1, "aucune requête vers la cible de la redirection");
      assert.equal(new URL(seen[0]!.url).host, "api.p.example");
      assert.ok(!(err as Error).message.includes("evil.example") && !(err as Error).message.includes(SECRET), "l'erreur ne relaie ni la cible ni le secret");
    }
  }
});

test("aucun domaine arbitraire : toute requête émise vise l'hôte ET le préfixe de baseUrl, quelle que soit la forme du chemin", async () => {
  const hit: URL[] = [];
  const fetchImpl = (async (u: unknown) => (hit.push(new URL(String(u))), ok())) as typeof fetch;
  const c = client(fetchImpl);
  const paths = ["/me", "/\\evil.example/x", "/%2e%2e/admin", "/v1/../x", "/..%2f..%2fx", "/x#@evil.example", "/x?next=https://evil.example", "/@evil.example/x", "/x\r\nHost: evil.example", "/ok/https://evil.example", "//evil.example", "https://evil.example/x", "evil.example/x", "/:@evil.example/", "/\t/evil.example", "/%0d%0aHost:evil.example"];
  for (const p of paths) await c.request("GET", p).catch(() => undefined);
  assert.ok(hit.length > 0);
  for (const u of hit) {
    assert.equal(u.origin, "https://api.p.example", u.href);
    assert.ok(u.pathname === "/v1" || u.pathname.startsWith("/v1/"), u.href);
    assert.equal(u.username + u.password, "");
  }
  assert.throws(() => new ApiClient({ baseUrl: "https://api.p.example/v1?x=1", fetchImpl }), /sans paramètres/);
  assert.throws(() => new ApiClient({ baseUrl: "https://api.p.example/v1#x", fetchImpl }), /sans paramètres/);
  assert.throws(() => new ApiClient({ baseUrl: "wss://api.p.example/v1", fetchImpl }), /https/);
  // L'interface publique n'accepte qu'un CHEMIN : il n'existe aucune méthode pour changer d'hôte ni pour fournir une URL complète.
  const methods = Object.getOwnPropertyNames(ApiClient.prototype).filter((m) => m !== "constructor" && !["gate", "url", "headers", "sanitize"].includes(m));
  assert.deepEqual(methods, ["request"]);
});

test("secrets : uniquement par NOM de variable d'environnement — une valeur littérale dans les options est ignorée, jamais envoyée", async () => {
  const seen: (string | undefined)[] = [];
  const fetchImpl = (async (_u: unknown, init?: RequestInit) => (seen.push((init?.headers as Record<string, string>).authorization), ok())) as typeof fetch;
  const literal = { envVar: "P_API_KEY", secret: "LITERAL-SECRET-XYZ", token: "LITERAL-TOKEN", value: "LITERAL-VALUE" } as never;
  const c = new ApiClient({ baseUrl: "https://api.p.example/v1", auth: literal, env: {}, fetchImpl, minIntervalMs: 200 });
  await assert.rejects(c.request("GET", "/me"), NotLoggedInError);
  assert.equal(seen.length, 0, "rien n'est envoyé sans la variable d'environnement");
  assert.throws(() => new ApiClient({ baseUrl: "https://tok:en@api.p.example/v1", fetchImpl }), /identifiants/);
  const src = readFileSync("src/api/ApiClient.ts", "utf8");
  assert.ok(!/authorization["']?\s*[:=]\s*["'`][^"'`$]/i.test(src.replace(/\/\/.*$/gm, "")), "aucun en-tête d'autorisation littéral dans le code");
});

test("aucun secret dans les erreurs ni les logs, même quand le réseau échoue avec l'URL, l'en-tête ou la valeur du secret dans son message", async () => {
  const lines: string[] = [];
  const log = createLogger({ level: "debug", sink: (_l, line) => lines.push(line) });
  const boom = (async (u: unknown) => {
    const e = new Error(`connect ECONNREFUSED ${String(u)} (authorization: Bearer ${SECRET}) key=${SECRET}`);
    (e as Error & { cause?: unknown }).cause = new Error(`cause ${String(u)} ${SECRET}`);
    throw e;
  }) as typeof fetch;
  const err = (await client(boom, { log }).request("GET", "/me", { query: { token: "QUERY-CANARY-987654321", email: "jean@exemple.fr" } }).catch((e: Error) => e)) as Error & { cause?: unknown };
  const all = `${err.message}\n${String(err.stack)}\n${lines.join("\n")}`;
  for (const leak of [SECRET, "QUERY-CANARY", "jean@exemple.fr", "Bearer "]) assert.ok(!all.includes(leak), `fuite : ${leak}`);
  assert.equal(err.cause, undefined, "pas de `cause` (elle contient l'URL et le secret)");
  assert.match(err.message, /API GET \/v1\/me/);
  // 4xx/5xx : ni corps de réponse ni en-têtes dans l'erreur.
  const res500 = (async () => new Response(JSON.stringify({ code: "x", detail: `echo ${SECRET}` }), { status: 500, headers: { "content-type": "application/json", "set-cookie": "sid=COOKIE-CANARY" } })) as typeof fetch;
  const e500 = (await client(res500, { log }).request("GET", "/me").catch((e: Error) => e)) as Error;
  assert.ok(!e500.message.includes(SECRET) && !e500.message.includes("COOKIE-CANARY"));
  assert.ok(!lines.join("\n").includes("COOKIE-CANARY") && !lines.join("\n").includes(SECRET));
});

test("Retry-After : secondes, date HTTP, bornes, valeurs absurdes ; un 429 est remonté avec l'attente demandée, jamais contourné", async () => {
  const t = Date.parse("2026-09-30T12:00:00Z");
  assert.equal(parseRetryAfter("5", t), 5000);
  assert.equal(parseRetryAfter("0", t), 200, "plancher");
  assert.equal(parseRetryAfter("-5", t), 200);
  assert.equal(parseRetryAfter("999999", t), 60_000, "plafond");
  assert.equal(parseRetryAfter("Wed, 30 Sep 2026 12:00:07 GMT", t), 7000);
  assert.equal(parseRetryAfter("Wed, 30 Sep 2026 11:00:00 GMT", t), 200, "date passée");
  assert.equal(parseRetryAfter("n'importe quoi", t), 2000);
  assert.equal(parseRetryAfter("Infinity", t), 2000);
  let n = 0;
  const limited = (async () => (n++, new Response("{}", { status: 429, headers: { "retry-after": "4", "content-type": "application/json" } }))) as typeof fetch;
  const err = await client(limited).request("GET", "/me").catch((e: Error) => e);
  assert.ok(err instanceof RateLimitedError);
  assert.equal((err as RateLimitedError).retryAfterMs, 4000);
  assert.equal(n, 1, "le client ne réessaie JAMAIS de lui-même : c'est le cœur qui attend");
});

test("cadence : jamais moins de 200 ms entre deux DÉBUTS de requête, même après échecs, annulations et appels parallèles", async () => {
  const stamps: number[] = [];
  const fetchImpl = (async () => (stamps.push(Date.now()), Math.random() < 2 ? ok() : ok())) as typeof fetch;
  const c = client(fetchImpl, { minIntervalMs: 1 });
  const ctl = new AbortController();
  const all = [c.request("GET", "/a"), c.request("GET", "/b", { signal: ctl.signal }), c.request("GET", "/c"), c.request("GET", "/d")];
  setTimeout(() => ctl.abort(), 50);
  await Promise.allSettled(all);
  for (let i = 1; i < stamps.length; i++) assert.ok(stamps[i]! - stamps[i - 1]! >= 190, `écart ${stamps[i]! - stamps[i - 1]!} ms`);
});

test("délai d'attente : une requête qui ne répond pas est interrompue (et la suivante peut partir)", async () => {
  let calls = 0;
  const hanging = ((_u: unknown, init?: RequestInit) =>
    new Promise((resolve, reject) => {
      calls++;
      if (calls > 1) return resolve(ok());
      const keep = setTimeout(() => undefined, 3000); // un vrai socket maintient la boucle d'événements
      init!.signal!.addEventListener("abort", () => (clearTimeout(keep), reject(new Error("timeout"))));
    })) as typeof fetch;
  const c = client(hanging, { timeoutMs: 120 });
  await assert.rejects(c.request("GET", "/me"), /timeout/);
  assert.equal((await c.request("GET", "/me")).status, 200, "la file n'est pas bloquée par l'échec précédent");
});

test("annulation propre : en vol → interrompue ; en attente de cadence → jamais envoyée ; déjà annulée → aucun appel ; la file continue", async () => {
  const calls: string[] = [];
  const has = (p: string): boolean => calls.includes(p);
  const fetchImpl = ((u: unknown, init?: RequestInit) =>
    new Promise((resolve, reject) => {
      calls.push(new URL(String(u)).pathname);
      const t = setTimeout(() => resolve(ok()), 400);
      init!.signal!.addEventListener("abort", () => (clearTimeout(t), reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    })) as typeof fetch;
  const c = client(fetchImpl);

  // 1. déjà annulée : aucun appel
  const done = new AbortController();
  done.abort();
  await assert.rejects(c.request("GET", "/deja", { signal: done.signal }), /annulée|abort/i);
  assert.deepEqual(calls, []);

  // 2. en vol : l'annulation interrompt la requête
  const inflight = new AbortController();
  const p1 = c.request("GET", "/vol", { signal: inflight.signal });
  await new Promise((r) => setTimeout(r, 50));
  inflight.abort();
  await assert.rejects(p1, /abort|annulée/i);

  // 3. en attente de cadence : annulée AVANT son départ, donc jamais émise ; la suivante part ensuite normalement
  const waiting = new AbortController();
  const p2 = c.request("GET", "/attente", { signal: waiting.signal }); // part après l'intervalle de 200 ms
  setTimeout(() => waiting.abort(), 20);
  await assert.rejects(p2, /abort|annulée/i);
  assert.ok(!has("/v1/attente"), "la requête annulée pendant l'attente n'est jamais partie");
  const p3 = await c.request("GET", "/suite");
  assert.equal(p3.status, 200);
  assert.ok(has("/v1/suite"));
});

test("aucune opération de paiement : chemins et corps de paiement refusés AVANT l'envoi ; aucune méthode de paiement ; code source propre", async () => {
  const { fetchImpl, state } = fakeApi();
  const c = client(fetchImpl);
  for (const p of ["/pay", "/payments", "/payment/confirm", "/orders/1/pay", "/checkout", "/checkout/session", "/billing", "/charge", "/cards", "/wallet", "/transactions", "/events/1/capture", "/refund", "/place-order", "/confirm-order", "/paiement", "/v1/payments"]) {
    await assert.rejects(c.request("POST", p), /paiement/, p);
  }
  for (const body of [{ cardNumber: "4111111111111111" }, { card: { number: "4111" } }, { cvv: "123" }, { iban: "FR7630006000011234567890189" }, { paymentMethod: "visa" }, { options: { nested: [{ billingAddress: "x" }] } }, { holder: "Jean" }]) {
    await assert.rejects(c.request("POST", "/holds", { body }), /paiement/, JSON.stringify(body));
  }
  assert.equal(state.calls.length, 0, "rien n'est parti");
  // chemins légitimes : pas de faux positif
  for (const p of ["/me", "/queue", "/events/1/offers", "/holds", "/reservations", "/reservations/current", "/events/1/purchase-limits", "/cartography/zones"]) assert.ok(!PAYMENT_PATH.test(p), p);
  // l'interface d'adaptateur n'a aucune méthode de paiement, le client seulement `request`
  const names = [...Object.getOwnPropertyNames(BaseApiAdapter.prototype), ...Object.getOwnPropertyNames(FakeApiAdapter.prototype)];
  assert.ok(!names.some((n) => /pay|paiement|checkout|charge|purchase|card/i.test(n)), names.join(", "));
  // ApiClient.ts définit lui-même les motifs de REFUS (cartes, CVV…) : il est exclu du balayage des motifs interdits, pas du reste.
  for (const f of readdirSync("src/api").filter((f) => f !== "ApiClient.ts")) assert.deepEqual(scanSource(readFileSync(`src/api/${f}`, "utf8")).map((i) => i.code), [], `src/api/${f} : motif interdit`);
});

test("réponse mal formée ou géante : pas de plantage, corps tronqué, JSON invalide ignoré", async () => {
  const big = (async () => new Response("x".repeat(3_000_000), { status: 200, headers: { "content-type": "text/plain" } })) as typeof fetch;
  assert.equal((await client(big).request("GET", "/me")).body, undefined);
  const bad = (async () => new Response("{ pas du json", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  assert.equal(((await client(bad).request("GET", "/me")) as ApiResponse).body, undefined);
});
