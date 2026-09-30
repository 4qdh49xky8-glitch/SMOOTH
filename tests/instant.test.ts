import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InstantClaude, runInstantSale, type InstantSaleDeps, type InstantSaleResult } from "../src/instant/runner.js";
import { SaleMonitor, instrument, newCounts } from "../src/instant/monitor.js";
import { compileSelection } from "../src/instant/compile.js";
import { formatPerformance } from "../src/instant/report.js";
import { Timeline } from "../src/instant/timeline.js";
import { rankOffers } from "../src/agent/matcher.js";
import { ConfigSchema } from "../src/config/schema.js";
import { SelectorNotFoundError, RateLimitedError } from "../src/utils/errors.js";
import type { Catalog } from "../src/platforms/catalog.js";
import type { AdapterContext, Blocker, Offer } from "../src/sites/SiteAdapter.js";
import { ScriptedSaleAdapter, type SaleFrame, type ScriptedSaleOptions } from "../testkit/scriptedSale.js";
import { acquireEventLock } from "../src/utils/lock.js";
import { lockKeysFor } from "../src/sale/lockKeys.js";
import { silentLogger } from "../src/utils/logger.js";
import { SelectorResolver } from "../src/selectors/resolver.js";
import { catalogWith, daysAgo, ev, plat, NOW } from "./helpers/platformFixtures.js";
import { offer } from "./helpers/fakeAdapter.js";

/**
 * INSTANT-ON-SALE : 14 scénarios locaux sur adaptateur SCRIPTÉ (aucun navigateur, aucun réseau). On vérifie les horodatages, le nombre
 * d'appels de chaque opération du contrat (getAvailability, getOffers, matchOffer, selectOffer, addToCart, getCartState) et de Claude.
 */
const GOOD = (id = "good"): Offer => offer({ id, category: "Cat A", pricePerTicket: 100, available: 2, seatsTogether: true });
const OVER_BUDGET = offer({ id: "over", category: "Cat A", pricePerTicket: 300, available: 4 });
const WRONG_CATEGORY = offer({ id: "wrongcat", category: "Cat Z", pricePerTicket: 50, available: 4 });
const TOO_FEW = offer({ id: "few", category: "Cat A", pricePerTicket: 40, available: 1 });
const NON_MATCHING = [OVER_BUDGET, WRONG_CATEGORY, TOO_FEW];

const stubSession = () => {
  const calls: string[] = [];
  return {
    calls,
    session: {
      context: { route: async () => void calls.push("route"), unroute: async () => void calls.push("unroute") } as never,
      page: { bringToFront: async () => undefined } as never,
      detach: async () => void calls.push("detach"),
      shutdown: async () => void calls.push("shutdown"),
    },
  };
};

interface Scenario {
  frame: (p: { poll: number; ms: number }) => SaleFrame;
  leadMs?: number;
  maxWaitS?: number;
  adapter?: Partial<Omit<ScriptedSaleOptions, "t0" | "frame">>;
  deps?: Partial<InstantSaleDeps>;
  config?: Record<string, unknown>;
  customize?: (a: ScriptedSaleAdapter) => void;
  exitWhenDone?: boolean;
}
interface Outcome {
  res: InstantSaleResult;
  adapter: ScriptedSaleAdapter;
  lines: string[];
  t0: number;
  locksDir: string;
  stub: ReturnType<typeof stubSession>;
}

async function scenario(s: Scenario): Promise<Outcome> {
  const t0 = Date.now() + (s.leadMs ?? 1500);
  const adapter = new ScriptedSaleAdapter({ t0, frame: s.frame, ...(s.adapter ?? {}) });
  s.customize?.(adapter);
  const dir = mkdtempSync(join(tmpdir(), "instant-"));
  const file = join(dir, "sale.json");
  writeFileSync(file, JSON.stringify({
    site: adapter.authorization.platform, event: { name: "Événement générique", url: adapter.meta.compliance.policy === "demo" ? "http://127.0.0.1:9/event" : "https://www.p.example/e/1" },
    sale: { startTime: new Date(t0).toISOString() }, tickets: { quantity: 2, maxPricePerTicket: 120, categories: ["Cat A", "Cat B"], seatsTogether: true },
    timing: { preArmSeconds: 0.5, pollIntervalMs: 200, maxWaitAfterSaleSeconds: s.maxWaitS ?? 8 }, notifications: { desktop: false, sound: false }, telemetry: { enabled: false },
    browser: { headless: true, userDataDir: join(dir, "profil") }, ...(s.config ?? {}),
  }));
  const stub = stubSession();
  const lines: string[] = [];
  const res = await runInstantSale({ target: file, exitWhenDone: s.exitWhenDone }, { adapters: [adapter], session: stub.session, print: (l) => void lines.push(l), locksDir: join(dir, "locks"), authCheckIntervalMs: 50, ...(s.deps ?? {}) });
  return { res, adapter, lines, t0, locksDir: join(dir, "locks"), stub };
}
const c = (o: Outcome, k: keyof ReturnType<typeof newCounts>): number => o.res.report.metrics.calls[k];
const TL = (o: Outcome) => o.res.timeline;
const openAfter = (ms: number) => (p: { ms: number }): boolean => p.ms >= ms;

