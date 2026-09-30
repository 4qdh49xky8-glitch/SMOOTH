import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Agent } from "../src/agent/Agent.js";
import { ClaudeAssistant } from "../src/agent/claude.js";
import { resolveChannel } from "../src/agent/channels.js";
import { createApiContext } from "../src/api/BaseApiAdapter.js";
import { ConfigSchema } from "../src/config/schema.js";
import { main } from "../src/index.js";
import { authorizeAdapter } from "../src/platforms/authorize.js";
import { AUTOMATABLE, STATUSES, stateOf, type Catalog, type PlatformStatus } from "../src/platforms/catalog.js";
import type { EvidenceRecord } from "../src/platforms/evidence.js";
import { SelectorResolver } from "../src/selectors/resolver.js";
import { Clock } from "../src/utils/clock.js";
import { BlockerError } from "../src/utils/errors.js";
import { silentLogger } from "../src/utils/logger.js";
import { planNewSite } from "../scripts/new-site.js";
import { FakeApiAdapter, fakeApi } from "./helpers/fakeApi.js";
import { FakeAdapter, offer } from "./helpers/fakeAdapter.js";
import { NOW, adapter, catalogWith, daysAgo, ev, plat } from "./helpers/platformFixtures.js";

/**
 * MATRICE EXHAUSTIVE : 7 statuts × (auto · API forcée · navigateur forcé · humain) × (adaptateur API · navigateur · les deux)
 * × (run · login · check · reprise · new-site). Règle : l'absence de preuve pour un canal = canal NON autorisé ; une configuration
 * ne peut que RESTREINDRE. Pour toute combinaison non autorisée : 0 requête réseau, 0 appel d'adaptateur, 0 navigateur.
 */
type Ch = "official-api" | "browser";
const at = (p: string, file: string, channel: EvidenceRecord["channel"], url: string, age = 3): EvidenceRecord =>
  ev(p, channel!, daysAgo(age), { source: { url, title: "Page officielle (FICTIVE)" }, file });
const API_DOC = "https://developer.p.example/terms";
const WEB_DOC = "https://www.p.example/cgu";

const STATUS_CASES: { status: PlatformStatus; evidence: () => EvidenceRecord[]; allowed: Ch[] }[] = [
  { status: "NOT_VERIFIED", evidence: () => [], allowed: [] },
  { status: "API_ONLY", evidence: () => [at("p", "a.json", "api", API_DOC)], allowed: ["official-api"] },
  { status: "BROWSER_ONLY", evidence: () => [at("p", "b.json", "browser", WEB_DOC)], allowed: ["browser"] },
  { status: "API_AND_BROWSER", evidence: () => [at("p", "a.json", "api", API_DOC), at("p", "b.json", "browser", WEB_DOC)], allowed: ["official-api", "browser"] },
  { status: "HUMAN_ONLY", evidence: () => [at("p", "h.json", "human", WEB_DOC)], allowed: [] },
  { status: "EXPIRED", evidence: () => [at("p", "e.json", "both", WEB_DOC, 181)], allowed: [] },
  { status: "NOT_ALLOWED", evidence: () => [at("p", "n.json", "prohibited", WEB_DOC)], allowed: [] },
];
const catalogFor = (c: (typeof STATUS_CASES)[number]): Catalog => catalogWith([plat("p")], c.evidence());
const CONFIG_CHANNELS = ["auto", "official-api", "browser", "human"] as const;
type Installed = "api" | "browser" | "both";
const SECRET = { P_API_KEY: "SECRET-CANARY-1234567890abcdef" };

/** Oracle INDÉPENDANT du code : ce que la règle dit, écrite à la main. */
function expected(allowed: Ch[], installed: Installed, config: (typeof CONFIG_CHANNELS)[number]): Ch | "human" | "refused" {
  const have: Ch[] = installed === "api" ? ["official-api"] : installed === "browser" ? ["browser"] : ["official-api", "browser"];
  const usable = have.filter((c) => allowed.includes(c));
  if (config === "human") return "human";
  if (config === "auto") return usable[0] ?? "human"; // API d'abord
  return usable.includes(config) ? config : "refused";
}
const adaptersFor = (installed: Installed, fetchImpl: typeof fetch) => {
  const web = adapter("p-web", { platform: "p", channel: "browser" });
  web.offers = [offer({ id: "a" })];
  const api = new FakeApiAdapter(fetchImpl);
  return { web, api, list: [...(installed !== "api" ? [web] : []), ...(installed !== "browser" ? [api] : [])] };
};

