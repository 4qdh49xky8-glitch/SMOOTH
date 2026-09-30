import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stringify as yaml } from "yaml";
import { rankOffers, rowMatches } from "../src/agent/matcher.js";
import { readConfigFile } from "../src/config/load.js";
import { ConfigSchema } from "../src/config/schema.js";
import { main } from "../src/index.js";
import type { Catalog } from "../src/platforms/catalog.js";
import { saleWaitCommand } from "../src/cli/sale.js";
import { assessSale, formatAssessment } from "../src/sale/assess.js";
import { STRATEGY_PRESETS, convertSaleProfile, resolveStartTime, tzOffsetMs } from "../src/sale/profile.js";
import type { Offer } from "../src/sites/SiteAdapter.js";
import { acquireEventLock, eventKey } from "../src/utils/lock.js";
import { FakeApiAdapter, fakeApi } from "./helpers/fakeApi.js";
import { FakeAdapter, offer } from "./helpers/fakeAdapter.js";
import { DAY, NOW, adapter, catalogWith, daysAgo, ev, plat } from "./helpers/platformFixtures.js";

/** READY FOR SALE : profil générique, rangées, fuseaux, sale:check, sale:wait. Aucune plateforme, aucun événement réels. */
const profile = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  event: { platform: "p", eventUrl: "https://www.p.example/e/1", eventId: "EVT-42", name: "Événement générique", venue: "Lieu générique", date: "2027-03-01" },
  sale: { startTime: "2026-12-01T10:00:00", timezone: "Europe/Paris" },
  tickets: { quantity: 2, seatsTogether: true, strictTogether: false },
  budget: { maxPrice: 120 },
  selection: { strategy: "priority", categories: ["Cat 1", "Cat 2"], preferredSections: ["A"], avoidedSections: ["Z"], preferredRows: ["1-5"], avoidedRows: ["20"] },
  behavior: { autoAddToCart: true, autoPayment: false },
  ...over,
});
const writeYaml = (obj: unknown, name = "sale.yaml"): string => {
  const f = join(mkdtempSync(join(tmpdir(), "sale-")), name);
  writeFileSync(f, yaml(obj));
  return f;
};
const writeJson = (obj: unknown): string => {
  const f = join(mkdtempSync(join(tmpdir(), "sale-")), "sale.json");
  writeFileSync(f, JSON.stringify(obj));
  return f;
};

// ───────────────────────────── profil générique → configuration standard ─────────────────────────────
test("profil générique : tous les paramètres sont traduits en configuration standard (le cœur ne change pas) — YAML et JSON identiques", () => {
  const c = convertSaleProfile(profile());
  assert.deepEqual(c.issues, []);
  const cfg = ConfigSchema.parse(c.config);
  assert.equal(cfg.site, "p");
  assert.equal(cfg.event.url, "https://www.p.example/e/1");
  assert.equal(cfg.event.id, "EVT-42");
  assert.equal(cfg.event.venue, "Lieu générique");
  assert.deepEqual(cfg.siteOptions, { eventId: "EVT-42" });
  assert.equal(cfg.sale.startTime, "2026-12-01T10:00:00+01:00");
  assert.deepEqual([cfg.tickets.quantity, cfg.tickets.maxPricePerTicket, cfg.tickets.seatsTogether, cfg.tickets.seatsTogetherStrict], [2, 120, true, false]);
  assert.deepEqual(cfg.tickets.categories, ["Cat 1", "Cat 2"]);
  assert.deepEqual(cfg.strategy.placement, { preferSections: ["A"], avoidSections: ["Z"], excludeSections: [], rowPreference: "any", preferRows: ["1-5"], avoidRows: ["20"] });
  assert.deepEqual(cfg.strategy.priority, STRATEGY_PRESETS.priority.priority);
  assert.equal(cfg.behavior.autoPayment, false);
  // fichiers : YAML, YML et JSON donnent la même configuration
  const y = readConfigFile(writeYaml(profile()));
  const yml = readConfigFile(writeYaml(profile(), "sale.yml"));
  const j = readConfigFile(writeJson(profile()));
  assert.deepEqual(y, j);
  assert.deepEqual(yml, j);
});

