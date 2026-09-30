import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/index.js";
import { eventKey } from "../src/utils/lock.js";
import { authorizeAdapter } from "../src/platforms/authorize.js";
import { resolveChannel } from "../src/agent/channels.js";
import { STATUSES, stateOf, type Catalog } from "../src/platforms/catalog.js";
import type { SiteAdapter } from "../src/sites/SiteAdapter.js";
import { FakeApiAdapter, fakeApi } from "./helpers/fakeApi.js";
import { FakeAdapter, offer } from "./helpers/fakeAdapter.js";
import { NOW, adapter, catalogWith, daysAgo, ev, plat } from "./helpers/platformFixtures.js";

/**
 * Une plateforme qui n'est pas API_ONLY | BROWSER_ONLY | API_AND_BROWSER (NOT_VERIFIED, EXPIRED, NOT_ALLOWED — ou absente du catalogue) ne doit
 * JAMAIS pouvoir être exécutée par `run` : ni par défaut, ni par erreur, ni par un canal forcé.
 */
const NOT_USABLE: [string, Catalog][] = [
  ["NOT_VERIFIED", catalogWith([plat("p")])],
  ["EXPIRED", catalogWith([plat("p")], [ev("p", "both", daysAgo(181))])],
  ["NOT_ALLOWED", catalogWith([plat("p")], [ev("p", "prohibited")])],
  ["HUMAN_ONLY", catalogWith([plat("p")], [ev("p", "human")])],
  ["absente du catalogue", catalogWith([])],
];
const cfg = (extra: Record<string, unknown> = {}): string => {
  const f = join(mkdtempSync(join(tmpdir(), "safety-")), "safety-test.json");
  writeFileSync(f, JSON.stringify({
    site: "p", event: { name: "e", url: "https://api.p.example/events/1" }, sale: { startTime: new Date(Date.now() + 700).toISOString() },
    tickets: { quantity: 2, maxPricePerTicket: 150 }, notifications: { desktop: false, sound: false }, telemetry: { enabled: false },
    timing: { preArmSeconds: 0, pollIntervalMs: 200, maxWaitAfterSaleSeconds: 5 }, ...extra,
  }));
  return f;
};
/** La variable du secret de l'API fictive doit exister DANS LE PROCESSUS : resolveChannel la lit dans process.env. */
const withSecret = async <T>(fn: () => Promise<T>): Promise<T> => {
  const prev = process.env.P_API_KEY;
  process.env.P_API_KEY = "SECRET-CANARY-1234567890abcdef";
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.P_API_KEY;
    else process.env.P_API_KEY = prev;
  }
};
const profilesBefore = (): string[] => (existsSync(".profile") ? readdirSync(".profile") : []);
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log;
  console.log = () => undefined;
  try {
    return await fn();
  } finally {
    console.log = log;
  }
};

for (const [label, cat] of NOT_USABLE) {
  test(`run : plateforme ${label} → canal humain, adaptateurs jamais appelés, aucun navigateur, aucune requête`, async () => {
    const web = adapter("p-web", { platform: "p", channel: "browser" });
    web.offers = [offer({ id: "a" })];
    const api = fakeApi();
    const apiAdapter = new FakeApiAdapter(api.fetchImpl);
    const before = profilesBefore();
    const code = await withSecret(() => quiet(() => main(["run", "--config", cfg(), "--log-level", "error"], { adapters: [web, apiAdapter], catalog: cat })));
    assert.equal(code, 0, "canal humain : rappels seulement");
    assert.deepEqual(web.calls, [], "l'adaptateur navigateur n'a jamais été appelé");
    assert.deepEqual(api.state.calls, [], "aucune requête vers l'API");
    assert.deepEqual(profilesBefore(), before, "aucun navigateur/profil créé");
  });

  test(`run : plateforme ${label} + canal FORCÉ → refus explicite, adaptateurs jamais appelés`, async () => {
    const web = adapter("p-web", { platform: "p", channel: "browser" });
    const api = fakeApi();
    for (const channel of ["browser", "official-api"]) {
      await assert.rejects(
        withSecret(() => quiet(() => main(["run", "--config", cfg({ channel }), "--log-level", "error"], { adapters: [web, new FakeApiAdapter(api.fetchImpl)], catalog: cat }))),
        /indisponible/,
        `${label} / ${channel}`,
      );
    }
    assert.deepEqual(web.calls, []);
    assert.deepEqual(api.state.calls, []);
  });
}