// ───────────────────────────── 1. choix du canal : matrice complète ─────────────────────────────
for (const sc of STATUS_CASES) {
  test(`matrice ${sc.status} : (auto · API forcée · navigateur forcé · humain) × (API · navigateur · les deux) — jamais plus que les preuves`, () => {
    const cat = catalogFor(sc);
    assert.equal(stateOf(cat, "p", NOW).status, sc.status, "le statut de la fixture est bien celui annoncé");
    assert.deepEqual(stateOf(cat, "p", NOW).channels, sc.allowed);
    for (const installed of ["api", "browser", "both"] as const) {
      for (const config of CONFIG_CHANNELS) {
        const { list } = adaptersFor(installed, fakeApi().fetchImpl);
        const want = expected(sc.allowed, installed, config);
        const run = () => resolveChannel({ platform: "p", adapters: list, catalog: cat, env: SECRET, config: { channel: config }, now: NOW });
        if (want === "refused") assert.throws(run, /indisponible/, `${sc.status}/${installed}/${config}`);
        else {
          const d = run();
          assert.equal(d.channel, want, `${sc.status}/${installed}/${config}`);
          // invariant central : le canal retenu est autorisé par les preuves, ou c'est l'humain
          assert.ok(d.channel === "human" || sc.allowed.includes(d.channel), "canal non autorisé retenu !");
          if (d.adapter) assert.equal(authorizeAdapter(d.adapter.meta, cat, NOW).ok, true);
        }
      }
    }
  });
}