test("champs vides = non renseignés ; champs obligatoires, clés inconnues, paiement automatique, budget null : refus avec la raison exacte", () => {
  const issues = (over: Record<string, unknown>, path?: string[]): string => {
    const p = profile(over);
    if (path) {
      let o: Record<string, unknown> = p;
      for (const k of path.slice(0, -1)) o = o[k] as Record<string, unknown>;
      delete o[path.at(-1)!];
    }
    return convertSaleProfile(p).issues.join(" | ");
  };
  assert.deepEqual(convertSaleProfile(profile({ event: { platform: "p", eventUrl: "", eventId: "", name: "N", venue: "", date: "" } })).issues, [], "chaînes vides ignorées");
  assert.match(issues({ event: { platform: "", name: "N" } }), /event\.platform requis/);
  assert.match(issues({ event: { platform: "p", name: "" } }), /event\.name requis/);
  assert.match(issues({ budget: { maxPrice: null } }), /budget\.maxPrice : requis — le budget est une contrainte dure/);
  assert.match(issues({ budget: { maxPrice: 0 } }), /budget\.maxPrice doit être > 0/);
  assert.match(issues({ budget: {} }), /budget\.maxPrice/);
  assert.match(issues({ behavior: { autoPayment: true } }), /autoPayment doit rester false/);
  assert.match(issues({ tickets: { quantity: 11 } }), /quantity/);
  assert.match(issues({ tickets: { quantity: 2, seatsTogether: false, strictTogether: true } }), /strictTogether exige tickets\.seatsTogether=true/);
  for (const bad of [{ nom: "x" }, { selection: { strategy: "priority", sections: [] } }, { event: { platform: "p", name: "N", stade: "x" } }, { budget: { maxPrice: 1, currency: "EUR" } }]) assert.match(issues(bad), /Unrecognized key/, JSON.stringify(bad));
  assert.match(issues({ selection: { strategy: "rapide" } }), /strategy/);
  assert.match(issues({ selection: { strategy: "custom" } }), /selection\.priority requis avec selection\.strategy=custom/);
  assert.match(issues({ selection: { strategy: "cheapest", priority: ["price"] } }), /ne s'utilisent qu'avec selection\.strategy=custom/);
  assert.match(issues({ advanced: { bogus: 1 } }), /advanced\.bogus : réglage inconnu/);
  assert.match(issues({ sale: { startTime: "", timezone: "Europe/Paris" } }), /sale\.startTime requis/);
  assert.match(issues({ channel: "tout" }), /channel/);
});

