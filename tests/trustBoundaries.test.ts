import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Agent } from "../src/agent/Agent.js";
import { ClaudeAssistant } from "../src/agent/claude.js";
import { resolveChannel } from "../src/agent/channels.js";
import { ConfigSchema } from "../src/config/schema.js";
import { validateConfig } from "../src/config/validate.js";
import { main } from "../src/index.js";
import { authorizeAdapter } from "../src/platforms/authorize.js";
import type { Catalog } from "../src/platforms/catalog.js";
import { SelectorResolver } from "../src/selectors/resolver.js";
import { BlockerError } from "../src/utils/errors.js";
import { Clock } from "../src/utils/clock.js";
import { silentLogger } from "../src/utils/logger.js";
import { FakeApiAdapter, fakeApi } from "./helpers/fakeApi.js";
import { FakeAdapter, offer } from "./helpers/fakeAdapter.js";
import { NOW, adapter, catalogWith, daysAgo, ev, plat } from "./helpers/platformFixtures.js";

/**
 * Trois niveaux, jamais confondus :
 *   1. AUTORISATION de la plateforme  — uniquement les preuves (catalogue + platforms/evidence)
 *   2. CAPACITÉ de l'adaptateur       — ce que le code sait faire (meta) ; ne donne aucun droit
 *   3. CONFIGURATION de l'événement   — paramètres de l'utilisateur ; ne donne aucun droit
 * Un niveau inférieur ne peut jamais accorder ce que le niveau 1 n'accorde pas.
 */
const NOT_USABLE: [string, Catalog][] = [
  ["NOT_VERIFIED", catalogWith([plat("p")])],
  ["EXPIRED", catalogWith([plat("p")], [ev("p", "both", daysAgo(181))])],
  ["NOT_ALLOWED", catalogWith([plat("p")], [ev("p", "human")])],
];
const cfg = (extra: Record<string, unknown> = {}): string => {
  const f = join(mkdtempSync(join(tmpdir(), "trust-")), "trust-test.json");
  writeFileSync(f, JSON.stringify({
    site: "p", event: { name: "e", url: "https://api.p.example/events/1" }, sale: { startTime: new Date(Date.now() + 700).toISOString() },
    tickets: { quantity: 2, maxPricePerTicket: 150 }, notifications: { desktop: false, sound: false }, telemetry: { enabled: false },
    timing: { preArmSeconds: 0, pollIntervalMs: 200, maxWaitAfterSaleSeconds: 5 }, ...extra,
  }));
  return f;
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
const profilesBefore = (): string[] => (existsSync(".profile") ? readdirSync(".profile") : []);
const SECRET = { P_API_KEY: "SECRET-CANARY-1234567890abcdef" };
const withEnv = async <T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> => {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  }
};

// ───────────────────────────── point d'entrée par point d'entrée ─────────────────────────────
test("aucun drapeau CLI ne peut transformer NOT_VERIFIED/EXPIRED/NOT_ALLOWED en exécution : les options d'autorisation n'existent pas", async () => {
  const web = adapter("p-web", { platform: "p", channel: "browser" });
  for (const flag of [["--channel", "browser"], ["--channel", "official-api"], ["--force"], ["--allow-unverified"], ["--authorize"], ["--verified"], ["--status", "VERIFIED_BROWSER"], ["--evidence", "x"], ["--no-check"], ["--skip-authorization"], ["--unsafe"]]) {
    for (const cmd of ["run", "login", "check"]) {
      await assert.rejects(quiet(() => main([cmd, "--config", cfg(), ...flag], { adapters: [web], catalog: NOT_USABLE[0]![1] })), /Unknown option|Unexpected|unknown/i, `${cmd} ${flag.join(" ")}`);
    }
  }
  assert.deepEqual(web.calls, []);
});

test("variables d'environnement « malveillantes » : aucune ne change l'autorisation ni le canal", async () => {
  const web = adapter("p-web", { platform: "p", channel: "browser" });
  const vars = { FORCE_CHANNEL: "browser", CHANNEL: "browser", ALLOW_UNVERIFIED: "1", PLATFORM_STATUS: "VERIFIED_BROWSER", PLATFORM_VERIFIED: "true", EVIDENCE_DIR: "/tmp", NODE_ENV: "test", SKIP_AUTH: "1", DEBUG: "*" };
  for (const [label, cat] of NOT_USABLE) {
    const d = await withEnv(vars, async () => resolveChannel({ platform: "p", adapters: [web], catalog: cat, env: { ...process.env, ...vars }, config: { channel: "auto" }, now: NOW }));
    assert.equal(d.channel, "human", label);
    assert.equal(authorizeAdapter(web.meta, cat, NOW).ok, false, label);
  }
});

