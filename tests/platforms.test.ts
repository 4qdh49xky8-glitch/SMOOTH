import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Agent } from "../src/agent/Agent.js";
import { ClaudeAssistant } from "../src/agent/claude.js";
import { resolveChannel } from "../src/agent/channels.js";
import { runHumanAssist } from "../src/agent/humanAssist.js";
import { validateConfig } from "../src/config/validate.js";
import { ConfigSchema } from "../src/config/schema.js";
import { main } from "../src/index.js";
import { authorizeAdapter } from "../src/platforms/authorize.js";
import { STATUSES, checkCatalogIntegrity, loadCatalog, type Catalog } from "../src/platforms/catalog.js";
import { SelectorResolver } from "../src/selectors/resolver.js";
import { checkAdapterContract } from "../src/sites/contract.js";
import type { SiteAdapter } from "../src/sites/SiteAdapter.js";
import { Clock } from "../src/utils/clock.js";
import { silentLogger } from "../src/utils/logger.js";
import { FakeAdapter, offer } from "./helpers/fakeAdapter.js";
import { DAY, NOW, adapter, catalogWith, daysAgo, ev, plat } from "./helpers/platformFixtures.js";

const resolve = (site: string, adapters: SiteAdapter[], cat: Catalog, env: NodeJS.ProcessEnv = {}, channel: "auto" | "official-api" | "browser" | "human" = "auto", now = NOW) =>
  resolveChannel({ platform: site, adapters, catalog: cat, env, config: { channel }, now });

// ───────────────────────────── catalogue statique ─────────────────────────────
test("catalogue livré : données statiques cohérentes, ordre alphabétique, tous les types d'événements, AUCUNE autorisation dans le fichier", () => {
  const c = loadCatalog();
  assert.deepEqual(checkCatalogIntegrity(c), []);
  const ids = c.platforms.map((p) => p.id);
  assert.deepEqual(ids, [...ids].sort(), "ordre alphabétique : aucun classement");
  for (const t of ["concert", "festival", "spectacle", "theatre", "sport", "grand-evenement"]) assert.ok(c.platforms.some((p) => p.eventTypes.includes(t as never)), t);
  for (const p of c.platforms) {
    for (const cl of p.clues) assert.equal(cl.verified, false);
    assert.deepEqual(Object.keys(p).sort(), ["clues", "eventTypes", "id", "name", "officialHosts", "regions"], `${p.id} : le catalogue ne doit contenir que des données statiques`);
  }
  assert.deepEqual([...STATUSES], ["NOT_VERIFIED", "VERIFIED_API", "VERIFIED_BROWSER", "VERIFIED_API_AND_BROWSER", "NOT_ALLOWED", "EXPIRED"]);
});

// ───────────────────────────── autorisation d'un adaptateur ─────────────────────────────
test("autorisation : démo exemptée ; NOT_VERIFIED, EXPIRED, NOT_ALLOWED, absente, canal non permis, politique incohérente → refus", () => {
  const cat = catalogWith(
    [plat("pa"), plat("pb"), plat("pboth"), plat("pno"), plat("pexp"), plat("pnone")],
    [ev("pa", "api"), ev("pb", "browser"), ev("pboth", "both"), ev("pno", "human"), ev("pexp", "both", daysAgo(181))],
  );
  const ok = (a: FakeAdapter): boolean => authorizeAdapter(a.meta, cat, NOW).ok;
  const why = (a: FakeAdapter): string => authorizeAdapter(a.meta, cat, NOW).reason ?? "";
  assert.equal(ok(adapter("d", { policy: "demo" })), true);
  assert.equal(ok(adapter("x", { platform: "pa", channel: "official-api" })), true);
  assert.equal(ok(adapter("x", { platform: "pb", channel: "browser" })), true);
  assert.equal(ok(adapter("x", { platform: "pboth", channel: "official-api" })), true);
  assert.equal(ok(adapter("x", { platform: "pboth", channel: "browser" })), true);
  assert.match(why(adapter("x", { platform: "pa", channel: "browser" })), /VERIFIED_API.*canal « browser » non autorisé/, "l'API est permise, pas l'interface");
  assert.match(why(adapter("x", { platform: "pb", channel: "official-api" })), /VERIFIED_BROWSER.*canal « official-api » non autorisé/);
  assert.match(why(adapter("x", { platform: "pno", channel: "browser" })), /NOT_ALLOWED/);
  assert.match(why(adapter("x", { platform: "pexp", channel: "browser" })), /EXPIRED/);
  assert.match(why(adapter("x", { platform: "pnone", channel: "browser" })), /NOT_VERIFIED/);
  assert.match(why(adapter("x", { platform: "inconnue", channel: "browser" })), /absente du catalogue/);
  assert.match(why(adapter("x", { platform: "pa", channel: "official-api", policy: "permitted-by-terms" })), /incohérente/);
});

