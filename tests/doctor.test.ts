import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDoctor, type Check, type DoctorOptions } from "../src/cli/doctor.js";
import { main } from "../src/index.js";
import ExampleSite from "../src/sites/ExampleSite.js";
import type { AdapterEntry } from "../src/sites/registry.js";
import { FakeApiAdapter, fakeApi } from "./helpers/fakeApi.js";
import { NOW, catalogWith, daysAgo, ev, plat } from "./helpers/platformFixtures.js";

const root = (): string => mkdtempSync(join(tmpdir(), "doctor-"));
const demoConfig = (extra: Record<string, unknown> = {}, site = "example"): string => {
  const f = join(root(), "event.json");
  writeFileSync(f, JSON.stringify({ site, event: { name: "e", url: "http://127.0.0.1:4173/event" }, sale: { startTime: "2031-01-01T10:00:00+01:00" }, tickets: { quantity: 2, maxPricePerTicket: 50 }, ...extra }));
  return f;
};
const demoEntry: AdapterEntry = { adapter: new ExampleSite(), file: "" };
const base = (over: DoctorOptions = {}): DoctorOptions => ({ root: root(), env: {}, now: NOW, entries: [demoEntry], catalog: catalogWith([plat("p")]), configs: [demoConfig()], chromiumPath: process.execPath, isTTY: true, ...over });
const find = (checks: Check[], area: string, re?: RegExp): Check[] => checks.filter((c) => c.area === area && (!re || re.test(c.message)));

test("doctor : configuration saine → zéro erreur, chaque zone est contrôlée", async () => {
  const r = await runDoctor(base());
  assert.equal(r.errors, 0, JSON.stringify(r.checks.filter((c) => c.level === "error")));
  for (const area of ["Node", "Catalogue", "Expiration", "Preuves", "Adaptateurs", "Configuration", "Chromium", "Environnement", "Permissions"]) assert.ok(find(r.checks, area).length > 0, `zone « ${area} » absente`);
  assert.equal(find(r.checks, "Node")[0]!.level, "ok");
  assert.equal(find(r.checks, "Chromium")[0]!.level, "ok");
  assert.match(find(r.checks, "Catalogue", /statuts/)[0]!.message, /NOT_VERIFIED=1/);
});