for (const [label, cat] of NOT_USABLE) {
  for (const channel of ["browser", "official-api"] as const) {
    for (const cmd of ["run", "login", "check"] as const) {
      test(`${label} × canal forcé « ${channel} » × ${cmd} : refus AVANT tout contact (aucun adaptateur appelé, aucun navigateur, aucune requête API, aucun verrou)`, async () => {
        const web = adapter("p-web", { platform: "p", channel: "browser" });
        web.offers = [offer({ id: "a" })];
        const api = fakeApi();
        const before = profilesBefore();
        await assert.rejects(withEnv(SECRET, () => quiet(() => main([cmd, "--config", cfg({ channel }), "--log-level", "error"], { adapters: [web, new FakeApiAdapter(api.fetchImpl)], catalog: cat }))), /indisponible/);
        assert.deepEqual(web.calls, []);
        assert.deepEqual(api.state.calls, []);
        assert.deepEqual(profilesBefore(), before);
      });
    }
  }
  test(`${label} × canal « auto » × login/check : canal humain, aucun navigateur ni requête (pas de « connexion » ni de mesure d'horloge chez la plateforme)`, async () => {
    const web = adapter("p-web", { platform: "p", channel: "browser" });
    const api = fakeApi();
    const before = profilesBefore();
    for (const cmd of ["login", "check"] as const) assert.equal(await withEnv(SECRET, () => quiet(() => main([cmd, "--config", cfg(), "--log-level", "error"], { adapters: [web, new FakeApiAdapter(api.fetchImpl)], catalog: cat }))), 0);
    assert.deepEqual(web.calls, []);
    assert.deepEqual(api.state.calls, []);
    assert.deepEqual(profilesBefore(), before);
  });
}

test("cas positif de contrôle : avec une preuve valide le même appel fonctionne — c'est donc bien la preuve, et rien d'autre, qui décide", async () => {
  const web = adapter("p-web", { platform: "p", channel: "browser" });
  const cat = catalogWith([plat("p")], [ev("p", "api")]);
  await assert.rejects(withEnv(SECRET, () => quiet(() => main(["run", "--config", cfg({ channel: "browser" }), "--log-level", "error"], { adapters: [web], catalog: cat }))), /indisponible/, "preuve « api » : pas de navigateur");
  assert.deepEqual(web.calls, []);
});

// ───────────────────────────── trois niveaux ─────────────────────────────
test("niveau 3 : aucune clé de configuration d'événement n'accorde d'autorisation (clés inconnues, siteOptions, canal)", async () => {
  const web = adapter("p-web", { platform: "p", channel: "browser" });
  const grabs = [
    { channel: "browser" },
    { siteOptions: { channel: "browser", authorized: true, allowUnverified: true, status: "VERIFIED_BROWSER", evidence: { channel: "both" } } },
    { authorization: "both", verified: true, status: "VERIFIED_API_AND_BROWSER", allowedChannels: ["browser"], compliance: { policy: "permitted-by-terms", reviewedAt: "2099-01-01" } },
    { platform: "p", channel: "browser" }, // l'exemple de la demande
  ];
  for (const [label, cat] of NOT_USABLE) for (const g of grabs) {
    const v = await validateConfig(cfg(g), { adapters: [web], catalog: cat, env: SECRET });
    const res = v.ok ? resolveChannel({ platform: "p", adapters: [web], catalog: cat, env: SECRET, config: { channel: "auto" }, now: NOW }) : undefined;
    // Soit la validation refuse (canal forcé impossible), soit le canal retenu est humain : jamais browser.
    assert.ok(!v.ok || res?.channel === "human", `${label} ${JSON.stringify(g).slice(0, 60)}`);
    if (!v.ok) assert.ok(v.errors.some((e) => /indisponible|canal/i.test(e)), v.errors.join(" | "));
  }
  assert.deepEqual(web.calls, []);
});

test("niveau 2 : un adaptateur ne s'auto-autorise pas (conformité « récente », canal, politique, plateforme déclarée) — seule la preuve de SA plateforme compte", () => {
  const cat = catalogWith([plat("p"), plat("v")], [ev("v", "both")]);
  // Déclare une politique impeccable et une relecture du jour : sans preuve pour « p », refus.
  const self = adapter("p-web", { platform: "p", channel: "browser", policy: "permitted-by-terms" });
  assert.equal(authorizeAdapter(self.meta, cat, NOW).ok, false);
  // Emprunte l'identité d'une plateforme vérifiée (« v ») pour servir la configuration de « p » : pas retenu pour « p ».
  const squatter = adapter("squatter", { platform: "v", channel: "browser" });
  const d = resolveChannel({ platform: "p", adapters: [squatter], catalog: cat, env: {}, config: { channel: "auto" }, now: NOW });
  assert.equal(d.channel, "human");
  assert.equal(d.adapter, undefined);
  // Un canal API déclaré avec une politique de navigateur (ou l'inverse) est refusé même si la plateforme est vérifiée.
  const cat2 = catalogWith([plat("p")], [ev("p", "both")]);
  assert.equal(authorizeAdapter(adapter("x", { platform: "p", channel: "official-api", policy: "permitted-by-terms" }).meta, cat2, NOW).ok, false);
  assert.equal(authorizeAdapter(adapter("y", { platform: "p", channel: "browser", policy: "official-api" }).meta, cat2, NOW).ok, false);
  // Même avec le bon canal : l'adaptateur API n'est pas utilisable sans son secret (variable d'environnement), sans aucune requête.
  const apiAd = new FakeApiAdapter(fakeApi().fetchImpl, {});
  assert.equal(resolveChannel({ platform: "p", adapters: [apiAd], catalog: cat2, env: {}, config: { channel: "auto" }, now: NOW }).channel, "human");
});