// ───────────────────────────── choix automatique du canal ─────────────────────────────
test("canal : API officielle → navigateur → humain, selon les adaptateurs déclarés ET les preuves", () => {
  const both = catalogWith([plat("p")], [ev("p", "both")]);
  const api = adapter("p-api", { platform: "p", channel: "official-api", env: ["P_API_KEY"] });
  const web = adapter("p-web", { platform: "p", channel: "browser" });
  for (const list of [[api, web], [web, api]]) {
    const d = resolve("p", list, both, { P_API_KEY: "x" });
    assert.equal(d.channel, "official-api");
    assert.equal(d.adapter, api);
    assert.equal(d.status, "VERIFIED_API_AND_BROWSER");
  }
  const d2 = resolve("p", [api, web], both, {});
  assert.equal(d2.channel, "browser");
  assert.match(d2.rejected[0]!.reason, /P_API_KEY/);
  assert.equal(resolve("p", [api, web], catalogWith([plat("p")], [ev("p", "browser")]), { P_API_KEY: "x" }).channel, "browser");
  assert.equal(resolve("p", [api, web], catalogWith([plat("p")], [ev("p", "api")]), { P_API_KEY: "x" }).channel, "official-api");
  const d4 = resolve("p", [web], catalogWith([plat("p")], [ev("p", "api")]));
  assert.equal(d4.channel, "human");
  assert.match(d4.rejected[0]!.reason, /non autorisé/);
});

test("canal : NOT_VERIFIED, EXPIRED ou NOT_ALLOWED → intervention humaine, jamais d'automatisation par défaut", () => {
  const web = adapter("p-web", { platform: "p", channel: "browser" });
  const api = adapter("p-api", { platform: "p", channel: "official-api" });
  const cases: [string, Catalog][] = [
    ["NOT_VERIFIED", catalogWith([plat("p")])],
    ["EXPIRED", catalogWith([plat("p")], [ev("p", "both", daysAgo(181))])],
    ["NOT_ALLOWED", catalogWith([plat("p")], [ev("p", "human")])],
    ["absente", catalogWith([])],
  ];
  for (const [label, cat] of cases) {
    const d = resolve("p", [api, web], cat, { P_API_KEY: "x" });
    assert.equal(d.channel, "human", label);
    assert.equal(d.adapter, undefined, label);
  }
  const noAdapter = resolve("ticketmaster", [], loadCatalog(), {});
  assert.equal(noAdapter.channel, "human");
  assert.equal(noAdapter.status, "NOT_VERIFIED");
  assert.match(noAdapter.reasons[0]!, /aucun adaptateur/);
});

test("canal : l'expiration est appliquée À L'INSTANT du run ; un canal forcé ne peut jamais être plus permissif", () => {
  const web = adapter("p-web", { platform: "p", channel: "browser" });
  const cat = catalogWith([plat("p")], [ev("p", "browser")]);
  assert.equal(resolve("p", [web], cat, {}, "auto", NOW + 180 * DAY).channel, "browser");
  assert.equal(resolve("p", [web], cat, {}, "auto", NOW + 181 * DAY).channel, "human", "la preuve a expiré : plus d'automatisation");
  assert.equal(resolve("p", [web], cat, {}, "browser").channel, "browser");
  assert.equal(resolve("p", [web], cat, {}, "human").channel, "human");
  assert.throws(() => resolve("p", [web], cat, {}, "official-api"), /Canal « official-api » indisponible/);
  assert.throws(() => resolve("p", [web], cat, {}, "browser", NOW + 181 * DAY), /EXPIRED/);
  assert.equal(resolve("example", [adapter("example", { policy: "demo" })], catalogWith([]), {}).channel, "browser", "la démo est exemptée du catalogue");
});