test("balayage : pour CHAQUE statut non vérifié, aucun canal n'autorise un adaptateur — l'autorisation exige API_ONLY | BROWSER_ONLY | API_AND_BROWSER", () => {
  const seen = new Set<string>();
  for (const [, cat] of NOT_USABLE) {
    const status = stateOf(cat, "p", NOW).status;
    seen.add(status);
    for (const channel of ["official-api", "browser"] as const) {
      const a: SiteAdapter = adapter("x", { platform: "p", channel });
      assert.equal(authorizeAdapter(a.meta, cat, NOW).ok, false, `${status} / ${channel}`);
      assert.equal(resolveChannel({ platform: "p", adapters: [a], catalog: cat, env: { P_API_KEY: "x" }, config: { channel: "auto" }, now: NOW }).adapter, undefined);
    }
  }
  assert.deepEqual([...seen].sort(), ["EXPIRED", "HUMAN_ONLY", "NOT_ALLOWED", "NOT_VERIFIED"]);
  // et réciproquement : seuls les trois statuts API_ONLY | BROWSER_ONLY | API_AND_BROWSER autorisent, et uniquement les canaux prouvés
  const ok = (s: "api" | "browser" | "both", ch: "official-api" | "browser") => authorizeAdapter(adapter("x", { platform: "p", channel: ch }).meta, catalogWith([plat("p")], [ev("p", s)]), NOW).ok;
  assert.deepEqual([ok("api", "official-api"), ok("api", "browser"), ok("browser", "official-api"), ok("browser", "browser"), ok("both", "official-api"), ok("both", "browser")], [true, false, false, true, true, true]);
  assert.equal(STATUSES.length, 7);
});

test("run : l'expiration s'applique AU MOMENT du run — preuve de 180 jours → exécution ; de 181 jours → humain", async () => {
  for (const [age, expected] of [[180, "exécuté"], [181, "humain"]] as const) {
    const api = fakeApi();
    const a = new FakeApiAdapter(api.fetchImpl);
    const cat = catalogWith([plat("p")], [ev("p", "api", daysAgo(age, Date.now()))]);
    const code = await withSecret(() => quiet(() => main(["run", "--config", cfg(), "--log-level", "error"], { adapters: [a], catalog: cat }))).catch(() => -1);
    assert.equal(code, 0, `${age} jours`);
    assert.equal(api.state.calls.length > 0, expected === "exécuté", `${age} jours : ${api.state.calls.length} appels`);
  }
});

test("run par le canal API de bout en bout (faux serveur) : preuve valide + secret → réservation, arrêt immédiat, aucun paiement, verrou libéré", async () => {
  const api = fakeApi();
  const a = new FakeApiAdapter(api.fetchImpl);
  const code = await withSecret(() => quiet(() => main(["run", "--config", cfg(), "--log-level", "error"], { adapters: [a], catalog: catalogWith([plat("p")], [ev("p", "api", daysAgo(10, Date.now()))]) })));
  assert.equal(code, 0);
  const p = api.state.calls.map((c) => `${c.method} ${c.path.replace("/v1", "")}`);
  assert.equal(p[0], "GET /me");
  assert.equal(p.at(-1), "GET /reservations/current");
  assert.ok(p.includes("POST /reservations"));
  assert.ok(!p.some((x) => /pay|checkout|order|purchase/i.test(x)));
  // Le verrou de CET événement est libéré (les autres fichiers de test tournent en parallèle et peuvent détenir les leurs).
  assert.equal(existsSync(join(".locks", `${eventKey("api-test", "https://api.p.example/events/1")}.lock`)), false, "verrou d'événement résiduel");
  void FakeAdapter;
});