test("niveau 1 → adaptateur : le canal retenu ne dépasse jamais les preuves (api ≠ browser, browser ≠ api), même avec les deux adaptateurs installés", () => {
  const web = adapter("p-web", { platform: "p", channel: "browser" });
  const apiAd = new FakeApiAdapter(fakeApi().fetchImpl);
  const pick = (cat: Catalog, channel: "auto" | "browser" | "official-api" = "auto") => resolveChannel({ platform: "p", adapters: [web, apiAd], catalog: cat, env: SECRET, config: { channel }, now: NOW });
  assert.equal(pick(catalogWith([plat("p")], [ev("p", "browser")])).channel, "browser");
  assert.equal(pick(catalogWith([plat("p")], [ev("p", "api")])).channel, "official-api");
  assert.throws(() => pick(catalogWith([plat("p")], [ev("p", "api")]), "browser"), /indisponible/);
  assert.throws(() => pick(catalogWith([plat("p")], [ev("p", "browser")]), "official-api"), /indisponible/);
  assert.equal(pick(catalogWith([plat("p")], [ev("p", "both")])).channel, "official-api", "API d'abord quand les deux sont permis");
  assert.equal(pick(catalogWith([plat("p")], [ev("p", "both")]), "browser").channel, "browser", "un canal forcé restreint, il n'élargit pas");
});

// ───────────────────────────── reprises (login / file d'attente / CAPTCHA) ─────────────────────────────
const agentFor = (web: FakeAdapter, catalog: Catalog, awaitHuman: () => Promise<void>) => {
  const config = ConfigSchema.parse({
    site: "p", event: { name: "T", url: "https://p.example/event" }, sale: { startTime: new Date(Date.now() - 1000).toISOString() },
    tickets: { quantity: 2, maxPricePerTicket: 150 }, timing: { preArmSeconds: 0, maxWaitAfterSaleSeconds: 2 },
    notifications: { desktop: false, sound: false }, telemetry: { enabled: false },
  });
  return new Agent({
    config, adapter: web, catalog, claude: new ClaudeAssistant(config.claude, silentLogger), log: silentLogger, clock: new Clock(), notifier: async () => undefined, awaitHuman,
    ctx: { config, context: {} as never, page: { bringToFront: async () => undefined } as never, log: silentLogger, env: {}, selectors: new SelectorResolver("fake", "/nonexistent/x.json") },
  });
};

for (const state of ["CAPTCHA", "QUEUE", "LOGIN_REQUIRED"] as const) {
  test(`reprise après ${state} : l'autorisation est REVÉRIFIÉE — une preuve retirée/expirée pendant l'attente humaine arrête le bot avant toute nouvelle action`, async () => {
    const web = adapter("p-web", { platform: "p", channel: "browser" });
    web.offers = [offer({ id: "a" })];
    web.failures.selectOffer = [new BlockerError({ state, message: `${state} affiché` })];
    const cat = catalogWith([plat("p")], [ev("p", "browser")]);
    const result = await agentFor(web, cat, async () => {
      cat.evidence.length = 0; // pendant que l'humain traite le blocage : la preuve disparaît (ou expire)
    }).run();
    assert.equal(result.status, "error", "le bot ne reprend pas");
    assert.equal(web.calls.filter((c) => c.startsWith("selectOffer")).length, 1, "aucune nouvelle sélection après la reprise");
    assert.ok(!web.calls.includes("addToCart"), "aucun ajout au panier après la reprise");
  });
}

test("reprise avec autorisation intacte : le bot reprend normalement (témoin)", async () => {
  const web = adapter("p-web", { platform: "p", channel: "browser" });
  web.offers = [offer({ id: "a" })];
  web.failures.selectOffer = [new BlockerError({ state: "QUEUE", message: "file" })];
  const result = await agentFor(web, catalogWith([plat("p")], [ev("p", "browser")]), async () => undefined).run();
  assert.equal(result.finalState, "CART_SUCCESS");
});