test("doctor : aucun accès réseau, quoi qu'il vérifie", async () => {
  const realFetch = globalThis.fetch;
  let network = 0;
  globalThis.fetch = (async () => void network++) as never;
  try {
    await runDoctor(base());
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(network, 0);
});

test("doctor : Chromium introuvable → erreur si un profil utilise le navigateur, simple avertissement sinon", async () => {
  const needs = await runDoctor(base({ chromiumPath: "/introuvable/chromium" }));
  assert.equal(find(needs.checks, "Chromium")[0]!.level, "error");
  assert.match(find(needs.checks, "Chromium")[0]!.message, /requis par un profil au canal navigateur/);
  const humanOnly = await runDoctor(base({ chromiumPath: "/introuvable/chromium", configs: [demoConfig({}, "plateforme-sans-adaptateur")], catalog: catalogWith([plat("plateforme-sans-adaptateur")]) }));
  assert.equal(find(humanOnly.checks, "Chromium")[0]!.level, "warn");
  const broken = await runDoctor(base({ chromiumPath: "/etc/hostname" }));
  assert.notEqual(find(broken.checks, "Chromium")[0]!.level, "ok", "un fichier qui n'est pas un exécutable ne doit pas passer");
});

test("doctor : preuves refusées → erreur listée ; preuves expirées ou proches de l'expiration → avertissements ; contradictions signalées", async () => {
  const r = root();
  mkdirSync(join(r, "platforms", "evidence"), { recursive: true });
  writeFileSync(join(r, "platforms", "catalog.json"), JSON.stringify({ schemaVersion: 2, platforms: [plat("p")] }));
  writeFileSync(join(r, "platforms", "evidence", "p-http.json"), JSON.stringify({ platform: "p", checkedAt: daysAgo(1), source: { url: "http://www.p.example/x", title: "t" }, channel: "api", authorization: "Texte FICTIF de test.", excerpt: "Passage FICTIF de test, cité tel quel depuis la page officielle." }));
  const withBad = await runDoctor({ ...base({ root: r }), catalog: undefined });
  assert.ok(withBad.errors >= 1);
  assert.ok(find(withBad.checks, "Preuves", /p-http\.json refusée : NO_HTTPS_URL/).length === 1);
  assert.equal(find(withBad.checks, "Preuves", /0 preuve\(s\) valide\(s\), 1 refusée/)[0]!.level, "error");

  const cat = catalogWith([plat("bientot"), plat("vieille"), plat("conflit")], [ev("bientot", "browser", daysAgo(165)), ev("vieille", "both", daysAgo(200)), ev("conflit", "both", daysAgo(9)), ev("conflit", "api", daysAgo(2))]);
  const soon = await runDoctor(base({ catalog: cat }));
  assert.equal(soon.errors, 0);
  assert.ok(find(soon.checks, "Expiration", /bientot : la preuve expire le .* \(dans 15 j\)/).length === 1);
  assert.ok(find(soon.checks, "Expiration", /vieille : preuves expirées/).length === 1);
  assert.ok(find(soon.checks, "Preuves", /conflit : preuves divergentes/).length === 1);
  assert.equal(find(soon.checks, "Catalogue", /statuts/)[0]!.message.includes("EXPIRED=1"), true);
});

test("doctor : variables d'environnement requises par un adaptateur API (absentes → avertissement, présentes → ok), webhook, LOG_LEVEL, clé Claude", async () => {
  const cat = catalogWith([plat("p")], [ev("p", "api", daysAgo(3))]);
  const apiEntry: AdapterEntry = { adapter: new FakeApiAdapter(fakeApi().fetchImpl), file: "" };
  const missing = await runDoctor(base({ entries: [demoEntry, apiEntry], catalog: cat, env: {} }));
  assert.equal(find(missing.checks, "Environnement", /P_API_KEY/)[0]!.level, "warn");
  assert.equal(find(missing.checks, "Adaptateurs", /api-test \(official-api, official-api\) : contrat OK/)[0]!.level, "ok");
  const present = await runDoctor(base({ entries: [demoEntry, apiEntry], catalog: cat, env: { P_API_KEY: "x" } }));
  assert.equal(find(present.checks, "Environnement", /P_API_KEY définie/)[0]!.level, "ok");
  assert.ok(!JSON.stringify(present.checks).includes('"x"'), "jamais la valeur du secret");

  const env = await runDoctor(base({ env: { NOTIFY_WEBHOOK_URL: "http://insecure.example/hook", LOG_LEVEL: "bavard" } }));
  assert.equal(find(env.checks, "Environnement", /NOTIFY_WEBHOOK_URL doit être en https/)[0]!.level, "error");
  assert.equal(find(env.checks, "Environnement", /LOG_LEVEL/)[0]!.level, "warn");
  const claude = await runDoctor(base({ configs: [demoConfig({ claude: { enabled: true } })], env: {} }));
  assert.equal(find(claude.checks, "Environnement", /ANTHROPIC_API_KEY absente/)[0]!.level, "warn");
});

test("doctor : squelette NOT_VERIFIED → avertissement (jamais une erreur) ; contrat cassé → erreur ; terminal non interactif → avertissement", async () => {
  const dir = root();
  const file = join(dir, "Squelette.ts");
  writeFileSync(file, "// @skeleton-status NOT_VERIFIED\n");
  const skeleton = new FakeApiAdapter(fakeApi().fetchImpl);
  const r = await runDoctor(base({ entries: [demoEntry, { adapter: skeleton, file }], isTTY: false }));
  const c = find(r.checks, "Adaptateurs", /api-test/)[0]!;
  assert.equal(c.level, "warn");
  assert.match(c.message, /squelette NOT_VERIFIED \(non exécutable\)/);
  assert.match(c.fix!, /npm run platform verify p/);
  assert.equal(r.errors, 0);
  assert.equal(find(r.checks, "Permissions", /pas de terminal interactif/)[0]!.level, "warn");
  const broken = new FakeApiAdapter(fakeApi().fetchImpl);
  broken.meta = { ...broken.meta, channel: "browser" } as never;
  const rb = await runDoctor(base({ entries: [demoEntry, { adapter: broken, file: "" }], catalog: catalogWith([plat("p")], [ev("p", "api", daysAgo(3))]) }));
  assert.equal(find(rb.checks, "Adaptateurs", /api-test/)[0]!.level, "error");
});

test("doctor : configuration invalide → erreur avec la commande de correction", async () => {
  const r = await runDoctor(base({ configs: [demoConfig({ behavior: { autoPayment: true } })] }));
  const c = find(r.checks, "Configuration")[0]!;
  assert.equal(c.level, "error");
  assert.match(c.fix!, /npm run validate/);
  assert.ok(r.errors >= 1);
});

test("npm run doctor : structure complète, code de sortie cohérent avec les erreurs", async () => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (m?: unknown) => void lines.push(String(m));
  let code: number;
  try {
    code = await main(["doctor", "--json"]);
  } finally {
    console.log = log;
  }
  const out = JSON.parse(lines.join("\n")) as { checks: Check[]; errors: number; warnings: number };
  assert.equal(code, out.errors ? 1 : 0);
  for (const area of ["Node", "Catalogue", "Preuves", "Expiration", "Adaptateurs", "Configuration", "Chromium", "Environnement", "Permissions"]) assert.ok(out.checks.some((c) => c.area === area), area);
  assert.ok(out.checks.every((c) => ["ok", "info", "warn", "error"].includes(c.level)));
});
