import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Agent } from "../src/agent/Agent.js";
import { ClaudeAssistant } from "../src/agent/claude.js";
import { ApiClient } from "../src/api/ApiClient.js";
import { createApiContext } from "../src/api/BaseApiAdapter.js";
import { ConfigSchema, type BotConfig } from "../src/config/schema.js";
import { main } from "../src/index.js";
import { assertNetworkAllowed } from "../src/platforms/authorize.js";
import type { Catalog } from "../src/platforms/catalog.js";
import { stripComments } from "../src/sites/contract.js";
import { SelectorResolver } from "../src/selectors/resolver.js";
import { Clock } from "../src/utils/clock.js";
import { silentLogger } from "../src/utils/logger.js";
import { FakeApiAdapter, fakeApi } from "./helpers/fakeApi.js";
import { FakeAdapter, offer } from "./helpers/fakeAdapter.js";
import { adapter, catalogWith, daysAgo, ev, plat } from "./helpers/platformFixtures.js";

/**
 * AUDIT GLOBAL DU RÉSEAU. Chaîne exigée pour tout ce qui touche au réseau :
 *     autorisation (preuves) → hôte autorisé (domaines officiels) → adaptateur → réseau
 * Aucun chemin « configuration utilisateur → réseau » ne doit exister sans passer par les garde-fous.
 */
const SECRET = { P_API_KEY: "SECRET-CANARY-1234567890abcdef" };
const OK: Catalog = catalogWith([plat("p")], [ev("p", "both", daysAgo(3))]);
const withEnv = async <T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> => {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  }
};
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log;
  console.log = () => undefined;
  try {
    return await fn();
  } finally {
    console.log = log;
  }
};
const cfgFile = (extra: Record<string, unknown> = {}, url = "https://api.p.example/events/1"): string => {
  const f = join(mkdtempSync(join(tmpdir(), "netpaths-")), "netpaths-test.json");
  writeFileSync(f, JSON.stringify({
    site: "p", event: { name: "e", url }, sale: { startTime: new Date(Date.now() + 500).toISOString() }, tickets: { quantity: 2, maxPricePerTicket: 150 },
    notifications: { desktop: false, sound: false }, telemetry: { enabled: false }, timing: { preArmSeconds: 0, pollIntervalMs: 200, maxWaitAfterSaleSeconds: 4 }, ...extra,
  }));
  return f;
};
const profiles = (): string[] => (existsSync(".profile") ? readdirSync(".profile") : []);

// ───────────────────────────── configuration utilisateur → réseau ─────────────────────────────
const BAD_URLS = [
  "https://evil.example/events/1", // autre domaine
  "https://p.example.evil.example/events/1", // la plateforme n'est qu'un sous-domaine du tiers
  "https://evilp.example/events/1", // sosie
  "https://api.p.example@evil.example/events/1", // identifiants : hôte réel = evil.example
  "http://api.p.example/events/1", // pas https
  "https://127.0.0.1:8443/events/1", // boucle locale sur une vraie plateforme
  "file:///etc/passwd",
  "javascript:alert(1)",
];
for (const url of BAD_URLS) {
  for (const command of ["run", "login", "check"] as const) {
    test(`config event.url « ${url} » (${command}) → refusée AVANT toute requête, tout navigateur, tout appel d'adaptateur`, async () => {
      const api = fakeApi();
      const web = adapter("p-web", { platform: "p", channel: "browser" });
      const before = profiles();
      for (const channel of ["auto", "browser", "official-api"]) {
        await assert.rejects(
          withEnv(SECRET, () => quiet(() => main([command, "--config", cfgFile({ channel }, url), "--log-level", "error"], { adapters: [web, new FakeApiAdapter(api.fetchImpl)], catalog: OK }))),
          /hors des domaines autorisés|invalid|Invalid|URL/i,
          `${channel}`,
        );
      }
      assert.deepEqual(web.calls, []);
      assert.deepEqual(api.state.calls, []);
      assert.deepEqual(profiles(), before);
    });
  }
}