// ───────────────────────────── 1-2 : vente pas commencée, vente qui commence ─────────────────────────────
test("1 · vente PAS COMMENCÉE : zéro lecture avant T0 (ni disponibilité, ni offres), aucune sélection, statut NOT_OPEN", async () => {
  const o = await scenario({ frame: () => ({ open: false }), leadMs: 1500, maxWaitS: 1 });
  assert.equal(o.res.report.status, "NOT_OPEN");
  const first = o.adapter.ops.find((x) => x.op === "getAvailability")!;
  assert.ok(first.at >= o.t0 - 5, `première lecture ${o.t0 - first.at} ms AVANT T0`);
  assert.equal(o.adapter.ops.filter((x) => x.at < o.t0 - 5 && ["getAvailability", "getOffers", "selectOffer", "addToCart", "getCartState"].includes(x.op)).length, 0, "aucune opération réseau avant l'ouverture");
  assert.equal(c(o, "getOffers"), 0, "les offres ne sont jamais lues tant que la vente est fermée");
  assert.deepEqual([c(o, "selectOffer"), c(o, "addToCart"), c(o, "getCartState")], [0, 0, 0]);
  assert.ok(c(o, "getAvailability") >= 3, "la surveillance a bien tourné après T0");
});

test("2 · la vente COMMENCE : la surveillance démarre immédiatement à T0 (préparation déjà faite), sans dépasser la cadence autorisée", async () => {
  const o = await scenario({ frame: () => ({ open: false }), maxWaitS: 1.2 });
  const lag = o.res.report.timings.sale_open_to_first_poll!;
  assert.ok(lag >= -2 && lag < 250, `1re lecture ${lag} ms après T0`);
  const reads = o.adapter.ops.filter((x) => x.op === "getAvailability").map((x) => x.at);
  for (let i = 1; i < reads.length; i++) assert.ok(reads[i]! - reads[i - 1]! >= 195, `lecture trop rapide : ${reads[i]! - reads[i - 1]!} ms`);
  // tout est préparé avant T0 : événement prêt, navigateur prêt
  const tl = TL(o);
  assert.ok(tl.T_PREPARE_START! <= tl.T_BROWSER_READY! && tl.T_BROWSER_READY! <= tl.T_EVENT_READY! && tl.T_EVENT_READY! < tl.T_SALE_START!, "préparation terminée AVANT T0");
  assert.match(o.lines.join("\n"), /\[T-[\d:.]+(ms)?\] SALE_READY[\s\S]*\[T0\] SALE_OPEN/);
});

// ───────────────────────────── 3-6 : disponibilité, offres qui correspondent ou non ─────────────────────────────
test("3 · la DISPONIBILITÉ apparaît : T_AVAILABILITY_DETECTED suit l'ouverture effective ; les offres ne sont lues qu'à ce moment", async () => {
  const o = await scenario({ frame: (p) => (openAfter(600)(p) ? { open: true, offers: [GOOD()] } : { open: false }) });
  const t = o.res.report.timings;
  assert.ok(t.sale_open_to_availability! >= 590 && t.sale_open_to_availability! < 1400, `${t.sale_open_to_availability} ms`);
  assert.ok(c(o, "getOffers") < c(o, "getAvailability"), "offres lues seulement une fois la vente ouverte");
  assert.equal(c(o, "getOffers"), 1);
  assert.equal(o.res.report.status, "CART_SUCCESS");
});

test("4 · une offre CORRESPONDANTE apparaît : décision par le cœur, une seule sélection, une seule tentative d'ajout, panier relu une fois", async () => {
  const o = await scenario({ frame: () => ({ open: true, offers: [GOOD()] }) });
  assert.equal(o.res.report.status, "CART_SUCCESS");
  assert.equal(o.res.run?.offer?.id, "good");
  assert.deepEqual([c(o, "getAvailability") >= 1, c(o, "getOffers"), c(o, "matchOffer"), c(o, "selectOffer"), c(o, "addToCart"), c(o, "getCartState")], [true, 1, 1, 1, 1, 1]);
});

test("5 · des offres NON correspondantes apparaissent d'abord (hors budget, mauvaise catégorie, quantité insuffisante) : jamais sélectionnées, jamais soumises au veto", async () => {
  const o = await scenario({ frame: (p) => ({ open: true, offers: p.poll <= 3 ? NON_MATCHING : [...NON_MATCHING, GOOD()] }) });
  assert.equal(o.res.report.status, "CART_SUCCESS");
  assert.equal(o.res.run?.offer?.id, "good");
  assert.ok(c(o, "getOffers") >= 4, "les offres non correspondantes ont été examinées à chaque lecture");
  assert.equal(c(o, "selectOffer"), 1, "aucune sélection d'une offre qui ne correspond pas");
  assert.equal(c(o, "matchOffer"), 1, "le veto n'est demandé que pour l'offre retenue par le cœur");
  assert.ok(o.res.report.metrics.offersExamined >= 4, "offres examinées");
});

test("6 · l'offre correspondante apparaît après PLUSIEURS lectures : cadence respectée, offres lues seulement quand c'est ouvert, un seul panier", async () => {
  const o = await scenario({ frame: (p) => (p.poll >= 6 ? { open: true, offers: [GOOD()] } : { open: p.poll >= 4, offers: p.poll >= 4 ? NON_MATCHING : [] }) });
  assert.equal(o.res.report.status, "CART_SUCCESS");
  assert.ok(c(o, "getAvailability") >= 6);
  assert.equal(c(o, "getOffers"), c(o, "getAvailability") - 3, "offres lues à partir de l'ouverture (lecture 4) seulement");
  assert.equal(c(o, "addToCart"), 1);
  const reads = o.adapter.ops.filter((x) => x.op === "getAvailability").map((x) => x.at);
  for (let i = 1; i < reads.length; i++) assert.ok(reads[i]! - reads[i - 1]! >= 195);
  assert.ok(o.res.report.timings.total_sale_open_to_cart! >= 6 * 195 - 400, "la durée reflète les lectures espacées : aucune accélération pour aller plus vite");
});

