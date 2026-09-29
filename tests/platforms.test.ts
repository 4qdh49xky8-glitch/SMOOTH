import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
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
import { adapterVerdict, checkCatalogIntegrity, loadCatalog, parseCatalog, type Catalog, type Platform } from "../src/platforms/catalog.js";
import { SelectorResolver } from "../src/selectors/resolver.js";
import { checkAdapterContract } from "../src/sites/contract.js";
import type { AdapterMeta, SiteAdapter } from "../src/sites/SiteAdapter.js";
import { Clock } from "../src/utils/clock.js";
import { silentLogger } from "../src/utils/logger.js";
import { FakeAdapter, offer } from "./helpers/fakeAdapter.js";

const TODAY = new Date().toISOString().slice(0, 10);
const NOW = Date.parse(`${TODAY}T12:00:00Z`);
const ev = (host: string, path = "/cgu", date = TODAY) => ({ url: `https://${host}${path}`, verifiedAt: date, excerpt: "Passage FICTIF de test cité tel quel depuis la page officielle." });

/** Plateforme FICTIVE de test (jamais une vraie plateforme) : sert uniquement à exercer la logique. */
function platform(over: Partial<Platform> & { id?: string } = {}): Platform {
  const id = over.id ?? "plateforme-test";
  return {
    id, name: "Plateforme de test", regions: ["FR"], eventTypes: ["concert"], officialHosts: [`${id}.example`],
    verification: { status: "VERIFIE", verifiedAt: TODAY },
    officialApi: { status: "open-transactional", evidence: ev(`${id}.example`, "/api") },
    automation: { status: "permitted-both", evidence: ev(`${id}.example`) },
    queue: { status: "unknown" }, purchaseLimits: { status: "unknown" }, cart: { status: "unknown" }, clues: [],
    ...over,
  };
}
const catalogOf = (...p: Platform[]): Catalog => ({ schemaVersion: 1, platforms: p });

function adapter(id: string, o: { platform?: string; channel?: "official-api" | "browser"; policy?: "official-api" | "permitted-by-terms" | "demo"; env?: string[] }): SiteAdapter {
  const a = new FakeAdapter();
  const policy = o.policy ?? (o.channel === "official-api" ? "official-api" : "permitted-by-terms");
  a.meta = {
    ...a.meta, id, platform: o.platform, channel: o.channel,
    compliance: policy === "demo" ? a.meta.compliance : { policy, termsUrl: "https://plateforme-test.example/cgu", reviewedAt: TODAY },
    capabilities: { ...a.meta.capabilities, officialApi: o.channel === "official-api" },
    requires: o.env ? { env: o.env } : undefined,
  } as AdapterMeta;
  return a;
}
const resolve = (site: string, adapters: SiteAdapter[], cat: Catalog, env: NodeJS.ProcessEnv = {}, channel: "auto" | "official-api" | "browser" | "human" = "auto") =>
  resolveChannel({ platform: site, adapters, catalog: cat, env, config: { channel }, now: NOW });

// ───────────────────────────── catalogue ─────────────────────────────
test("catalogue livré : cohérent, alphabétique, couvre tous les types d'événements — et AUCUNE plateforme n'est vérifiée", () => {
  const c = loadCatalog();
  assert.deepEqual(checkCatalogIntegrity(c), []);
  const ids = c.platforms.map((p) => p.id);
  assert.deepEqual(ids, [...ids].sort(), "ordre alphabétique : aucun classement");
  for (const t of ["concert", "festival", "spectacle", "theatre", "sport", "grand-evenement"]) assert.ok(c.platforms.some((p) => p.eventTypes.includes(t as never)), t);
  for (const p of c.platforms) {
    assert.equal(p.verification.status, "NON_VERIFIE", `${p.id} déclarée vérifiée sans avoir été lue`);
    assert.equal(adapterVerdict(p).verdict, "NON_VERIFIE");
    for (const f of [p.officialApi, p.automation, p.queue, p.purchaseLimits, p.cart]) assert.equal(f.status, "unknown");
    for (const cl of p.clues) {
      assert.equal(cl.verified, false);
      const h = new URL(cl.url).hostname;
      assert.ok(p.officialHosts.some((o) => h === o || h.endsWith(`.${o}`)), `${p.id} : piste hors domaine officiel (${h})`);
    }
  }
});