// ───────────────────────────── contrat et garde-fou du cœur ─────────────────────────────
test("le contrat exige une autorisation du catalogue pour tout adaptateur non-démo", () => {
  const cat = catalogWith([plat("p")], [ev("p", "browser")]);
  const codes = (a: SiteAdapter): string[] => checkAdapterContract(a, { catalog: cat, now: NOW }).filter((i) => i.severity === "error").map((i) => i.code);
  assert.ok(!codes(adapter("p-web", { platform: "p", channel: "browser" })).includes("PLATFORM_AUTH"));
  assert.ok(codes(adapter("x-web", { platform: "inconnue", channel: "browser" })).includes("PLATFORM_AUTH"));
  assert.ok(codes(adapter("p-api", { platform: "p", channel: "official-api" })).includes("PLATFORM_AUTH"));
  assert.ok(!codes(adapter("d", { policy: "demo" })).includes("PLATFORM_AUTH"));
});

function agentFor(a: FakeAdapter, catalog: Catalog, now?: number) {
  const config = ConfigSchema.parse({
    site: "p", event: { name: "T", url: "https://p.example/event" }, sale: { startTime: new Date(Date.now() - 1000).toISOString() },
    tickets: { quantity: 2, maxPricePerTicket: 150 }, timing: { preArmSeconds: 0, maxWaitAfterSaleSeconds: 2 },
    notifications: { desktop: false, sound: false }, telemetry: { enabled: false },
  });
  void now;
  return new Agent({
    config, adapter: a, catalog, claude: new ClaudeAssistant(config.claude, silentLogger), log: silentLogger, clock: new Clock(), notifier: async () => undefined,
    ctx: { config, context: {} as never, page: { bringToFront: async () => undefined } as never, log: silentLogger, env: {}, selectors: new SelectorResolver("fake", "/nonexistent/x.json") },
  });
}

test("le cœur refuse d'agir sans preuve valide (NOT_VERIFIED, EXPIRED, NOT_ALLOWED) — avant tout appel au site", async () => {
  const web = adapter("p-web", { platform: "p", channel: "browser" });
  web.offers = [offer({ id: "a" })];
  const refusals: [Catalog, RegExp][] = [
    [catalogWith([plat("p")]), /NOT_VERIFIED/],
    [catalogWith([plat("p")], [ev("p", "browser", daysAgo(181))]), /EXPIRED/],
    [catalogWith([plat("p")], [ev("p", "human")]), /NOT_ALLOWED/],
    [catalogWith([]), /absente du catalogue/],
  ];
  for (const [cat, re] of refusals) await assert.rejects(agentFor(web, cat).run(), re);
  assert.deepEqual(web.calls, [], "aucun appel au site dans aucun cas");
  const ok = await agentFor(web, catalogWith([plat("p")], [ev("p", "browser")])).run();
  assert.equal(ok.finalState, "CART_SUCCESS", "c'est la preuve valide, et elle seule, qui autorise");
});