// ───────────────────────────── 7-9 : panier ─────────────────────────────
test("7 · addToCart réussit : CART_SUCCESS, panier VÉRIFIÉ, horodatages dans l'ordre, tableau de bord, paiement manuel, navigateur laissé ouvert", async () => {
  const o = await scenario({ frame: () => ({ open: true, offers: [GOOD()] }), adapter: { selectMs: 15, addMs: 25, cartMs: 10 } });
  const r = o.res.report;
  assert.equal(r.status, "CART_SUCCESS");
  assert.equal(o.res.code, 0);
  assert.equal(o.res.run?.cartOk, true);
  assert.equal(o.res.run?.cart?.itemCount, 2);
  const tl = TL(o);
  const seq = ["T_PREPARE_START", "T_BROWSER_READY", "T_EVENT_READY", "T_SALE_START", "T_FIRST_POLL", "T_AVAILABILITY_DETECTED", "T_OFFER_SELECTED", "T_CART_REQUEST", "T_CART_SUCCESS"] as const;
  for (let i = 1; i < seq.length; i++) assert.ok(tl[seq[i - 1]!]! <= tl[seq[i]!]!, `${seq[i - 1]} ≤ ${seq[i]}`);
  const t = r.timings;
  for (const k of ["sale_open_to_availability", "availability_to_selection", "selection_to_cart_request", "cart_request_to_cart_success", "total_sale_open_to_cart"] as const) assert.ok(typeof t[k] === "number" && t[k]! >= 0, k);
  assert.ok(t.availability_to_selection! >= 14, "la sélection (15 ms simulées) est mesurée");
  assert.ok(t.cart_request_to_cart_success! >= 34, "ajout (25 ms) + relecture (10 ms) mesurés");
  assert.ok(t.selection_to_cart_request! < 15, "le cœur ne perd pas de temps entre sélection et ajout");
  const sum = t.sale_open_to_availability! + t.availability_to_selection! + t.selection_to_cart_request! + t.cart_request_to_cart_success!;
  assert.ok(Math.abs(sum - t.total_sale_open_to_cart!) < 2, "les étapes se somment au total");
  assert.match(o.res.dashboard, /STATUS: CART_SUCCESS[\s\S]*TIMING:[\s\S]*PERFORMANCE:[\s\S]*SECURITY:[\s\S]*payment\s+MANUAL[\s\S]*CART_SUCCESS\nPAYMENT_REQUIRED\nPAYMENT_MANUAL\nPayment remains manual\./);
  assert.deepEqual(o.stub.calls.filter((x) => x !== "route" && x !== "unroute"), ["detach"], "le navigateur reste OUVERT (détaché, pas fermé)");
  assert.ok(o.stub.calls.includes("unroute"), "le garde de paiement est levé à la fin (paiement manuel)");
  assert.deepEqual(readdirSync(o.locksDir).filter((f) => f.endsWith(".lock")), [], "verrous libérés");
});

test("8 · panier INCOHÉRENT (quantité différente) : jamais CART_SUCCESS, aucune relance, le cœur refuse de le déclarer réussi", async () => {
  const o = await scenario({ frame: () => ({ open: true, offers: [GOOD()] }), adapter: { cartQuantity: (q) => q - 1 } });
  assert.equal(o.res.report.status, "CART_MISMATCH");
  assert.equal(o.res.code, 1);
  assert.equal(c(o, "addToCart"), 1, "pas d'empilement d'ajouts");
  assert.equal(o.res.report.timings.total_sale_open_to_cart, null, "aucune durée « vers le panier » pour un panier invalide");
  assert.ok(!/Payment remains manual/.test(o.res.dashboard) && !/\nCART_SUCCESS\n/.test(o.res.dashboard));
  assert.ok(!o.lines.some((l) => /\] CART_SUCCESS/.test(l)));
});

test("9 · vente COMPLÈTE : SOLD_OUT, les offres ne sont pas lues, aucune sélection, cadence de surveillance ralentie (pas d'insistance)", async () => {
  const o = await scenario({ frame: () => ({ open: true, soldOut: true, offers: [] }), maxWaitS: 2.2 });
  assert.equal(o.res.report.status, "SOLD_OUT");
  assert.deepEqual([c(o, "getOffers"), c(o, "selectOffer"), c(o, "addToCart")], [0, 0, 0]);
  assert.ok(c(o, "getAvailability") <= 4, `${c(o, "getAvailability")} lectures en ~2 s : surveillance ralentie quand c'est complet`);
});