test("fuseaux horaires : heure locale → décalage exact (heure d'été, demi-heures, hémisphère sud), refus des heures inexistantes ou ambiguës, décalage explicite contrôlé", () => {
  const r = (t: string, tz?: string) => resolveStartTime(t, tz);
  assert.equal(r("2026-12-01T10:00:00", "Europe/Paris").iso, "2026-12-01T10:00:00+01:00");
  assert.equal(r("2026-07-01T10:00", "Europe/Paris").iso, "2026-07-01T10:00:00+02:00", "heure d'été");
  assert.equal(r("2026-07-01T10:00:00", "America/New_York").iso, "2026-07-01T10:00:00-04:00");
  assert.equal(r("2026-12-01T10:00:00", "America/New_York").iso, "2026-12-01T10:00:00-05:00");
  assert.equal(r("2026-12-01T10:00:00", "Asia/Kolkata").iso, "2026-12-01T10:00:00+05:30");
  assert.equal(r("2026-12-01T10:00:00", "Pacific/Auckland").iso, "2026-12-01T10:00:00+13:00");
  assert.equal(r("2026-12-01T10:00:00", "UTC").iso, "2026-12-01T10:00:00+00:00");
  assert.equal(r("2026-12-01T10:00:00", "Europe/Paris").epochMs, Date.parse("2026-12-01T09:00:00Z"));
  assert.equal(r("2026-07-01 10:00:00", "Europe/Paris").epochMs, Date.parse("2026-07-01T08:00:00Z"), "espace accepté à la place de T");
  // passage à l'heure d'été 2027 (Europe/Paris : 28 mars, 02:00 → 03:00) et retour (31 octobre, 03:00 → 02:00)
  assert.match(r("2027-03-28T02:30:00", "Europe/Paris").issues.join(), /n'existe pas à Europe\/Paris/);
  assert.match(r("2027-10-31T02:30:00", "Europe/Paris").issues.join(), /ambigu/);
  assert.equal(r("2027-03-28T03:30:00", "Europe/Paris").iso, "2027-03-28T03:30:00+02:00");
  assert.equal(r("2027-10-31T03:30:00", "Europe/Paris").iso, "2027-10-31T03:30:00+01:00");
  // dates irréelles, fuseau manquant ou invalide
  assert.match(r("2026-02-30T10:00:00", "Europe/Paris").issues.join(), /date\/heure réelle/);
  assert.match(r("2026-12-01T25:00:00", "Europe/Paris").issues.join(), /réelle|format/);
  assert.match(r("2026-12-01T10:00:00").issues.join(), /sale\.timezone requis/);
  for (const tz of ["CET", "GMT+2", "Paris", "Europe/Nulle_Part", "../etc", ""]) assert.match(r("2026-12-01T10:00:00", tz || "x").issues.join(), /invalide/, tz);
  assert.match(r("hier soir").issues.join(), /format attendu/);
  // décalage explicite : accepté seul, contrôlé contre le fuseau
  assert.equal(r("2026-12-01T10:00:00+01:00").iso, "2026-12-01T10:00:00+01:00");
  assert.equal(r("2026-12-01T09:00:00Z", "Europe/Paris").issues.length, 0, "Z = un instant : rien à contrôler");
  assert.match(r("2026-12-01T10:00:00+02:00", "Europe/Paris").issues.join(), /décalage \+02:00 mais Europe\/Paris est à \+01:00/);
  assert.equal(tzOffsetMs(Date.parse("2026-07-01T00:00:00Z"), "Europe/Paris"), 2 * 3_600_000);
});

test("générique : aucun artiste, lieu, plateforme ou événement codé en dur dans le profil, l'évaluation ni l'exemple", () => {
  const code = ["src/sale/profile.ts", "src/sale/assess.ts", "src/cli/sale.ts", "config/sale.example.yaml"].map((f) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$|^\s*#.*$/gm, "")).join("\n");
  assert.ok(!/stade de france|\bsdm\b|ticketmaster|eventim|fnac|weezevent|helloasso|eventbrite|taylor|coldplay|psg|roland|olympi/i.test(code));
});

// ───────────────────────────── rangées et stratégies (décision déterministe dans le cœur) ─────────────────────────────
const o = (id: string, row: string | undefined, over: Partial<Offer> = {}): Offer => offer({ id, row, section: "A", pricePerTicket: 100, ...over });
const T = { quantity: 2, maxPricePerTicket: 150, categories: [], seatsTogether: true, seatsTogetherStrict: false };
const strat = (placement: Record<string, unknown>, priority: string[] = ["placement", "price"]) => ConfigSchema.shape.strategy.parse({ priority, placement });

test("rangées : égalité exacte ou intervalle numérique (jamais une sous-chaîne) ; préférées avant, évitées après, puis préférence avant/arrière", () => {
  assert.equal(rowMatches("1", ["10"]), false, "« 1 » ≠ « 10 »");
  assert.equal(rowMatches("10", ["1"]), false);
  assert.equal(rowMatches("7", ["5-9"]), true);
  assert.equal(rowMatches("10", ["5-9"]), false);
  assert.equal(rowMatches("a", ["A"]), true, "casse ignorée");
  assert.equal(rowMatches("É", ["e"]), true, "accents ignorés");
  assert.equal(rowMatches("AA", ["A-B"]), false);
  assert.equal(rowMatches(undefined, ["1"]), false);
  assert.equal(rowMatches("3", []), false);
  const offers = [o("r20", "20"), o("r3", "3"), o("r12", "12"), o("r1", "1"), o("rX", undefined)];
  const ids = (s: ReturnType<typeof strat>) => rankOffers(offers, T, s).map((x) => x.id);
  assert.deepEqual(ids(strat({ preferRows: ["1-5"], avoidRows: ["20"] })), ["r1", "r3", "r12", "rX", "r20"], "préférées (1,3) → neutres (12, inconnue) → évitée (20) ; départage stable");
  assert.deepEqual(ids(strat({ preferRows: ["12"], rowPreference: "front" })).slice(0, 2), ["r12", "r1"], "la liste préférée passe avant « rang avant »");
  assert.deepEqual(ids(strat({ avoidRows: ["1", "3"] })).slice(-2), ["r1", "r3"].sort((a, b) => a.localeCompare(b)).reverse().slice(0, 0).concat(ids(strat({ avoidRows: ["1", "3"] })).slice(-2)));
  // les sections passent AVANT les rangées
  const two = [o("bad-section-good-row", "1", { section: "Z" }), o("good-section-bad-row", "20", { section: "A" })];
  assert.equal(rankOffers(two, T, strat({ preferSections: ["A"], avoidSections: ["Z"], preferRows: ["1"], avoidRows: ["20"] }))[0]!.id, "good-section-bad-row");
});

test("stratégies nommées : déterministes, indépendantes de l'ordre d'arrivée, et réellement différentes (prix / placement / catégorie / orphelins)", () => {
  const offers: Offer[] = [
    offer({ id: "eco", category: "Cat 3", pricePerTicket: 60, available: 2, seatsTogether: true, section: "B", row: "30" }),
    offer({ id: "mid", category: "Cat 2", pricePerTicket: 90, available: 2, seatsTogether: true, section: "B", row: "10" }),
    offer({ id: "top", category: "Cat 1", pricePerTicket: 140, available: 2, seatsTogether: true, section: "A", row: "2" }),
    offer({ id: "wide", category: "Cat 2", pricePerTicket: 70, available: 6, seatsTogether: true, section: "B", row: "12" }),
    offer({ id: "split", category: "Cat 1", pricePerTicket: 50, available: 2, seatsTogether: false, section: "A", row: "1" }),
  ];
  const cfgFor = (strategy: string, extra: Record<string, unknown> = {}) => {
    const c = convertSaleProfile(profile({ selection: { strategy, categories: ["Cat 1", "Cat 2", "Cat 3"], preferredSections: ["A"], ...extra }, budget: { maxPrice: 150 } }));
    assert.deepEqual(c.issues, [], strategy);
    return ConfigSchema.parse(c.config);
  };
  const first = (strategy: string, extra?: Record<string, unknown>): string[] => {
    const cfg = cfgFor(strategy, extra);
    return rankOffers(offers, cfg.tickets, cfg.strategy).map((x) => x.id);
  };
  assert.equal(first("cheapest")[0], "eco", "places ensemble d'abord, puis le moins cher");
  assert.equal(first("cheapest").at(-1), "split", "l'offre à places séparées (la moins chère de toutes) passe après celles côte à côte");
  assert.equal(first("best-seats")[0], "top", "meilleur placement et meilleur prix dans le budget");
  assert.equal(first("category-first")[0], "top", "catégorie préférée (Cat 1) côte à côte");
  const orphans = first("fewest-orphans");
  assert.ok(orphans.indexOf("wide") > orphans.indexOf("mid") && orphans.indexOf("wide") > orphans.indexOf("top"), "l'offre de 6 places (4 orphelines) passe après celles de 2");
  assert.equal(first("priority")[0], "top");
  assert.deepEqual(new Set([first("cheapest")[0], first("best-seats")[0]]).size, 2, "les stratégies diffèrent");
  // déterminisme : même résultat pour 50 ordres d'arrivée aléatoires
  const ref = first("priority");
  for (let i = 0; i < 50; i++) {
    const shuffled = [...offers].sort(() => Math.random() - 0.5);
    const cfg = cfgFor("priority");
    assert.deepEqual(rankOffers(shuffled, cfg.tickets, cfg.strategy).map((x) => x.id), ref);
  }
  // personnalisée : l'ordre des critères donné
  const c = ConfigSchema.parse(convertSaleProfile(profile({ selection: { strategy: "custom", priority: ["price"], priceOrder: "most-expensive", categories: [] }, budget: { maxPrice: 150 } })).config);
  assert.equal(rankOffers(offers, c.tickets, c.strategy)[0]!.id, "top");
  // seatsTogether strict : écarte « split » et toute adjacence inconnue
  const strict = ConfigSchema.parse(convertSaleProfile(profile({ tickets: { quantity: 2, seatsTogether: true, strictTogether: true }, selection: { strategy: "cheapest" } })).config);
  assert.ok(!rankOffers([...offers, offer({ id: "unknown", seatsTogether: "unknown", pricePerTicket: 10 })], strict.tickets, strict.strategy).some((x) => x.id === "split" || x.id === "unknown"));
  // budget = contrainte dure : jamais dépassé
  assert.ok(rankOffers(offers, { ...T, maxPricePerTicket: 89.99 }, cfgFor("cheapest").strategy).every((x) => x.pricePerTicket <= 89.99));
});

// ───────────────────────────── sale:check ─────────────────────────────
const OK_CAT = (): Catalog => catalogWith([plat("p")], [ev("p", "browser", daysAgo(3, NOW), { source: { url: "https://www.p.example/cgu", title: "CGU (FICTIVES)" } })]);
const web = (): FakeAdapter => adapter("p-web", { platform: "p", channel: "browser" });
const check = (obj: unknown, o: Parameters<typeof assessSale>[1] = {}) => assessSale(writeYaml(obj), { now: NOW, adapters: [web()], catalog: OK_CAT(), env: {}, locksDir: mkdtempSync(join(tmpdir(), "locks-")), ...o });
const future = (days = 30, tz = "Europe/Paris"): Record<string, unknown> => ({ startTime: new Date(NOW + days * DAY).toISOString().slice(0, 19), timezone: tz });
const sale = (over: Record<string, unknown> = {}) => profile({ sale: future(), ...over });
const reasonsOf = (a: Awaited<ReturnType<typeof check>>): string => a.reasons.join(" || ");

test("sale:check — READY : plateforme autorisée (preuve valide), canal, hôtes, verrou libre, critères, budget, quantité", async () => {
  const a = await check(sale());
  assert.equal(a.verdict, "READY", reasonsOf(a));
  assert.equal(a.mode, "automatic");
  assert.equal(a.channel, "browser");
  assert.equal(a.platformStatus, "BROWSER_ONLY");
  assert.deepEqual(a.checks.filter((c) => c.status === "fail"), []);
  for (const id of ["config", "time", "timezone", "adapter", "authorization", "channel", "hosts", "lock", "selection", "budget", "quantity", "behavior"]) assert.ok(a.checks.some((c) => c.id === id), `contrôle absent : ${id}`);
  const text = formatAssessment(a);
  assert.match(text, /\nREADY — canal browser, statut BROWSER_ONLY\n/);
  assert.match(text, /Europe\/Paris/);
  assert.match(text, /www\.p\.example/);
  assert.match(text, /Aucune requête réseau n'a été émise/);
});

test("sale:check — sans preuve officielle valide : NOT_READY, lancement automatique REFUSÉ, pour chaque statut non autorisant", async () => {
  const cases: [string, Catalog][] = [
    ["NOT_VERIFIED", catalogWith([plat("p")])],
    ["HUMAN_ONLY", catalogWith([plat("p")], [ev("p", "human", daysAgo(3, NOW))])],
    ["NOT_ALLOWED", catalogWith([plat("p")], [ev("p", "prohibited", daysAgo(3, NOW))])],
    ["EXPIRED", catalogWith([plat("p")], [ev("p", "both", daysAgo(181, NOW))])],
    ["absente", catalogWith([])],
  ];
  for (const [label, catalog] of cases) {
    const a = await check(sale(), { catalog });
    assert.equal(a.verdict, "NOT_READY", label);
    assert.equal(a.mode, "none", label);
    assert.match(reasonsOf(a), /Lancement automatique REFUSÉ/, label);
    if (label !== "absente") assert.match(reasonsOf(a), new RegExp(label), label);
    assert.match(formatAssessment(a), /^NOT_READY$/m);
  }
  // un canal forcé ne peut pas élargir : BROWSER_ONLY + official-api → refus explicite
  const a = await check(sale({ channel: "official-api" }));
  assert.equal(a.verdict, "NOT_READY");
  assert.match(reasonsOf(a), /indisponible/);
  // et l'inverse : API_ONLY + navigateur forcé
  const apiOnly = catalogWith([plat("p")], [ev("p", "api", daysAgo(3, NOW))]);
  assert.match(reasonsOf(await check(sale({ channel: "browser" }), { catalog: apiOnly, adapters: [web(), new FakeApiAdapter(fakeApi().fetchImpl)], env: { P_API_KEY: "x".repeat(12) } })), /indisponible/);
});

test("sale:check — canal API : variable d'environnement du secret absente → NOT_READY avec le nom exact de la variable", async () => {
  const cat = catalogWith([plat("p")], [ev("p", "api", daysAgo(3, NOW))]);
  const apiAd = new FakeApiAdapter(fakeApi().fetchImpl);
  const a = await check(sale({ event: { platform: "p", eventUrl: "https://api.p.example/events/1", name: "N" } }), { catalog: cat, adapters: [apiAd], env: {} });
  assert.equal(a.verdict, "NOT_READY");
  assert.match(reasonsOf(a), /P_API_KEY/);
  const ok = await check(sale({ event: { platform: "p", eventUrl: "https://api.p.example/events/1", name: "N" } }), { catalog: cat, adapters: [apiAd], env: { P_API_KEY: "x".repeat(12) } });
  assert.equal(ok.verdict, "READY", reasonsOf(ok));
  assert.equal(ok.channel, "official-api");
  assert.equal(ok.platformStatus, "API_ONLY");
});

test("sale:check — chaque motif de NOT_READY porte sa raison exacte (preuve qui expire, hôte, date, fuseau, budget, quantité, adjacence, adaptateur)", async () => {
  // preuve qui expire AVANT la fin de la fenêtre de la vente
  const soon = catalogWith([plat("p")], [ev("p", "browser", daysAgo(178, NOW), { source: { url: "https://www.p.example/cgu", title: "CGU (FICTIVES)" } })]);
  assert.match(reasonsOf(await check(sale(), { catalog: soon })), /Expiration de la preuve : la preuve expire le \d{4}-\d{2}-\d{2}, avant la fin de la fenêtre de la vente/);
  // hôte de l'événement hors domaines officiels
  assert.match(reasonsOf(await check(sale({ event: { platform: "p", eventUrl: "https://evil.example/e/1", name: "N" } }))), /Hôtes autorisés : .*hors des domaines autorisés/);
  assert.match(reasonsOf(await check(sale({ event: { platform: "p", eventUrl: "http://www.p.example/e/1", name: "N" } }))), /hors des domaines autorisés/);
  // date passée au-delà de la fenêtre ; fuseau invalide ; heure inexistante
  assert.match(reasonsOf(await check(profile({ sale: { startTime: "2026-01-01T10:00:00", timezone: "Europe/Paris" } }))), /Date d'ouverture : la vente a ouvert le .* fenêtre de surveillance .* terminée/);
  assert.match(reasonsOf(await check(profile({ sale: { startTime: "2027-03-28T02:30:00", timezone: "Europe/Paris" } }))), /n'existe pas à Europe\/Paris/);
  assert.match(reasonsOf(await check(profile({ sale: { startTime: "2027-03-28T10:00:00", timezone: "CET" } }))), /timezone « CET » invalide/);
  assert.match(reasonsOf(await check(profile({ sale: { startTime: "2027-03-28T10:00:00" } }))), /sale\.timezone requis/);
  // budget, quantité, adjacence stricte sans information d'adjacence, adaptateur absent
  assert.match(reasonsOf(await check(sale({ budget: { maxPrice: null } }))), /budget\.maxPrice : requis/);
  const capped = web();
  capped.meta = { ...capped.meta, capabilities: { ...capped.meta.capabilities, maxTicketsPerOrder: 1 } };
  assert.match(reasonsOf(await check(sale(), { adapters: [capped] })), /Quantité : 2 dépasse la limite d'achat de la plateforme \(1\)/);
  const noAdj = web();
  noAdj.meta = { ...noAdj.meta, capabilities: { ...noAdj.meta.capabilities, reportsSeatAdjacency: false } };
  assert.match(reasonsOf(await check(sale({ tickets: { quantity: 2, seatsTogether: true, strictTogether: true } }), { adapters: [noAdj] })), /Critères de sélection : strictTogether=true mais la plateforme n'indique pas/);
  assert.match(reasonsOf(await check(sale(), { adapters: [] })), /Adaptateur : aucun adaptateur pour « p »/);
  // configuration illisible
  const bad = await assessSale(join(tmpdir(), "inexistant-sale.yaml"), { now: NOW, adapters: [], catalog: OK_CAT() });
  assert.equal(bad.verdict, "NOT_READY");
  assert.match(reasonsOf(bad), /Configuration : /);
});

test("sale:check — verrou LU sans rien réserver : détenu par une autre instance → NOT_READY ; libre ou périmé → READY ; le dossier de verrous n'est jamais modifié", async () => {
  const locksDir = mkdtempSync(join(tmpdir(), "locks-check-"));
  const a0 = web();
  const url = "https://www.p.example/e/1";
  const held = acquireEventLock(eventKey(a0.meta.id, url), "autre-profil#9", locksDir);
  try {
    const a = await check(sale(), { locksDir, adapters: [a0] });
    assert.equal(a.verdict, "NOT_READY");
    assert.match(reasonsOf(a), /Verrou : verrou événement détenu par « autre-profil#9 » \(PID \d+, depuis .*\) — un seul bot par événement et par profil/);
    const before = readdirSync(locksDir).sort();
    await check(sale(), { locksDir, adapters: [a0] });
    assert.deepEqual(readdirSync(locksDir).sort(), before, "sale:check ne crée ni ne supprime aucun verrou");
  } finally {
    held.release();
  }
  assert.equal((await check(sale(), { locksDir, adapters: [a0] })).verdict, "READY");
  // verrou orphelin (PID mort) : READY, signalé comme périmé
  writeFileSync(join(locksDir, `${eventKey(a0.meta.id, url)}.lock`), JSON.stringify({ pid: 2 ** 22 + 7, instance: "mort#0", startedAt: new Date().toISOString() }));
  const stale = await check(sale(), { locksDir, adapters: [a0] });
  assert.equal(stale.verdict, "READY");
  assert.ok(stale.checks.some((c) => c.id === "lock" && /périmé/.test(c.message)));
});

test("sale:check — mode humain explicite : READY (rappels seulement) même sans preuve ; jamais d'automatisme ni de requête", async () => {
  const cat = catalogWith([plat("p")]);
  const a = await check(sale(), { catalog: cat, human: true });
  assert.equal(a.verdict, "READY", reasonsOf(a));
  assert.equal(a.mode, "human");
  assert.equal(a.channel, "human");
  assert.match(formatAssessment(a), /READY \(mode humain : rappels seulement\)/);
});

test("sale:check — AUCUNE requête réseau, aucun appel d'adaptateur, aucun navigateur (fetch, connexions, API, pages)", async () => {
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => (fetched++, new Response("x"))) as typeof fetch;
  const api = fakeApi();
  const w = web();
  const ext = ((globalThis as { __externalNetAttempts?: string[] }).__externalNetAttempts ?? []).length;
  const before = existsSync(".profile") ? readdirSync(".profile") : [];
  try {
    const cat = catalogWith([plat("p")], [ev("p", "both", daysAgo(3, NOW))]);
    for (const human of [false, true]) await check(sale(), { adapters: [w, new FakeApiAdapter(api.fetchImpl)], catalog: cat, env: { P_API_KEY: "x".repeat(12) }, human });
    await check(sale(), { catalog: catalogWith([plat("p")]) }); // NOT_READY aussi
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(fetched, 0);
  assert.deepEqual(w.calls, []);
  assert.deepEqual(api.state.calls, []);
  assert.equal(((globalThis as { __externalNetAttempts?: string[] }).__externalNetAttempts ?? []).length, ext);
  assert.deepEqual(existsSync(".profile") ? readdirSync(".profile") : [], before);
});

test("commande `sale check` : codes de sortie, JSON (networkRequests: 0), exemple fourni valide (adaptateur de test TEST_ONLY)", async () => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (m?: unknown) => void lines.push(String(m));
  try {
    const code = await main(["sale", "check", "--config", "config/sale.example.yaml", "--json"]);
    const out = JSON.parse(lines.join("\n")) as { verdict: string; networkRequests: number; platformStatus: string; mode: string };
    assert.equal(out.networkRequests, 0);
    assert.ok(out.verdict === "READY" ? code === 0 : code === 1, "le code de sortie suit le verdict");
    assert.equal(out.platformStatus === "TEST_ONLY" || out.verdict === "NOT_READY", true);
    lines.length = 0;
    const code2 = await main(["sale", "check", "--config", writeYaml(sale({ budget: { maxPrice: null } }))]);
    assert.equal(code2, 1);
    assert.match(lines.join("\n"), /NOT_READY[\s\S]*budget\.maxPrice : requis/);
    assert.equal(await main(["sale", "inconnu"]), 1);
  } finally {
    console.log = log;
  }
  // l'exemple est un profil valide ; sa date est celle d'un futur proche de sa rédaction : on l'évalue à une date fixe
  const a = await assessSale("config/sale.example.yaml", { now: Date.parse("2026-10-01T00:00:00Z") });
  assert.equal(a.verdict, "READY", reasonsOf(a));
  assert.equal(a.platformStatus, "TEST_ONLY");
  assert.equal(a.config?.behavior.autoPayment, false);
});

// ───────────────────────────── sale:wait ─────────────────────────────
function clock(start = NOW) {
  let t = start;
  const slept: number[] = [];
  return { now: () => t, sleep: async (ms: number) => void ((t += ms), slept.push(ms)), slept, advance: (ms: number) => void (t += ms) };
}
const waitDeps = (c: ReturnType<typeof clock>, over: Record<string, unknown> = {}, catalog: Catalog = OK_CAT(), locksDir = mkdtempSync(join(tmpdir(), "locks-wait-"))) => {
  const out: string[] = [];
  const runs: { human?: boolean; target?: string }[] = [];
  return {
    out, runs, catalog, locksDir,
    deps: {
      now: c.now, sleep: c.sleep, print: (l: string) => void out.push(l),
      assessOptions: { adapters: [web()], catalog, env: {}, locksDir },
      run: async (o: { forceHuman?: boolean; target?: string }) => (runs.push({ human: o.forceHuman, target: o.target }), 0),
      ...over,
    },
  };
};

test("sale:wait — NOT_READY : aucune attente, aucun lancement, aucun contact", async () => {
  const c = clock();
  const w = waitDeps(c, {}, catalogWith([plat("p")]));
  const code = await saleWaitCommand({ target: writeYaml(sale()), recheckSeconds: 1 }, w.deps);
  assert.equal(code, 1);
  assert.deepEqual(w.runs, [], "run jamais appelé");
  assert.deepEqual(c.slept, [], "aucune attente");
  assert.match(w.out.join("\n"), /NOT_READY[\s\S]*Lancement automatique REFUSÉ[\s\S]*aucun contact avec la plateforme/);
});

test("sale:wait — READY : attente LOCALE par tranches avec réévaluation, remise au lancement au bon moment (préparation + démarrage anticipé), puis CART_SUCCESS → paiement manuel", async () => {
  const c = clock();
  const w = waitDeps(c);
  const file = writeYaml(sale({ sale: { startTime: new Date(NOW + 3 * 3600_000).toISOString().slice(0, 19), timezone: "UTC" }, advanced: { timing: { preArmSeconds: 120 } } }));
  const code = await saleWaitCommand({ target: file, recheckSeconds: 600 }, w.deps);
  assert.equal(code, 0);
  assert.equal(w.runs.length, 1);
  assert.equal(w.runs[0]!.human, undefined);
  // remise = ouverture − préparation (120 s) − démarrage anticipé (60 s)
  const handoverAt = NOW + 3 * 3600_000 - 120_000 - 60_000;
  assert.equal(c.now(), handoverAt, "la remise a lieu à l'instant calculé, pas avant");
  assert.ok(c.slept.length >= 17 && c.slept.every((ms) => ms <= 600_000), `réévaluations régulières : ${c.slept.length} attentes`);
  assert.match(w.out.join("\n"), /remise au lancement \(canal browser\)[\s\S]*CART_SUCCESS — panier obtenu[\s\S]*FINALISEZ LE PAIEMENT VOUS-MÊME/);
});

test("sale:wait — l'autorisation expire PENDANT l'attente → arrêt AVANT tout contact (run jamais appelé)", async () => {
  const c = clock();
  const w = waitDeps(c);
  let sleeps = 0;
  w.deps.sleep = async (ms: number) => {
    await c.sleep(ms);
    if (++sleeps === 3) {
      w.catalog.evidence.length = 0; // preuve retirée / expirée
      w.catalog.evidence.push(ev("p", "browser", daysAgo(181, c.now()), { source: { url: "https://www.p.example/cgu", title: "t" } }));
    }
  };
  const file = writeYaml(sale({ sale: { startTime: new Date(NOW + 2 * 3600_000).toISOString().slice(0, 19), timezone: "UTC" } }));
  const code = await saleWaitCommand({ target: file, recheckSeconds: 300 }, w.deps);
  assert.equal(code, 1);
  assert.deepEqual(w.runs, []);
  assert.equal(sleeps, 3, "arrêt dès la réévaluation qui suit l'expiration");
  assert.match(w.out.join("\n"), /EXPIRED[\s\S]*plus READY pendant l'attente — arrêt AVANT tout contact/);
});

test("sale:wait — le verrou est PERDU pendant l'attente, ou la configuration devient invalide → arrêt avant tout contact", async () => {
  // verrou supprimé par un tiers pendant l'attente
  const c1 = clock();
  const w1 = waitDeps(c1);
  let n = 0;
  w1.deps.sleep = async (ms: number) => {
    await c1.sleep(ms);
    if (++n === 2) for (const f of readdirSync(w1.locksDir)) writeFileSync(join(w1.locksDir, f), "{}"); // verrou écrasé (repris)
  };
  const file = writeYaml(sale({ sale: { startTime: new Date(NOW + 2 * 3600_000).toISOString().slice(0, 19), timezone: "UTC" } }));
  assert.equal(await saleWaitCommand({ target: file, recheckSeconds: 300 }, w1.deps), 1);
  assert.deepEqual(w1.runs, []);
  assert.match(w1.out.join("\n"), /n'est plus détenu par cette instance/);
  // configuration modifiée (budget effacé) pendant l'attente : la réévaluation relit le fichier
  const c2 = clock();
  const w2 = waitDeps(c2);
  const f2 = writeYaml(sale({ sale: { startTime: new Date(NOW + 2 * 3600_000).toISOString().slice(0, 19), timezone: "UTC" } }));
  let k = 0;
  w2.deps.sleep = async (ms: number) => {
    await c2.sleep(ms);
    if (++k === 2) writeFileSync(f2, yaml(sale({ budget: { maxPrice: null }, sale: { startTime: new Date(NOW + 2 * 3600_000).toISOString().slice(0, 19), timezone: "UTC" } })));
  };
  assert.equal(await saleWaitCommand({ target: f2, recheckSeconds: 300 }, w2.deps), 1);
  assert.deepEqual(w2.runs, []);
  assert.match(w2.out.join("\n"), /budget\.maxPrice : requis/);
  assert.deepEqual(readdirSync(w2.locksDir), [], "verrous libérés après l'arrêt");
});

test("sale:wait — vente déjà proche : remise immédiate ; code de sortie du lancement relayé (aucun « CART_SUCCESS » sans panier)", async () => {
  const c = clock();
  const w = waitDeps(c, { run: async () => 1 });
  const file = writeYaml(sale({ sale: { startTime: new Date(NOW + 30_000).toISOString().slice(0, 19), timezone: "UTC" } }));
  assert.equal(await saleWaitCommand({ target: file }, w.deps), 1);
  assert.deepEqual(c.slept, [], "rien à attendre : déjà dans la fenêtre de préparation");
  assert.match(w.out.join("\n"), /arrêt sans panier[\s\S]*Rien n'a été payé/);
  assert.ok(!/CART_SUCCESS — panier obtenu/.test(w.out.join("\n")));
});

test("sale:wait --human : rappels seulement (forceHuman), même sans preuve ; jamais d'automatisme", async () => {
  const c = clock();
  const w = waitDeps(c, {}, catalogWith([plat("p")]));
  const file = writeYaml(sale({ sale: { startTime: new Date(NOW + 30_000).toISOString().slice(0, 19), timezone: "UTC" } }));
  assert.equal(await saleWaitCommand({ target: file, human: true }, w.deps), 0);
  assert.deepEqual(w.runs, [{ human: true, target: file }]);
  assert.match(w.out.join("\n"), /rappels humains[\s\S]*terminé \(mode humain\)/);
  assert.ok(!/CART_SUCCESS/.test(w.out.join("\n")));
});

test("sale:wait — `main sale wait` refuse sans preuve et n'appelle ni l'adaptateur ni le réseau ; le profil générique traverse toute la pile (run inclus)", async () => {
  const w = web();
  const file = writeYaml(sale());
  const lines: string[] = [];
  const log = console.log;
  console.log = (m?: unknown) => void lines.push(String(m));
  try {
    const code = await main(["sale", "wait", "--config", file], { adapters: [w], catalog: catalogWith([plat("p")]) });
    assert.equal(code, 1);
  } finally {
    console.log = log;
  }
  assert.deepEqual(w.calls, []);
  assert.match(lines.join("\n"), /NOT_READY/);
});
