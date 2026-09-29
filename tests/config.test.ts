import assert from "node:assert/strict";
import { test } from "node:test";
import { deepMerge, listProfiles, loadConfig, readConfigFile, resolveConfigPath } from "../src/config/load.js";
import { validateConfig } from "../src/config/validate.js";
import ExampleSite from "../src/sites/ExampleSite.js";
import { discoverAdapters } from "../src/sites/registry.js";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  site: "example",
  event: { name: "T", url: "http://127.0.0.1:4173/event" },
  sale: { startTime: "2026-10-05T10:00:00+02:00" },
  tickets: { quantity: 2, maxPricePerTicket: 100, categories: ["A"] },
  ...over,
});
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const write = (cfg: unknown): string => {
  const f = join(mkdtempSync(join(tmpdir(), "cfg-")), "c.json");
  writeFileSync(f, JSON.stringify(cfg));
  return f;
};
const check = async (cfg: unknown) => validateConfig(write(cfg), { now: NOW, env: {} });

test("profils : héritage `extends`, tableaux remplacés, objets fusionnés", () => {
  const cfg = loadConfig("tests/fixtures/profiles/child.json");
  assert.equal(cfg.event.name, "Enfant");
  assert.deepEqual(cfg.tickets.categories, ["C"]); // le tableau de l'enfant remplace celui du parent
  assert.equal(cfg.tickets.quantity, 2); // hérité
  assert.equal(cfg.timing.pollIntervalMs, 300); // surchargé
  assert.equal(cfg.timing.maxWaitAfterSaleSeconds, 100); // hérité
  assert.deepEqual(deepMerge({ a: { x: 1, y: 2 }, l: [1] }, { a: { y: 3 }, l: [2] }), { a: { x: 1, y: 3 }, l: [2] });
});

test("profils : résolution par nom, liste, fichiers _base exclus", () => {
  assert.equal(resolveConfigPath("concert"), "config/events/concert.json");
  assert.equal(resolveConfigPath("config/event.json"), "config/event.json");
  assert.deepEqual(listProfiles(), ["concert", "festival", "spectacle", "sport"]);
  assert.throws(() => resolveConfigPath("inconnu"), /Profil inconnu/);
});

test("profils : tous les profils livrés sont valides et chargent la bonne stratégie", async () => {
  for (const name of listProfiles()) {
    const r = await validateConfig(name, { now: NOW, env: {} });
    assert.equal(r.ok, true, `${name}: ${r.errors.join("; ")}`);
  }
  assert.equal(loadConfig("spectacle").strategy.priceOrder, "most-expensive");
  assert.equal(loadConfig("spectacle").tickets.seatsTogetherStrict, true);
  assert.deepEqual(loadConfig("sport").strategy.priorityCategories, ["Tribune Nord"]);
  assert.deepEqual(loadConfig("festival").tickets.categories, []);
  assert.equal(loadConfig("concert").behavior.autoPayment, false); // hérité de _base, jamais activable
});

test("validate : configuration saine → ok, avec résumé", async () => {
  const r = await check(base());
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.ok(r.info.some((i) => i.includes("ouverture de la vente")));
});

test("validate : erreurs bloquantes (schéma, paiement auto, site inconnu, démo hors localhost)", async () => {
  assert.equal((await check(base({ behavior: { autoPayment: true } }))).ok, false);
  assert.equal((await check(base({ sale: { startTime: "2026-10-05T10:00:00" } }))).ok, false);
  const unknown = await check(base({ site: "nexiste-pas" }));
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors.join(" "), /aucun adaptateur/);
  const real = await check(base({ event: { name: "T", url: "https://billetterie.example.com/e" } }));
  assert.equal(real.ok, false);
  assert.match(real.errors.join(" "), /localhost/);
});

test("validate : avertissements de cohérence", async () => {
  const past = await check(base({ sale: { startTime: "2026-09-01T10:00:00+02:00" } }));
  assert.match(past.warnings.join(" "), /dans le passé/);
  const cat = await check(base({ strategy: { priorityCategories: ["Z"] } }));
  assert.match(cat.warnings.join(" "), /priorityCategories/);
  const overlap = await check(base({ strategy: { placement: { preferSections: ["Fosse"], avoidSections: ["fosse"] } } }));
  assert.match(overlap.warnings.join(" "), /préférées et évitées/);
  const dup = await check(base({ tickets: { quantity: 1, maxPricePerTicket: 10, categories: ["A", "a"] } }));
  assert.match(dup.warnings.join(" "), /doublons/);
  const claude = await check(base({ claude: { enabled: true } }));
  assert.match(claude.warnings.join(" "), /ANTHROPIC_API_KEY/);
});

test("validate : incohérence stratégie/capacités du site (strict sans information d'adjacence, headless + plan manuel)", async () => {
  const adapter = new ExampleSite();
  const patched = Object.create(adapter, { meta: { value: { ...adapter.meta, capabilities: { ...adapter.meta.capabilities, reportsSeatAdjacency: false, seatSelection: "manual" } } } });
  const r = await validateConfig(write(base({ tickets: { quantity: 2, maxPricePerTicket: 50, seatsTogether: true, seatsTogetherStrict: true }, browser: { headless: true } })), { now: NOW, env: {}, adapters: [patched] });
  assert.match(r.warnings.join(" "), /aucune offre ne sera jamais retenue/);
  assert.match(r.errors.join(" "), /choix de places manuel/);
  assert.equal(r.ok, false);
});

test("validate : les options propres au site sont validées par l'adaptateur", async () => {
  const adapter = new ExampleSite();
  const withOpts = Object.create(adapter, { validateOptions: { value: (o: Record<string, unknown>) => (o.token ? [] : ["token requis"]) } });
  const r = await validateConfig(write(base()), { now: NOW, env: {}, adapters: [withOpts] });
  assert.match(r.errors.join(" "), /token requis/);
});

test("la découverte fournit toujours au moins l'adaptateur de démo", async () => {
  assert.ok((await discoverAdapters()).some((a) => a.meta.id === "example"));
  void readConfigFile;
});