// ───────────────────────────── 10-12 : file, CAPTCHA, limite d'achat ─────────────────────────────
for (const [name, state] of [["10 · FILE d'attente", "QUEUE"], ["11 · CAPTCHA", "CAPTCHA"]] as const) {
  test(`${name} : cession de la main, AUCUNE action d'achat pendant le blocage, reprise seulement quand l'humain a fini — aucun contournement`, async () => {
    let cleared = false;
    const blocked = (): Blocker => ({ state, message: `${state} affiché` });
    let adapterRef: ScriptedSaleAdapter;
    const o = await scenario({
      frame: (p) => ({ open: true, offers: [GOOD()], blocker: !cleared ? blocked() : null }),
      customize: (a) => void (adapterRef = a),
      deps: {
        awaitHuman: async (b) => {
          assert.equal(b.state, state);
          assert.equal(adapterRef.count("selectOffer") + adapterRef.count("addToCart"), 0, "aucune action pendant le blocage");
          await new Promise((r) => setTimeout(r, 400));
          cleared = true;
        },
      },
    });
    assert.equal(o.res.report.status, "CART_SUCCESS");
    assert.deepEqual(o.res.report.blockersSeen, [state]);
    assert.equal(o.res.report.metrics.handoffs, 1);
    assert.equal(c(o, "selectOffer"), 1);
    assert.match(o.res.dashboard, new RegExp(`BLOCKERS: ${state} \\(cession de la main, aucun contournement\\)`));
  });
}

test("11b · l'humain n'est pas disponible (la cession échoue) : aucune sélection ni ajout, jamais d'auto-résolution — le run s'arrête en erreur", async () => {
  const { HumanRequiredError } = await import("../src/utils/errors.js");
  const o = await scenario({
    frame: () => ({ open: true, offers: [GOOD()], blocker: { state: "CAPTCHA", message: "captcha" } }),
    deps: { awaitHuman: async () => (await new Promise((r) => setTimeout(r, 300)), Promise.reject(new HumanRequiredError("aucun humain"))) },
  });
  assert.notEqual(o.res.report.status, "CART_SUCCESS");
  assert.deepEqual([c(o, "selectOffer"), c(o, "addToCart"), c(o, "getCartState")], [0, 0, 0], "le CAPTCHA n'est jamais contourné ni ignoré");
  assert.deepEqual(o.res.report.blockersSeen, ["CAPTCHA"]);
});

test("12 · LIMITE D'ACHAT : arrêt définitif (PURCHASE_LIMIT), une seule tentative, aucune insistance ni autre offre", async () => {
  const o = await scenario({ frame: () => ({ open: true, offers: [GOOD("a"), GOOD("b")] }), adapter: { onAdd: () => "limit" } });
  assert.equal(o.res.report.status, "PURCHASE_LIMIT");
  assert.equal(o.res.code, 1);
  assert.deepEqual([c(o, "selectOffer"), c(o, "addToCart")], [1, 1]);
});

// ───────────────────────────── 13-14 : autorisation et verrou ─────────────────────────────
const nonDemo = (a: ScriptedSaleAdapter): void => {
  a.meta = { ...a.meta, id: "scripted-web", platform: "p", channel: "browser", testOnly: undefined, compliance: { policy: "permitted-by-terms", termsUrl: "https://www.p.example/cgu", reviewedAt: new Date().toISOString().slice(0, 10) } };
};
const okCatalog = (): Catalog => catalogWith([plat("p")], [ev("p", "browser", daysAgo(3, NOW), { source: { url: "https://www.p.example/cgu", title: "CGU (FICTIVES)" } })]);

test("13 · l'AUTORISATION expire pendant la surveillance : AUTHORIZATION_EXPIRED, plus aucun appel à la plateforme", async () => {
  const catalog = okCatalog();
  let at = -1;
  const o = await scenario({
    frame: (p) => {
      if (p.poll === 3) {
        catalog.evidence.length = 0;
        catalog.evidence.push(ev("p", "browser", daysAgo(181, Date.now()), { source: { url: "https://www.p.example/cgu", title: "t" } }));
        at = p.poll;
      }
      return { open: false };
    },
    customize: nonDemo,
    deps: { catalog },
    maxWaitS: 6,
  });
  assert.equal(o.res.report.status, "AUTHORIZATION_EXPIRED");
  assert.equal(c(o, "getAvailability"), at, "aucune lecture après l'expiration");
  assert.deepEqual([c(o, "getOffers"), c(o, "selectOffer"), c(o, "addToCart")], [0, 0, 0]);
  assert.deepEqual(readdirSync(o.locksDir).filter((f) => f.endsWith(".lock")), [], "verrous libérés");
});

test("14 · CONTENTION de verrou : un autre contrôleur tient l'événement/profil → refus AVANT toute ouverture de navigateur ou requête", async () => {
  const t0 = Date.now() + 1500;
  const a = new ScriptedSaleAdapter({ t0, frame: () => ({ open: true, offers: [GOOD()] }) });
  const dir = mkdtempSync(join(tmpdir(), "instant-lock-"));
  const file = join(dir, "sale.json");
  const cfg = { site: "scripted", event: { name: "E", url: "http://127.0.0.1:9/event" }, sale: { startTime: new Date(t0).toISOString() }, tickets: { quantity: 2, maxPricePerTicket: 120 }, timing: { preArmSeconds: 0.5 }, telemetry: { enabled: false }, browser: { headless: true, userDataDir: join(dir, "profil") } };
  writeFileSync(file, JSON.stringify(cfg));
  const keys = lockKeysFor(a, ConfigSchema.parse(cfg), "browser", "sale");
  const locksDir = join(dir, "locks");
  const other = acquireEventLock(keys[0]!.key, "autre-controleur#1", locksDir);
  const stub = stubSession();
  try {
    await assert.rejects(runInstantSale({ target: file }, { adapters: [a], session: stub.session, locksDir, print: () => undefined }), /même événement ou le même profil/);
    assert.deepEqual(stub.calls, [], "navigateur/garde jamais touchés");
    assert.deepEqual(a.ops, [], "adaptateur jamais appelé");
  } finally {
    other.release();
  }
});