// ───────────────────────────── canal humain ─────────────────────────────
test("canal humain : uniquement des rappels aux bons instants, AUCUN contact avec le site", async () => {
  const realFetch = globalThis.fetch;
  let network = 0;
  globalThis.fetch = (async () => void network++) as never;
  try {
    const notes: { title: string; message: string }[] = [];
    const clock = new Clock();
    const sale = clock.now() + 900;
    const res = await runHumanAssist({
      eventName: "Concert de test", eventUrl: "https://p.example/event?token=CANARY_TOKEN_9f8e7d6c5b4a", saleEpochMs: sale, clock, log: silentLogger,
      reason: "test", remindersMs: [600, 300, 0], quantity: 2, maxPricePerTicket: 120, notifier: async (n) => void notes.push(n),
    });
    assert.deepEqual(res.fired, [600, 300, 0]);
    assert.match(notes[2]!.title, /OUVERTURE DE LA VENTE/);
    assert.ok(!notes.some((n) => n.message.includes("CANARY_TOKEN")), "les paramètres d'URL ne sont jamais réaffichés");
    assert.equal(network, 0, "aucune requête réseau");
    const late = await runHumanAssist({ eventName: "x", saleEpochMs: clock.now() + 250, clock, log: silentLogger, reason: "t", remindersMs: [600, 300, 0], notifier: async () => undefined });
    assert.deepEqual(late.fired, [0]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ───────────────────────────── validate / run / platforms ─────────────────────────────
const cfgFile = (site: string, extra: Record<string, unknown> = {}, saleInMs = 700): string => {
  const f = join(mkdtempSync(join(tmpdir(), "plat-")), "canal-test.json");
  writeFileSync(f, JSON.stringify({ site, event: { name: "e", url: "https://billetterie.example/e" }, sale: { startTime: new Date(Date.now() + saleInMs).toISOString() }, tickets: { quantity: 2, maxPricePerTicket: 50 }, notifications: { desktop: false, sound: false }, telemetry: { enabled: false }, ...extra }));
  return f;
};

test("validate : plateforme du catalogue sans adaptateur → canal humain (avertissement) ; inconnue partout ou canal forcé impossible → erreur", async () => {
  const human = await validateConfig(cfgFile("ticketmaster"), { now: NOW, env: {} });
  assert.equal(human.ok, true, human.errors.join("; "));
  assert.ok(human.warnings.some((w) => /canal humain/.test(w)));
  const unknown = await validateConfig(cfgFile("nexiste-nulle-part"), { now: NOW, env: {} });
  assert.match(unknown.errors.join(" "), /aucun adaptateur et absent du catalogue/);
  const forced = await validateConfig(cfgFile("ticketmaster", { channel: "browser" }), { now: NOW, env: {} });
  assert.match(forced.errors.join(" "), /Canal « browser » indisponible/);
});

test("commande platforms --json : export versionné, complet et exploitable par d'autres outils", async () => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (m?: unknown) => void lines.push(String(m));
  try {
    assert.equal(await main(["platforms", "--json"]), 0);
  } finally {
    console.log = log;
  }
  const out = JSON.parse(lines.join("\n")) as {
    schemaVersion: number; generatedAt: string; evidenceMaxAgeDays: number; statuses: string[];
    platforms: { id: string; status: string; allowedChannels: string[]; expiresAt: string | null; history: unknown[]; missing: { topic: string; blocking: boolean }[]; adapters: unknown[]; unverifiedClues: unknown[]; officialHosts: string[]; eventTypes: string[] }[];
    rejectedEvidence: unknown[];
  };
  assert.equal(out.schemaVersion, 2);
  assert.equal(out.evidenceMaxAgeDays, 180);
  assert.ok(!Number.isNaN(Date.parse(out.generatedAt)));
  assert.deepEqual(out.statuses, [...STATUSES]);
  assert.equal(out.platforms.length, loadCatalog().platforms.length);
  for (const p of out.platforms) {
    assert.ok(STATUSES.includes(p.status as never));
    for (const k of ["allowedChannels", "expiresAt", "history", "missing", "adapters", "unverifiedClues", "officialHosts", "eventTypes"]) assert.ok(k in p, `${p.id}.${k}`);
  }
  const tm = out.platforms.find((p) => p.id === "ticketmaster")!;
  assert.deepEqual(tm.missing[0], { topic: "automation", blocking: true, reason: "aucune preuve" });
  assert.ok(tm.unverifiedClues.length >= 3);
  assert.deepEqual(out.rejectedEvidence, []);
});

test("commandes platforms --check, --hosts, --markdown", async () => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (m?: unknown) => void lines.push(String(m));
  try {
    assert.equal(await main(["platforms", "--hosts"]), 0);
    assert.ok(lines.join("\n").split("\n").includes("developer.ticketmaster.com"));
    lines.length = 0;
    assert.equal(await main(["platforms", "--check"]), 0);
    assert.ok(lines.join("\n").includes("catalogue cohérent"));
    lines.length = 0;
    assert.equal(await main(["platforms", "--markdown"]), 0);
    assert.match(lines.join("\n"), /\| Plateforme \| Types d'événements \| API officielle \| Automatisation autorisée\/documentée \|/);
  } finally {
    console.log = log;
  }
});