// ───────────────────────────── 2. run · login · check : zéro requête pour toute combinaison non autorisée ─────────────────────────────
const cfgFile = (extra: Record<string, unknown> = {}): string => {
  const f = join(mkdtempSync(join(tmpdir(), "matrix-")), "matrix-test.json");
  writeFileSync(f, JSON.stringify({
    site: "p", event: { name: "e", url: "https://api.p.example/events/1" }, sale: { startTime: new Date(Date.now() + 500).toISOString() },
    tickets: { quantity: 2, maxPricePerTicket: 150 }, notifications: { desktop: false, sound: false }, telemetry: { enabled: false },
    timing: { preArmSeconds: 0, pollIntervalMs: 200, maxWaitAfterSaleSeconds: 4 }, ...extra,
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
const withEnv = async <T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> => {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  }
};
const profiles = (): string[] => (existsSync(".profile") ? readdirSync(".profile") : []);
const externalAttempts = (): number => ((globalThis as { __externalNetAttempts?: string[] }).__externalNetAttempts ?? []).length;

for (const sc of STATUS_CASES) {
  for (const config of CONFIG_CHANNELS) {
    // Seules les combinaisons qui n'automatisent RIEN sont rejouées via `main` (un canal navigateur autorisé ouvrirait Chromium) :
    // c'est exactement l'ensemble sur lequel « 0 requête » doit tenir.
    const want = expected(sc.allowed, "both", config);
    if (want !== "human" && want !== "refused") continue;
    for (const command of ["run", "login", "check"] as const) {
      test(`${sc.status} × ${config} × ${command} → ${want === "human" ? "canal humain" : "refus"} : 0 requête, 0 appel d'adaptateur, 0 navigateur`, async () => {
        const api = fakeApi();
        const { web, api: apiAd, list } = adaptersFor("both", api.fetchImpl);
        const before = profiles();
        const ext = externalAttempts();
        const go = () => withEnv(SECRET, () => quiet(() => main([command, "--config", cfgFile({ channel: config }), "--log-level", "error"], { adapters: list, catalog: catalogFor(sc) })));
        if (want === "refused") await assert.rejects(go(), /indisponible/);
        else assert.equal(await go(), 0);
        assert.deepEqual(web.calls, [], "adaptateur navigateur appelé");
        assert.deepEqual(api.state.calls, [], "requête API émise");
        assert.deepEqual(profiles(), before, "navigateur/profil créé");
        assert.equal(externalAttempts(), ext, "tentative de connexion externe");
        void apiAd;
      });
    }
  }
}

for (const sc of STATUS_CASES.filter((s) => s.allowed.includes("official-api"))) {
  for (const config of ["auto", "official-api"] as const) {
    test(`témoin ${sc.status} × ${config} × run (adaptateur API) → panier via l'API, aucun navigateur, aucune route de paiement`, async () => {
      const api = fakeApi();
      const { web, list } = adaptersFor("both", api.fetchImpl);
      const code = await withEnv(SECRET, () => quiet(() => main(["run", "--config", cfgFile({ channel: config }), "--log-level", "error"], { adapters: list, catalog: catalogFor(sc) })));
      assert.equal(code, 0);
      const paths = api.state.calls.map((c) => `${c.method} ${c.path}`);
      assert.ok(paths.some((p) => p.includes("POST /v1/reservations")), paths.join(" | "));
      assert.ok(!paths.some((p) => /pay|checkout|order|purchase/i.test(p)));
      assert.deepEqual(web.calls, [], "le canal navigateur n'est pas utilisé quand l'API est autorisée");
    });
  }
}

// ───────────────────────────── 3. reprise : chaque statut atteint PENDANT l'attente humaine ─────────────────────────────
const agentConfig = () => ConfigSchema.parse({
  site: "p", event: { name: "T", url: "https://api.p.example/events/1" }, sale: { startTime: new Date(Date.now() - 500).toISOString() },
  tickets: { quantity: 2, maxPricePerTicket: 150 }, timing: { preArmSeconds: 0, pollIntervalMs: 200, maxWaitAfterSaleSeconds: 3 }, notifications: { desktop: false, sound: false }, telemetry: { enabled: false },
});
for (const sc of STATUS_CASES) {
  for (const kind of ["browser", "api"] as const) {
    const channel: Ch = kind === "api" ? "official-api" : "browser";
    const stays = sc.allowed.includes(channel);
    test(`reprise ${kind} : l'autorisation devient ${sc.status} pendant l'attente humaine → ${stays ? "reprise normale" : "AUTHORIZATION_EXPIRED, zéro requête de plus"}`, async () => {
      const cat = catalogWith([plat("p")], [at("p", "start.json", "both", WEB_DOC)]); // autorisé au départ
      const config = agentConfig();
      let callsAtResume = -1;
      let web: FakeAdapter | undefined;
      let api: ReturnType<typeof fakeApi> | undefined;
      let ad: FakeAdapter | FakeApiAdapter;
      const count = (): number => (kind === "api" ? api!.state.calls.length : web!.calls.length);
      if (kind === "browser") {
        web = adapter("p-web", { platform: "p", channel: "browser" });
        web.offers = [offer({ id: "a" })];
        web.failures.selectOffer = [new BlockerError({ state: "CAPTCHA", message: "captcha" })];
        ad = web;
      } else {
        api = fakeApi({ queueWaits: 1 });
        ad = new FakeApiAdapter(api.fetchImpl);
      }
      const ctx = kind === "api"
        ? createApiContext(config, silentLogger, SECRET)
        : { config, context: {} as never, page: { bringToFront: async () => undefined } as never, log: silentLogger, env: {}, selectors: new SelectorResolver("fake", "/nonexistent/x.json") };
      const result = await new Agent({
        config, adapter: ad, catalog: cat, ctx, claude: new ClaudeAssistant(config.claude, silentLogger), log: silentLogger, clock: new Clock(), notifier: async () => undefined,
        awaitHuman: async () => {
          cat.evidence.length = 0;
          cat.evidence.push(...sc.evidence()); // l'humain a fini ; entre-temps l'autorisation est devenue `sc.status`
          callsAtResume = count();
        },
      }).run();
      if (stays) {
        assert.equal(result.finalState, "CART_SUCCESS");
      } else {
        assert.equal(result.status, "authorization-expired");
        assert.equal(result.finalState, "AUTHORIZATION_EXPIRED");
        assert.equal(count(), callsAtResume, "AUCUNE requête / aucun appel d'adaptateur après la reprise refusée");
      }
    });
  }
}

// ───────────────────────────── 4. new-site ─────────────────────────────
for (const sc of STATUS_CASES) {
  for (const wanted of [undefined, "api", "browser"] as const) {
    test(`new-site ${sc.status} × ${wanted ?? "défaut"} : adaptateur utilisable seulement avec une preuve du canal ; sinon squelette NOT_VERIFIED ou refus`, () => {
      const plan = planNewSite(catalogFor(sc), "p", "P", { platform: "p", channel: wanted, now: NOW });
      const ch: Ch | undefined = wanted === "api" ? "official-api" : wanted === "browser" ? "browser" : undefined;
      if (sc.status === "NOT_ALLOWED" || sc.status === "HUMAN_ONLY") return assert.equal(plan.kind, "refused");
      if (AUTOMATABLE.includes(sc.status)) {
        const allowed = ch ? sc.allowed.includes(ch) : true;
        assert.equal(plan.kind, allowed ? "skeleton" : "refused");
        if (plan.kind === "skeleton") assert.equal(plan.verified, true);
        return;
      }
      assert.equal(plan.kind, "skeleton"); // NOT_VERIFIED / EXPIRED
      assert.equal((plan as { verified: boolean }).verified, false);
      assert.match(Object.values((plan as { files: Record<string, string> }).files).join("\n"), /@skeleton-status NOT_VERIFIED/);
    });
  }
}

test("les 7 statuts sont tous couverts par la matrice", () => {
  assert.deepEqual(STATUS_CASES.map((s) => s.status).sort(), [...STATUSES].sort());
});