test("l'hôte de l'API ne peut pas venir de la configuration : un adaptateur dont le client vise un autre domaine que la plateforme est refusé (siteOptions, baseUrl construite depuis la config)", async () => {
  class ConfigDrivenApi extends FakeApiAdapter {
    constructor(fetchImpl: typeof fetch, apiBase: string) {
      super(fetchImpl);
      (this as { client: ApiClient }).client = new ApiClient({ allowedHosts: [new URL(apiBase).hostname], baseUrl: apiBase, auth: { envVar: "P_API_KEY" }, env: SECRET, fetchImpl, minIntervalMs: 200 });
    }
  }
  const api = fakeApi();
  const evil = new ConfigDrivenApi(api.fetchImpl, "https://collect.evil.example/v1");
  const good = new ConfigDrivenApi(api.fetchImpl, "https://api.p.example/v1");
  const config = ConfigSchema.parse({ site: "p", event: { name: "e", url: "https://api.p.example/events/1" }, sale: { startTime: "2030-01-01T00:00:00Z" }, tickets: { quantity: 1, maxPricePerTicket: 1 }, siteOptions: { apiBase: "https://collect.evil.example/v1" } });
  assert.throws(() => assertNetworkAllowed(evil, config, OK), /hors des domaines autorisés/);
  assert.doesNotThrow(() => assertNetworkAllowed(good, config, OK));
  // et via `run` : refus avant la moindre requête
  await assert.rejects(withEnv(SECRET, () => quiet(() => main(["run", "--config", cfgFile(), "--log-level", "error"], { adapters: [evil], catalog: OK }))), /hors des domaines autorisés/);
  assert.deepEqual(api.state.calls, []);
});

test("Agent.run : URL d'événement ou hôte d'adaptateur hors domaines officiels → refus AVANT tout appel (y compris la synchronisation d'horloge)", async () => {
  const web = adapter("p-web", { platform: "p", channel: "browser" });
  web.offers = [offer({ id: "a" })];
  let fetched = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => (fetched++, new Response("", { headers: { date: new Date().toUTCString() } }))) as typeof fetch;
  try {
    const config = ConfigSchema.parse({ site: "p", event: { name: "T", url: "https://evil.example/e" }, sale: { startTime: new Date(Date.now() - 500).toISOString() }, tickets: { quantity: 2, maxPricePerTicket: 150 }, timing: { preArmSeconds: 0, maxWaitAfterSaleSeconds: 2 }, telemetry: { enabled: false } });
    const agent = new Agent({
      config, adapter: web, catalog: OK, claude: new ClaudeAssistant(config.claude, silentLogger), log: silentLogger, clock: new Clock(), notifier: async () => undefined,
      ctx: { config, context: {} as never, page: {} as never, log: silentLogger, env: {}, selectors: new SelectorResolver("fake", "/nonexistent/x.json") },
    });
    await assert.rejects(agent.run(), /hors des domaines autorisés/);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(web.calls, []);
  assert.equal(fetched, 0, "aucune requête (horloge comprise)");
});

// ───────────────────────────── inventaire des points d'accès au réseau ─────────────────────────────
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") ? [p] : [];
  });
}
const code = new Map(["src", "scripts", "demo"].flatMap(sources).map((f) => [f, stripComments(readFileSync(f, "utf8"))]));
const filesMatching = (re: RegExp): string[] => [...code].filter(([, c]) => re.test(c)).map(([f]) => f).sort();