// ───────────────────────────── refus, Claude, journaux ─────────────────────────────
test("refus : NOT_VERIFIED / EXPIRED / NOT_ALLOWED / HUMAN_ONLY / plateforme absente → INSTANT-ON-SALE refuse de démarrer (aucun navigateur, aucune requête)", async () => {
  const cases: [string, Catalog][] = [
    ["NOT_VERIFIED", catalogWith([plat("p")])],
    ["EXPIRED", catalogWith([plat("p")], [ev("p", "both", daysAgo(181, Date.now()))])],
    ["NOT_ALLOWED", catalogWith([plat("p")], [ev("p", "prohibited", daysAgo(3, Date.now()))])],
    ["HUMAN_ONLY", catalogWith([plat("p")], [ev("p", "human", daysAgo(3, Date.now()))])],
    ["absente", catalogWith([])],
  ];
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => (fetched++, new Response("x"))) as typeof fetch;
  try {
    for (const [label, catalog] of cases) {
      const o = await scenario({ frame: () => ({ open: true, offers: [GOOD()] }), customize: nonDemo, deps: { catalog } });
      assert.equal(o.res.report.status, "REFUSED", label);
      assert.equal(o.res.code, 1, label);
      assert.match(o.res.report.reason ?? "", /INSTANT-ON-SALE refuse de démarrer/, label);
      assert.deepEqual(o.adapter.ops, [], label);
      assert.deepEqual(o.stub.calls, [], label);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(fetched, 0);
});

test("Claude : ZÉRO appel dans le chemin nominal ; diagnostic jamais utilisé ; l'ambiguïté explicite (sélecteur introuvable) n'appelle Claude que si la configuration l'autorise", async () => {
  const nominal = await scenario({ frame: () => ({ open: true, offers: [GOOD()] }) });
  assert.equal(nominal.res.report.metrics.claudeCallsInCriticalPath, 0);
  assert.equal(nominal.res.report.metrics.claudeCallsTotal, 0);
  // ambiguïté signalée par l'adaptateur, Claude désactivé (défaut) : aucun appel ; le diagnostic est refusé (jamais nécessaire)
  const off = await scenario({ frame: () => ({ open: true, offers: [GOOD()] }), adapter: { selectError: () => new SelectorNotFoundError({ name: "x", description: "Bouton", candidates: ["#x"] }) } });
  assert.equal(off.res.report.metrics.claudeCallsInCriticalPath, 0);
  assert.equal(off.res.report.metrics.claudeDenied, 1);
  assert.notEqual(off.res.report.status, "CART_SUCCESS");
  // autorisé explicitement par la configuration : l'appel est compté (chemin critique) — et borné
  const ctl = { critical: false };
  const prompts: string[] = [];
  const cfg = ConfigSchema.parse({ site: "x", event: { name: "e" }, sale: { startTime: "2030-01-01T00:00:00Z" }, tickets: { quantity: 1, maxPricePerTicket: 1 }, claude: { enabled: true, maxCallsPerRun: 2 } }).claude;
  const client = { messages: { create: async (b: { messages: { content: string }[] }) => (prompts.push(JSON.stringify(b.messages)), { content: [{ type: "text" as const, text: '{"index":null}' }] }) } };
  const claude = new InstantClaude(cfg, silentLogger, () => ctl.critical, client);
  const page = { evaluate: async () => ({ url: "https://s.example/p", title: "t", els: [{ i: 0, tag: "button", type: "", text: "Ajouter", aria: "", testid: "add", id: "", href: "", stable: '[data-testid="add"]' }] }), locator: () => ({ count: async () => 1 }) } as never;
  const spec = { name: "addToCart", description: "Bouton d'ajout", candidates: ["#x"] };
  const resolver = { remember: () => undefined } as unknown as SelectorResolver;
  await claude.healSelector(page, spec, resolver); // avant T0 : compté au total seulement
  ctl.critical = true;
  await claude.healSelector(page, spec, resolver); // chemin critique
  assert.deepEqual([claude.total, claude.criticalPath], [2, 1]);
  assert.equal(await claude.diagnose(page), null, "diagnostic refusé");
  assert.equal(claude.denied, 1);
  await claude.healSelector(page, spec, resolver); // quota de la configuration atteint : plus d'appel
  assert.equal(claude.total, 2);
  assert.ok(prompts.every((p) => !/cookie|token|secret/i.test(p)));
});

// ───────────────────────────── surveillance : cadence, Retry-After, flux officiel ─────────────────────────────
test("Retry-After : une limite de débit (429) est respectée — aucune lecture avant l'échéance, cadence jamais accélérée, une relance comptée", async () => {
  const o = await scenario({ frame: (p) => (p.poll >= 6 ? { open: true, offers: [GOOD()] } : { open: false }), adapter: { rateLimit: { poll: 2, retryAfterMs: 900 } }, maxWaitS: 10 });
  assert.equal(o.res.report.status, "CART_SUCCESS");
  assert.equal(o.res.report.metrics.rateLimited, 1);
  assert.equal(o.res.report.metrics.retries, 1);
  const reads = o.adapter.ops.filter((x) => x.op === "getAvailability").map((x) => x.at);
  const limited = reads[1]!; // la lecture n° 2 a reçu le 429
  assert.ok(reads[2]! - limited >= 880, `lecture suivante ${reads[2]! - limited} ms après le 429 (Retry-After 900 ms)`);
  for (let i = 1; i < reads.length; i++) assert.ok(reads[i]! - reads[i - 1]! >= 195);
});

test("SaleMonitor : cadence minimale (plancher 200 ms), Retry-After mémorisé sans lecture, arrêt, métriques — et aucune lecture des offres tant que c'est fermé", async () => {
  const t0 = Date.now();
  const a = new ScriptedSaleAdapter({ t0, frame: () => ({ open: false }), rateLimit: { poll: 3, retryAfterMs: 500 } });
  const counts = newCounts();
  const timeline = new Timeline();
  const cfg = ConfigSchema.parse({ site: "scripted", event: { name: "e", url: "http://127.0.0.1:9/e" }, sale: { startTime: new Date(t0).toISOString() }, tickets: { quantity: 2, maxPricePerTicket: 120 } });
  const ctx = { config: cfg, context: {} as never, page: {} as never, log: silentLogger, env: {}, selectors: new SelectorResolver("x", "/nonexistent/x.json") } as AdapterContext;
  let monitor!: SaleMonitor;
  const inst = instrument(a, { timeline, counts }, () => monitor);
  monitor = new SaleMonitor({ adapter: inst, raw: a, ctx, criteria: compileSelection(cfg), timeline, counts, minIntervalMs: 50 /* sous le plancher */, saleStartMs: t0 });
  const stamps: number[] = [];
  for (let i = 0; i < 2; i++) (await monitor.poll(), stamps.push(Date.now()));
  assert.ok(stamps[1]! - stamps[0]! >= 195, "plancher de 200 ms malgré minIntervalMs=50");
  await assert.rejects(monitor.poll(), RateLimitedError); // 3e lecture : 429
  const reads = counts.getAvailability;
  await assert.rejects(monitor.poll(), (e: Error) => e instanceof RateLimitedError && e.retryAfterMs > 0 && e.retryAfterMs <= 500);
  assert.equal(counts.getAvailability, reads, "aucune lecture avant l'échéance du Retry-After");
  assert.equal(counts.getOffers, 0);
  const m = monitor.getMetrics();
  assert.deepEqual([m.polls, m.rateLimited, m.errors], [3, 1, 0]);
  monitor.stop();
  assert.deepEqual(await monitor.poll(), { snapshot: { open: false, offers: [] }, blocker: null }, "arrêté : plus aucune lecture");
  assert.equal(counts.getAvailability, reads);
});

test("flux OFFICIEL de disponibilité : utilisé en priorité quand l'adaptateur l'expose (aucune lecture tant qu'il n'a pas signalé l'ouverture) ; sans lui, la lecture normale", async () => {
  const t0 = Date.now() + 100;
  class FeedAdapter extends ScriptedSaleAdapter {
    signal?: () => void;
    unsubscribed = false;
    async subscribeAvailability(_c: AdapterContext, onOpen: () => void): Promise<() => void> {
      this.signal = onOpen;
      return () => void (this.unsubscribed = true);
    }
  }
  const a = new FeedAdapter({ t0, frame: (p) => (p.ms >= 0 ? { open: true, offers: [GOOD()] } : { open: false }) });
  const counts = newCounts();
  const timeline = new Timeline();
  const cfg = ConfigSchema.parse({ site: "scripted", event: { name: "e", url: "http://127.0.0.1:9/e" }, sale: { startTime: new Date(t0).toISOString() }, tickets: { quantity: 2, maxPricePerTicket: 120, categories: ["Cat A"] } });
  const ctx = { config: cfg, context: {} as never, page: {} as never, log: silentLogger, env: {}, selectors: new SelectorResolver("x", "/nonexistent/x.json") } as AdapterContext;
  let monitor!: SaleMonitor;
  monitor = new SaleMonitor({ adapter: instrument(a, { timeline, counts }, () => monitor), raw: a, ctx, criteria: compileSelection(cfg), timeline, counts, minIntervalMs: 200, saleStartMs: t0, feedGraceMs: 5000 });
  await monitor.start();
  await new Promise((r) => setTimeout(r, 150));
  const closed = await monitor.poll();
  assert.equal(closed.snapshot.open, false);
  assert.equal(counts.getAvailability, 0, "le flux n'a rien signalé : AUCUNE lecture");
  assert.equal(monitor.getMetrics().skippedByFeed, 1);
  a.signal!(); // le flux officiel annonce l'ouverture
  const open = await monitor.poll();
  assert.equal(open.snapshot.open, true);
  assert.equal(open.snapshot.offers.length, 1);
  assert.equal(counts.getAvailability, 1);
  assert.equal(monitor.getMetrics().feed, "signalled");
  monitor.stop();
  assert.equal(a.unsubscribed, true);
  // le flux n'est qu'un signal : un signal MANQUÉ ne fait pas manquer la vente (la lecture normale reprend après le délai de grâce)
  const b = new FeedAdapter({ t0, frame: () => ({ open: true, offers: [GOOD()] }) });
  const c2 = newCounts();
  let m2!: SaleMonitor;
  m2 = new SaleMonitor({ adapter: instrument(b, { timeline: new Timeline(), counts: c2 }, () => m2), raw: b, ctx, criteria: compileSelection(cfg), timeline: new Timeline(), counts: c2, minIntervalMs: 200, saleStartMs: Date.now() - 100, feedGraceMs: 50 });
  await m2.start();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal((await m2.poll()).snapshot.open, true, "signal manqué : lecture normale après la grâce");
});

// ───────────────────────────── critères compilés = décision du cœur ─────────────────────────────
test("critères COMPILÉS : immuables, et `rank` ≡ `rankOffers` du cœur (800 tirages aléatoires, toutes stratégies, sections, rangées, strict)", () => {
  const cats = ["Cat 1", "Cat 2", "Cat 3", "Fosse", "Balcon"];
  const secs = ["A", "B", "Z", "Nord", "Sud"];
  const strategies = [
    { priority: ["seatsTogether", "category", "placement", "price"], priceOrder: "cheapest" },
    { priority: ["price", "seatsTogether", "category", "placement"], priceOrder: "cheapest" },
    { priority: ["seatsTogether", "placement", "category", "price"], priceOrder: "most-expensive" },
    { priority: ["seatsTogether", "fit", "category", "price"], priceOrder: "cheapest" },
  ];
  let seed = 7;
  const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
  for (let i = 0; i < 800; i++) {
    const cfg = ConfigSchema.parse({
      site: "x", event: { name: "e" }, sale: { startTime: "2030-01-01T00:00:00Z" },
      tickets: { quantity: 1 + Math.floor(rnd() * 4), maxPricePerTicket: 60 + Math.floor(rnd() * 100), categories: rnd() < 0.3 ? [] : cats.filter(() => rnd() < 0.6), seatsTogether: rnd() < 0.8, seatsTogetherStrict: rnd() < 0.3 },
      strategy: { ...pick(strategies), priorityCategories: rnd() < 0.3 ? [pick(cats)] : [], placement: { preferSections: rnd() < 0.5 ? [pick(secs)] : [], avoidSections: rnd() < 0.3 ? [pick(secs)] : [], excludeSections: rnd() < 0.2 ? [pick(secs)] : [], rowPreference: pick(["front", "back", "any"]), preferRows: rnd() < 0.4 ? ["1-5", "A"] : [], avoidRows: rnd() < 0.3 ? ["20"] : [] } },
    });
    const offers: Offer[] = Array.from({ length: 12 }, (_, k) => offer({ id: `o${k}`, category: pick(cats), pricePerTicket: 40 + Math.floor(rnd() * 140) + (rnd() < 0.2 ? 0.5 : 0), available: Math.floor(rnd() * 7), seatsTogether: pick([true, false, "unknown"] as const), section: pick(secs), row: pick(["1", "4", "12", "20", "A", "B"]) }));
    const compiled = compileSelection(cfg);
    assert.deepEqual(compiled.rank(offers).map((x) => x.id), rankOffers(offers, cfg.tickets, cfg.strategy).map((x) => x.id), `tirage ${i}`);
    assert.deepEqual(rankOffers(compiled.candidates(offers), cfg.tickets, cfg.strategy).map((x) => x.id), rankOffers(offers, cfg.tickets, cfg.strategy).map((x) => x.id));
  }
  const c1 = compileSelection(ConfigSchema.parse({ site: "x", event: { name: "e" }, sale: { startTime: "2030-01-01T00:00:00Z" }, tickets: { quantity: 2, maxPricePerTicket: 100, categories: ["A"] } }));
  assert.ok(Object.isFrozen(c1) && Object.isFrozen(c1.tickets) && Object.isFrozen(c1.strategy) && Object.isFrozen(c1.strategy.placement.preferSections) && Object.isFrozen(c1.categories));
  assert.throws(() => {
    (c1.tickets as { quantity: number }).quantity = 9;
  }, TypeError);
  assert.equal(c1.maxPriceCents, 10000);
});

// ───────────────────────────── journaux minimaux et rapport de latence ─────────────────────────────
test("journaux MINIMAUX pendant la vente (SALE_READY, SALE_OPEN, AVAILABILITY, CART_REQUEST, CART_SUCCESS) — aucun secret, cookie, jeton, URL à identifiants", async () => {
  const o = await scenario({ frame: (p) => (openAfter(300)(p) ? { open: true, offers: [GOOD()] } : { open: false }) });
  const marks = o.lines.filter((l) => /^\[T/.test(l)).map((l) => l.replace(/^\[[^\]]+\] /, ""));
  assert.deepEqual(marks, ["SALE_READY", "SALE_OPEN", "AVAILABILITY", "CART_REQUEST", "CART_SUCCESS"]);
  const all = o.lines.join("\n");
  assert.ok(!/bearer |cookie:|set-cookie|token=|access_token|secret=|\bcvv\b|\biban\b|https?:\/\/[^\s/]*:[^\s/]*@/i.test(all), all);
  assert.match(all, /^STATUS: CART_SUCCESS/m);
});

test("RAPPORT INSTANT SALE PERFORMANCE (fixture scriptée) — mesures par étape, Claude = 0, relances ; jamais une vitesse d'achat réelle", async () => {
  const o = await scenario({ frame: (p) => (openAfter(500)(p) ? { open: true, offers: [...NON_MATCHING, GOOD()] } : { open: false }), adapter: { selectMs: 12, addMs: 20, cartMs: 8 } });
  const report = formatPerformance(o.res.report);
  console.log(`\n${report}\n`);
  assert.match(report, /^INSTANT SALE PERFORMANCE\nBrowser ready:\n\d+(\.\d+)? ms\nEvent ready:\n\d+(\.\d+)? ms\nSale open → availability:\n\d+(\.\d+)? ms\nAvailability → selection:\n\d+(\.\d+)? ms\nSelection → cart request:\n\d+(\.\d+)? ms\nCart request → cart success:\n\d+(\.\d+)? ms\nSale open → cart:\n\d+(\.\d+)? ms\nClaude calls in critical path:\n0\nNetwork retries:\n0\n/);
  const r = o.res.report;
  assert.equal(r.metrics.claudeCallsInCriticalPath, 0);
  assert.equal(r.metrics.retries, 0);
  assert.ok(r.security.payment === "MANUAL" && r.security.channel === "browser");
  assert.match(report, /ne disent rien de la vitesse d'un achat réel/);
});

// ───────────────────────────── passage de main CART_SUCCESS → utilisateur (paiement 100 % manuel) ─────────────────────────────
/** Page espion : enregistre TOUT accès autre que bringToFront (navigation, champs, clic, évaluation, nouvel onglet, fermeture…). */
const spyPage = () => {
  const touched: string[] = [];
  let front = 0;
  const page = new Proxy({}, {
    get: (_t, k: string) => {
      if (k === "bringToFront") return async () => void front++;
      if (k === "then") return undefined;
      touched.push(k);
      return async () => undefined;
    },
  });
  return { page, touched, front: () => front };
};

test("H1 · CART_SUCCESS → passage de main : bannière CART_SUCCESS/PAYMENT_REQUIRED/PAYMENT_MANUAL, durées mesurées, AUCUNE autre interaction avec la page", async () => {
  const spy = spyPage();
  const stub = stubSession();
  const o = await scenario({
    frame: () => ({ open: true, offers: [GOOD()] }),
    adapter: { selectMs: 5, addMs: 10, cartMs: 5 },
    deps: { session: { ...stub.session, page: spy.page as never } },
  });
  assert.equal(o.res.report.status, "CART_SUCCESS");
  const text = o.lines.join("\n");
  assert.match(text, /CART_SUCCESS\nPAYMENT_REQUIRED\nPAYMENT_MANUAL/);
  const idx = (re: RegExp): number => o.lines.findIndex((l) => re.test(l));
  assert.ok(idx(/^PAYMENT_MANUAL$/) < idx(/^STATUS:/), "la bannière précède le tableau de bord détaillé");
  const t = o.res.report.timings;
  assert.ok(typeof t.cart_success_to_ui_ready === "number" && t.cart_success_to_ui_ready >= 0 && t.cart_success_to_ui_ready < 100, `CART_SUCCESS → UI prête : ${t.cart_success_to_ui_ready} ms`);
  assert.ok(typeof t.ui_ready_to_user_control === "number" && t.ui_ready_to_user_control >= 0 && t.ui_ready_to_user_control < 100, `UI prête → contrôle : ${t.ui_ready_to_user_control} ms`);
  assert.match(o.res.dashboard, /cart_success_to_ui_ready\s+[\d.]+ ms[\s\S]*ui_ready_to_user_control\s+[\d.]+ ms/);
  const tl = TL(o);
  assert.ok(tl.T_CART_SUCCESS! <= tl.T_UI_READY! && tl.T_UI_READY! <= tl.T_USER_CONTROL!);
  // la page déjà ouverte est simplement ramenée au premier plan : pas de navigation, pas d'onglet, pas de champ lu, pas de clic, pas de fermeture
  assert.ok(spy.front() >= 1, "page au premier plan");
  assert.deepEqual(spy.touched.filter((k) => !["url", "isClosed"].includes(k)), [], `interactions inattendues avec la page : ${spy.touched.join(",")}`);
  assert.equal(o.res.report.metrics.claudeCallsTotal, 0, "aucun appel à Claude");
  // aucune opération réseau après la relecture du panier (surveillance arrêtée, aucune navigation, aucun paiement)
  const lastCart = Math.max(...o.adapter.ops.filter((x) => x.op === "getCartState").map((x) => x.at));
  assert.ok(o.adapter.ops.every((x) => x.at <= lastCart + 1), "aucune opération d'adaptateur après la dernière vérification du panier");
  assert.ok(!o.stub.calls.includes("shutdown"));
});

test("H2 · même avec exitWhenDone, le navigateur n'est JAMAIS fermé après CART_SUCCESS (détaché, ouvert) ; il l'est en cas d'échec", async () => {
  const won = await scenario({ frame: () => ({ open: true, offers: [GOOD()] }), exitWhenDone: true });
  assert.equal(won.res.report.status, "CART_SUCCESS");
  assert.ok(won.stub.calls.includes("detach") && !won.stub.calls.includes("shutdown"), "aucune fermeture à CART_SUCCESS");
  const lost = await scenario({ frame: () => ({ open: true, soldOut: true }), maxWaitS: 1, exitWhenDone: true });
  assert.notEqual(lost.res.report.status, "CART_SUCCESS");
  assert.ok(lost.stub.calls.includes("shutdown"), "comportement inchangé hors succès");
});

test("H3 · pas de passage de main hors succès : SOLD_OUT / panier incohérent n'affichent ni PAYMENT_REQUIRED ni UI prête", async () => {
  const bad = await scenario({ frame: () => ({ open: true, offers: [GOOD()] }), adapter: { cartQuantity: (q) => q - 1 } });
  assert.notEqual(bad.res.report.status, "CART_SUCCESS");
  assert.ok(!bad.lines.some((l) => /^PAYMENT_(REQUIRED|MANUAL)$/.test(l)));
  assert.equal(bad.res.timeline.T_UI_READY, undefined);
  assert.equal(bad.res.report.timings.cart_success_to_ui_ready, null);
  const sold = await scenario({ frame: () => ({ open: true, soldOut: true }), maxWaitS: 1 });
  assert.ok(!sold.lines.some((l) => /^PAYMENT_(REQUIRED|MANUAL)$/.test(l)));
});