test("catalogue : une valeur autre que « unknown » EXIGE une preuve officielle datée, https, citée, sur un domaine officiel", () => {
  const bad = (mut: (p: Platform) => void): string => {
    const p = platform();
    mut(p);
    try {
      parseCatalog({ schemaVersion: 1, platforms: [p] });
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };
  assert.equal(bad(() => undefined), "", "la plateforme de test valide passe");
  assert.match(bad((p) => (p.automation = { status: "prohibited" })), /exige une preuve/);
  assert.match(bad((p) => (p.automation = { status: "prohibited", evidence: { ...ev("plateforme-test.example"), url: "http://plateforme-test.example/cgu" } })), /https/);
  assert.match(bad((p) => (p.automation = { status: "prohibited", evidence: { ...ev("plateforme-test.example"), excerpt: "trop court" } })), /passage lu/);
  assert.match(bad((p) => (p.automation = { status: "prohibited", evidence: ev("site-tiers.example") })), /hors des domaines officiels/);
  assert.match(bad((p) => (p.verification = { status: "VERIFIE" })), /sans date/);
  assert.match(bad((p) => (p.automation = { status: "unknown" })), /inconnu/);
});

test("verdicts déduits des seules preuves : interdit, silence, interface, API, les deux, API réservée aux partenaires, preuve périmée", () => {
  const v = (over: Partial<Platform>, now = NOW) => adapterVerdict(platform(over), now);
  const a = (status: Platform["automation"]["status"]) => ({ automation: { status, evidence: ev("plateforme-test.example") } as Platform["automation"] });
  assert.equal(v(a("prohibited")).verdict, "NON_AUTORISE");
  assert.equal(v(a("not-addressed")).verdict, "MANUEL_SEULEMENT", "le silence n'est PAS une autorisation");
  assert.deepEqual(v({ ...a("permitted-interface"), officialApi: { status: "none", evidence: ev("plateforme-test.example") } }), { verdict: "BROWSER", channels: ["browser"], reasons: [expectedReason("browser")] });
  assert.deepEqual(v(a("permitted-api")).channels, ["official-api"]);
  assert.equal(v(a("permitted-api")).verdict, "API_FIRST");
  assert.deepEqual(v(a("permitted-both")).channels, ["official-api", "browser"]);
  assert.equal(v({ ...a("permitted-api"), officialApi: { status: "partner-only", evidence: ev("plateforme-test.example") } }).verdict, "MANUEL_SEULEMENT", "API réservée aux partenaires : inutilisable");
  assert.equal(v({ ...a("permitted-api"), officialApi: { status: "read-only", evidence: ev("plateforme-test.example") } }).verdict, "MANUEL_SEULEMENT", "API en lecture seule : rien à acheter");
  assert.equal(adapterVerdict(platform(), NOW + 200 * 86_400_000).verdict, "NON_VERIFIE", "preuve de plus de 180 jours : à revérifier");
  assert.equal(adapterVerdict(platform({ verification: { status: "NON_VERIFIE" } }), NOW).verdict, "NON_VERIFIE");
});
const expectedReason = (c: string): string => `canaux autorisés par les preuves : ${c}`;

// ───────────────────────────── autorisation d'un adaptateur ─────────────────────────────
test("autorisation : démo exemptée ; plateforme absente, non vérifiée, canal non permis ou politique incohérente → refus", () => {
  const cat = catalogOf(platform({ id: "p-api", automation: { status: "permitted-api", evidence: ev("p-api.example") } }), platform({ id: "p-non", automation: { status: "prohibited", evidence: ev("p-non.example") } }));
  assert.equal(authorizeAdapter(adapter("d", { policy: "demo" }).meta, cat, NOW).ok, true);
  assert.match(authorizeAdapter(adapter("a", { platform: "inconnue", channel: "browser" }).meta, cat, NOW).reason!, /absente du catalogue/);
  assert.equal(authorizeAdapter(adapter("a", { platform: "p-api", channel: "official-api" }).meta, cat, NOW).ok, true);
  assert.match(authorizeAdapter(adapter("b", { platform: "p-api", channel: "browser" }).meta, cat, NOW).reason!, /canal « browser » non autorisé/, "l'API est permise, pas le pilotage de l'interface");
  assert.match(authorizeAdapter(adapter("c", { platform: "p-non", channel: "browser" }).meta, cat, NOW).reason!, /NON_AUTORISE/);
  assert.match(authorizeAdapter(adapter("e", { platform: "p-api", channel: "official-api", policy: "permitted-by-terms" }).meta, cat, NOW).reason!, /incohérente/);
});

// ───────────────────────────── choix automatique du canal ─────────────────────────────
test("canal : API officielle d'abord, puis navigateur, puis humain — selon ce que les adaptateurs déclarent ET ce que les preuves autorisent", () => {
  const both = catalogOf(platform({ id: "p" }));
  const api = adapter("p-api", { platform: "p", channel: "official-api", env: ["P_API_KEY"] });
  const web = adapter("p-web", { platform: "p", channel: "browser" });
  const order = (xs: SiteAdapter[]): SiteAdapter[] => xs;

  // 1. clé d'API présente → API, quel que soit l'ordre de déclaration
  for (const list of [order([api, web]), order([web, api])]) {
    const d = resolve("p", list, both, { P_API_KEY: "x" });
    assert.equal(d.channel, "official-api");
    assert.equal(d.adapter, api);
  }
  // 2. clé absente → repli sur le navigateur, avec la raison
  const d2 = resolve("p", [api, web], both, {});
  assert.equal(d2.channel, "browser");
  assert.equal(d2.rejected[0]!.channel, "official-api");
  assert.match(d2.rejected[0]!.reason, /P_API_KEY/);
  // 3. seule l'interface est permise → navigateur, l'API est écartée
  const onlyUi = catalogOf(platform({ id: "p", automation: { status: "permitted-interface", evidence: ev("p.example") } }));
  assert.equal(resolve("p", [api, web], onlyUi, { P_API_KEY: "x" }).channel, "browser");
  // 4. seule l'API est permise → l'adaptateur navigateur est refusé
  const onlyApi = catalogOf(platform({ id: "p", automation: { status: "permitted-api", evidence: ev("p.example") } }));
  assert.equal(resolve("p", [api, web], onlyApi, { P_API_KEY: "x" }).channel, "official-api");
  const d4 = resolve("p", [web], onlyApi);
  assert.equal(d4.channel, "human");
  assert.match(d4.rejected[0]!.reason, /non autorisé/);
});

test("canal : automatisation interdite, silencieuse ou non vérifiée → intervention humaine ; jamais d'automatisation par défaut", () => {
  const web = adapter("p-web", { platform: "p", channel: "browser" });
  const api = adapter("p-api", { platform: "p", channel: "official-api" });
  const st = (status: Platform["automation"]["status"]) => catalogOf(platform({ id: "p", automation: { status, evidence: ev("p.example") } }));
  for (const s of ["prohibited", "not-addressed"] as const) {
    const d = resolve("p", [api, web], st(s), {});
    assert.equal(d.channel, "human", s);
    assert.equal(d.adapter, undefined);
    assert.equal(d.rejected.length, 2, "les deux adaptateurs sont écartés, avec leurs raisons");
  }
  assert.equal(resolve("p", [api, web], catalogOf(platform({ id: "p", verification: { status: "NON_VERIFIE" } })), {}).channel, "human");
  assert.equal(resolve("p", [api, web], catalogOf(), {}).channel, "human", "plateforme absente du catalogue");
  const noAdapter = resolve("ticketmaster", [], loadCatalog(), {});
  assert.equal(noAdapter.channel, "human");
  assert.match(noAdapter.reasons[0]!, /aucun adaptateur/);
});

test("canal : la démo est exemptée du catalogue ; un canal forcé ne peut jamais être plus permissif", () => {
  const demo = adapter("example", { policy: "demo" });
  assert.equal(resolve("example", [demo], catalogOf(), {}).channel, "browser");
  const cat = catalogOf(platform({ id: "p", automation: { status: "permitted-interface", evidence: ev("p.example") } }));
  const web = adapter("p-web", { platform: "p", channel: "browser" });
  const api = adapter("p-api", { platform: "p", channel: "official-api" });
  assert.equal(resolve("p", [api, web], cat, {}, "browser").channel, "browser");
  assert.equal(resolve("p", [api, web], cat, {}, "human").channel, "human");
  assert.throws(() => resolve("p", [api, web], cat, {}, "official-api"), /Canal « official-api » indisponible/);
  assert.throws(() => resolve("p", [web], catalogOf(), {}, "browser"), /absente du catalogue/);
});

// ───────────────────────────── garde-fou du cœur et contrat ─────────────────────────────
test("le contrat exige une autorisation du catalogue pour tout adaptateur non-démo", () => {
  const cat = catalogOf(platform({ id: "p", automation: { status: "permitted-interface", evidence: ev("p.example") } }));
  const codes = (a: SiteAdapter): string[] => checkAdapterContract(a, { catalog: cat, now: NOW }).filter((i) => i.severity === "error").map((i) => i.code);
  assert.ok(!codes(adapter("p-web", { platform: "p", channel: "browser" })).includes("PLATFORM_AUTH"));
  assert.ok(codes(adapter("x-web", { platform: "inconnue", channel: "browser" })).includes("PLATFORM_AUTH"));
  assert.ok(codes(adapter("p-api", { platform: "p", channel: "official-api" })).includes("PLATFORM_AUTH"));
  assert.ok(!codes(adapter("d", { policy: "demo" })).includes("PLATFORM_AUTH"));
});

function agentFor(a: FakeAdapter, catalog?: Catalog) {
  const config = ConfigSchema.parse({
    site: "p", event: { name: "T", url: "https://p.example/event" }, sale: { startTime: new Date(Date.now() - 1000).toISOString() },
    tickets: { quantity: 2, maxPricePerTicket: 150 }, timing: { preArmSeconds: 0, maxWaitAfterSaleSeconds: 2 },
    notifications: { desktop: false, sound: false }, telemetry: { enabled: false },
  });
  return new Agent({
    config, adapter: a, catalog, claude: new ClaudeAssistant(config.claude, silentLogger), log: silentLogger, clock: new Clock(), notifier: async () => undefined,
    ctx: { config, context: {} as never, page: { bringToFront: async () => undefined } as never, log: silentLogger, env: {}, selectors: new SelectorResolver("fake", "/nonexistent/x.json") },
  });
}

test("le cœur refuse d'agir pour un adaptateur dont la plateforme n'est pas autorisée par des preuves — avant tout appel au site", async () => {
  const web = adapter("p-web", { platform: "p", channel: "browser" }) as FakeAdapter;
  web.offers = [offer({ id: "a" })];
  // catalogue par défaut (aucune plateforme vérifiée, « p » absente) : refus
  await assert.rejects(agentFor(web).run(), /absente du catalogue/);
  // plateforme présente mais non vérifiée : refus
  await assert.rejects(agentFor(web, catalogOf(platform({ id: "p", verification: { status: "NON_VERIFIE" } }))).run(), /NON_VERIFIE/);
  // plateforme dont les conditions interdisent : refus
  await assert.rejects(agentFor(web, catalogOf(platform({ id: "p", automation: { status: "prohibited", evidence: ev("p.example") } }))).run(), /NON_AUTORISE/);
  assert.deepEqual(web.calls, [], "aucun appel au site dans aucun des trois cas");
  // preuves valides : l'exécution est possible (la démo ne suffit pas, c'est la preuve qui autorise)
  const ok = await agentFor(web, catalogOf(platform({ id: "p", automation: { status: "permitted-interface", evidence: ev("p.example") } }))).run();
  assert.equal(ok.finalState, "CART_SUCCESS");
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
    assert.equal(notes.length, 3);
    assert.match(notes[2]!.title, /OUVERTURE DE LA VENTE/);
    assert.ok(notes[0]!.message.includes("Concert de test") && notes[0]!.message.includes("2 billet(s)"));
    assert.ok(!notes.some((n) => n.message.includes("CANARY_TOKEN")), "les paramètres d'URL ne sont jamais réaffichés");
    assert.equal(network, 0, "aucune requête réseau");
    assert.ok(clock.now() >= sale, "le dernier rappel n'est pas envoyé avant l'ouverture");
    // rappels déjà passés : ignorés
    const late = await runHumanAssist({ eventName: "x", saleEpochMs: clock.now() + 250, clock, log: silentLogger, reason: "t", remindersMs: [600, 300, 0], notifier: async () => undefined });
    assert.deepEqual(late.fired, [0]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ───────────────────────────── commandes ─────────────────────────────
const cfgFile = (site: string, extra: Record<string, unknown> = {}): string => {
  const f = join(mkdtempSync(join(tmpdir(), "plat-")), "canal-test.json");
  writeFileSync(f, JSON.stringify({ site, event: { name: "e", url: "https://billetterie.example/e" }, sale: { startTime: new Date(Date.now() + 700).toISOString() }, tickets: { quantity: 2, maxPricePerTicket: 50 }, notifications: { desktop: false, sound: false }, telemetry: { enabled: false }, ...extra }));
  return f;
};

test("validate : une plateforme du catalogue sans adaptateur → canal humain (avertissement) ; site inconnu partout ou canal forcé impossible → erreur", async () => {
  const human = await validateConfig(cfgFile("ticketmaster"), { now: NOW, env: {} });
  assert.equal(human.ok, true, human.errors.join("; "));
  assert.ok(human.warnings.some((w) => /canal humain/.test(w)));
  assert.ok(human.info.some((i) => /canal retenu : human/.test(i)));
  const unknown = await validateConfig(cfgFile("nexiste-nulle-part"), { now: NOW, env: {} });
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors.join(" "), /aucun adaptateur et absent du catalogue/);
  const forced = await validateConfig(cfgFile("ticketmaster", { channel: "browser" }), { now: NOW, env: {} });
  assert.equal(forced.ok, false);
  assert.match(forced.errors.join(" "), /Canal « browser » indisponible/);
});

test("run en canal humain : aucun navigateur lancé, aucun profil créé, aucun verrou, code de sortie 0", async () => {
  const file = cfgFile("ticketmaster");
  const started = Date.now();
  const code = await main(["run", "--config", file, "--log-level", "error"]);
  assert.equal(code, 0);
  assert.ok(Date.now() - started < 4000);
  assert.equal(existsSync(join(".profile", "canal-test")), false, "aucun navigateur/profil créé");
});

test("commande platforms : 24 plateformes non vérifiées, --check et --hosts", async () => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (m?: unknown) => void lines.push(String(m));
  try {
    assert.equal(await main(["platforms", "--json"]), 0);
    const rows = JSON.parse(lines.join("\n")) as { id: string; verdict: string; sources: string[]; clues: number }[];
    assert.equal(rows.length, 24);
    assert.ok(rows.every((r) => r.verdict === "NON_VERIFIE" && r.sources.length === 0));
    assert.ok(rows.find((r) => r.id === "ticketmaster")!.clues >= 3);
    lines.length = 0;
    assert.equal(await main(["platforms", "--hosts"]), 0);
    assert.ok(lines.join("\n").split("\n").includes("developer.ticketmaster.com"));
    lines.length = 0;
    assert.equal(await main(["platforms", "--check"]), 0);
    assert.ok(lines.join("\n").includes("catalogue cohérent"));
  } finally {
    console.log = log;
  }
});