test("inventaire : les SEULS fichiers qui peuvent toucher le réseau sont connus — toute nouvelle entrée doit être examinée ici", () => {
  // fetch : client API encadré · CDP local (boucle locale) · webhook de notification choisi par l'utilisateur (texte assaini) · en-tête Date du site après autorisation
  assert.deepEqual(filesMatching(/(?<![.\w])fetch\(|\?\? fetch\b/), ["src/api/ApiClient.ts", "src/browser/launch.ts", "src/notifications/notify.ts", "src/utils/clock.ts"]);
  // navigation de page : adaptateurs (gardés par installNetworkGuards) et la connexion manuelle de `login`
  assert.deepEqual(filesMatching(/\.goto\(/), ["src/cli/live.ts", "src/sites/BaseSiteAdapter.ts", "src/sites/ExampleSite.ts"]);
  // création de navigateur / contexte / page : un seul fichier
  assert.deepEqual(filesMatching(/connectOverCDP|\.newContext\(|\.newPage\(|chromium\.launch/), ["src/browser/launch.ts"]);
  // client Claude : un seul fichier, point d'accès fixe
  assert.deepEqual(filesMatching(/new Anthropic\(/), ["src/agent/claude.ts"]);
  // sous-processus : navigateur local, notification locale, version de Chromium
  assert.deepEqual(filesMatching(/child_process/), ["src/browser/launch.ts", "src/cli/doctor.ts", "src/notifications/notify.ts"]);
  // aucune autre bibliothèque ou primitive réseau
  for (const re of [/\baxios\b/, /\bWebSocket\b/, /\bhttps?\.(request|get)\(/, /node:https?["']/, /node:net["']/, /node:dgram["']/, /node:tls["']/, /\bXMLHttpRequest\b/, /\bgot\(|\bnode-fetch\b|\bundici\b/, /\bdns\.(lookup|resolve)/]) {
    const hits = filesMatching(re).filter((f) => !f.startsWith("demo/")); // le serveur de démo écoute en local (node:http)
    assert.deepEqual(hits, [], String(re));
  }
  // `.request(` : uniquement la lecture de la requête interceptée par le garde réseau du navigateur (aucun client HTTP ailleurs que ApiClient)
  assert.deepEqual(filesMatching(/\.request\(/), ["src/browser/guards.ts"]);
});

test("inventaire : CDP/fetch de launch.ts visent UNIQUEMENT la boucle locale ; Claude a un point d'accès fixe ; le webhook n'envoie que du texte assaini", () => {
  const launch = code.get("src/browser/launch.ts")!;
  const urls = [...launch.matchAll(/`(https?:\/\/[^`]+)`/g)].map((m) => m[1]!);
  assert.ok(urls.length >= 2);
  for (const u of urls) assert.match(u, /^http:\/\/127\.0\.0\.1:\$\{/, u);
  assert.match(code.get("src/agent/claude.ts")!, /baseURL: ANTHROPIC_API_URL/);
  const notify = code.get("src/notifications/notify.ts")!;
  assert.match(notify, /const title = redact\(options\.title\)[\s\S]*const message = redact\(options\.message\)/);
  assert.match(notify, /body: JSON\.stringify\(\{ title, message, text: `\$\{title\}\\n\$\{message\}`/, "le webhook n'envoie que title/message assainis");
});

test("ordre des garde-fous dans le code : autorisation → hôtes → verrous → navigateur → garde réseau → première navigation", () => {
  const live = code.get("src/cli/live.ts")!;
  const order = ["resolveChannel(", "assertAuthorized(adapter.meta", "assertNetworkAllowed(adapter", "acquireEventLock(k, instance)", "await openBrowser(", "await installNetworkGuards(", ".goto("].map((m) => [m, live.indexOf(m)] as const);
  for (const [m, i] of order) assert.ok(i >= 0, `absent de live.ts : ${m}`);
  assert.deepEqual([...order].sort((a, b) => a[1] - b[1]).map((o) => o[0]), order.map((o) => o[0]), "l'ordre des garde-fous a changé");
  const agent = code.get("src/agent/Agent.ts")!;
  const run = agent.slice(agent.indexOf("async run()"), agent.indexOf("private build("));
  assert.ok(run.indexOf("assertAuthorized(") < run.indexOf("assertNetworkAllowed(") && run.indexOf("assertNetworkAllowed(") < run.indexOf("this.execute()"), "Agent.run : garde-fous avant execute()");
  // syncClock (seule requête du cœur vers le site) n'est appelée que depuis execute(), donc après run()
  assert.equal([...agent.matchAll(/this\.syncClock\(\)/g)].length, 2);
  assert.ok(agent.indexOf("await this.syncClock()") > agent.indexOf("private async execute()"));
});

test("le seul point qui contacte une page du site hors adaptateur (en-tête Date) reçoit l'URL de l'événement déjà validée par les garde-fous", () => {
  const agent = code.get("src/agent/Agent.ts")!;
  assert.match(agent, /httpDateServerTime\(adapter\.resolveEventUrl\(config\)\)/);
  assert.deepEqual(filesMatching(/httpDateServerTime\(/), ["src/agent/Agent.ts", "src/utils/clock.ts"]);
});

test("cas de contrôle : l'API passe par ApiClient (hôte verrouillé) — un client ne peut pas être créé sans liste d'hôtes, ni viser un hôte hors liste", () => {
  const f = fakeApi().fetchImpl;
  assert.throws(() => new ApiClient({ baseUrl: "https://api.p.example/v1", fetchImpl: f } as never), /allowedHosts/);
  assert.throws(() => new ApiClient({ baseUrl: "https://api.p.example/v1", allowedHosts: [], fetchImpl: f }), /allowedHosts/);
  assert.throws(() => new ApiClient({ baseUrl: "https://api.p.example/v1", allowedHosts: ["autre.example"], fetchImpl: f }), /n'est pas dans allowedHosts/);
  assert.deepEqual(new ApiClient({ baseUrl: "https://api.p.example/v1", allowedHosts: ["API.P.EXAMPLE"], fetchImpl: f }).hosts, ["api.p.example"]);
  const ctx = createApiContext({} as BotConfig, silentLogger, {});
  assert.throws(() => (ctx.page as unknown as { goto: () => void }).goto(), /aucun navigateur/);
  void FakeAdapter;
});
