import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { formatPerformance } from "../src/instant/report.js";
import { runInstantSale } from "../src/instant/runner.js";
import { startFixtureSite, type FixtureSite } from "../testkit/fixtureSite.js";
import type { FixtureScenario, FixtureSiteOptions } from "../testkit/scenarios.js";

/**
 * INSTANT-ON-SALE avec un VRAI Chromium local et le faux site de fixtures (TEST_ONLY · NOT_A_REAL_PLATFORM, 127.0.0.1) :
 * le navigateur, la session et la page de l'événement sont prêts AVANT T0 ; aucune plateforme réelle n'est contactée.
 */
let skipReason: string | undefined;
const tmp = mkdtempSync(join(tmpdir(), "instant-browser-"));
const prevEnv = { e: process.env.EXAMPLE_EMAIL, p: process.env.EXAMPLE_PASSWORD };
before(async () => {
  process.env.EXAMPLE_EMAIL = "demo@example.com";
  process.env.EXAMPLE_PASSWORD = "demo";
  try {
    const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] });
    await b.close();
  } catch (e) {
    skipReason = `Chromium indisponible (${(e as Error).message.split("\n")[0]}) — définissez CHROMIUM_PATH`;
  }
});
after(() => {
  process.env.EXAMPLE_EMAIL = prevEnv.e;
  process.env.EXAMPLE_PASSWORD = prevEnv.p;
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* le navigateur de test peut encore écrire son profil : dossier temporaire, sans importance */
  }
});
const t = (name: string, fn: () => Promise<void>): void => void test(name, async (ctx) => (skipReason ? ctx.skip(skipReason) : fn()));

let out_site: FixtureSite | undefined;
async function run(site: FixtureSiteOptions & { scenario: FixtureScenario }, leadMs: number, extra: Record<string, unknown> = {}, awaitHuman?: Parameters<typeof runInstantSale>[1] extends infer D ? (D extends { awaitHuman?: infer A } ? A : never) : never) {
  const openAt = Date.now() + leadMs;
  const fx: FixtureSite = await startFixtureSite({ ...site, openAt });
  out_site = fx;
  const name = `ib-${Math.random().toString(36).slice(2, 8)}`;
  const file = join(tmp, `${name}.json`);
  writeFileSync(file, JSON.stringify({
    site: "example", event: { name: "Fixture locale", url: `${fx.url}/event` }, sale: { startTime: new Date(openAt).toISOString() },
    tickets: { quantity: 2, maxPricePerTicket: 150, categories: ["Catégorie 1", "Catégorie 2", "Catégorie 3"], seatsTogether: true },
    timing: { preArmSeconds: 3, pollIntervalMs: 200, maxWaitAfterSaleSeconds: 10 }, notifications: { desktop: false, sound: false }, telemetry: { dir: join(tmp, "runs") },
    browser: { headless: true, userDataDir: join(tmp, name), executablePath: process.env.CHROMIUM_PATH }, ...extra,
  }));
  const lines: string[] = [];
  try {
    const res = await runInstantSale({ target: file, exitWhenDone: true }, { print: (l) => void lines.push(l), locksDir: join(tmp, `locks-${name}`), observedRequests: () => fx.state.requests.length, awaitHuman });
    return { res, fx, lines, openAt };
  } finally {
    await fx.close();
    rmSync(join(".profile", name), { recursive: true, force: true });
  }
}

t("Chromium réel + fixture : navigateur et page prêts AVANT T0, CART_SUCCESS vérifié côté serveur, paiement jamais demandé, Claude 0 — rapport de latence", async () => {
  const { res, fx, lines, openAt } = await run({ scenario: "contention" }, 9000);
  const r = res.report;
  assert.equal(r.status, "CART_SUCCESS", lines.join("\n"));
  assert.equal(res.code, 0);
  // tout est prêt avant T0
  const tl = res.timeline;
  assert.ok(tl.T_BROWSER_READY! < openAt && tl.T_EVENT_READY! < openAt, "navigateur et page de l'événement prêts avant l'ouverture");
  assert.ok(r.prepare.prepareToBrowserMs! > 0 && r.prepare.eventPrepareMs! > 0);
  // chemin critique : chaque étape mesurée, dans l'ordre
  for (const k of ["sale_open_to_availability", "availability_to_selection", "selection_to_cart_request", "cart_request_to_cart_success", "total_sale_open_to_cart"] as const) assert.ok(typeof r.timings[k] === "number" && r.timings[k]! >= 0, k);
  assert.ok(r.timings.total_sale_open_to_cart! < 4000, `${r.timings.total_sale_open_to_cart} ms de l'ouverture au panier sur la fixture locale`);
  // le panier a été VÉRIFIÉ : relu par l'adaptateur et validé par le cœur ; le serveur confirme
  assert.equal(res.run?.cartOk, true);
  assert.equal(fx.state.cart.length, 1);
  assert.equal(fx.state.cart[0]!.offerId, "o6", "repli déterministe après contention : meilleure offre suivante côte à côte, dans le budget");
  assert.equal(fx.state.paymentHits, 0, "AUCUNE requête vers la page de paiement");
  assert.equal(fx.state.addAttempts, 2, "arrêt immédiat après le panier");
  assert.equal(r.metrics.claudeCallsInCriticalPath, 0);
  assert.equal(r.metrics.observedRequests, fx.state.requests.length);
  assert.ok(!fx.state.requests.some((x) => /\/payment/.test(x)));
  console.log(`\n${formatPerformance(r)}\n`);
  console.log(lines.filter((l) => /^\[T/.test(l)).join("\n"));
});

t("Chromium réel : file d'attente au moment de l'ouverture → cession de la main (aucune action d'achat pendant la file), reprise, panier", async () => {
  // La file dure plus longtemps que le délai d'une action du navigateur (4 s) : l'adaptateur échoue sur la page d'attente, le cœur lit l'état
  // de la page (QUEUE) et cède la main. L'humain patiente (ici 7 s) ; le bot ne touche plus à la page.
  let cartDuringQueue = -1;
  const out = await run({ scenario: "queue", queueMs: 6000 }, 7000, {}, async (b) => {
    assert.equal(b.state, "QUEUE");
    cartDuringQueue = out_site?.state.addAttempts ?? 0;
    await new Promise((r) => setTimeout(r, 2500));
  });
  assert.equal(out.res.report.status, "CART_SUCCESS", out.lines.join("\n"));
  assert.deepEqual(out.res.report.blockersSeen, ["QUEUE"]);
  assert.equal(cartDuringQueue, 0, "aucune tentative d'ajout pendant la file");
  assert.equal(out.fx.state.paymentHits, 0);
});

t("Chromium réel : CAPTCHA, vente complète, limite d'achat — jamais contournés, jamais de paiement, statuts explicites", async () => {
  const captcha = await run({ scenario: "captcha", captchaMs: 2000 }, 7000, {}, async () => void (await new Promise((r) => setTimeout(r, 2300))));
  assert.equal(captcha.res.report.status, "CART_SUCCESS", captcha.lines.join("\n"));
  assert.deepEqual(captcha.res.report.blockersSeen, ["CAPTCHA"]);
  assert.equal(captcha.fx.state.paymentHits, 0);
  const sold = await run({ scenario: "sold-out" }, 5000, { timing: { preArmSeconds: 2, pollIntervalMs: 200, maxWaitAfterSaleSeconds: 2 } });
  assert.equal(sold.res.report.status, "SOLD_OUT");
  assert.equal(sold.fx.state.cart.length, 0);
  assert.equal(sold.fx.state.paymentHits, 0);
  const limit = await run({ scenario: "purchase-limit" }, 7000);
  assert.equal(limit.res.report.status, "PURCHASE_LIMIT");
  assert.equal(limit.fx.state.addAttempts, 1, "une seule tentative : la limite d'achat n'est pas contournée");
  assert.equal(limit.fx.state.cart.length, 0);
  assert.equal(limit.fx.state.paymentHits, 0);
});

t("Chromium réel : passage de main CART_SUCCESS → utilisateur — aucune requête bancaire, aucune navigation hors fixture, aucun paiement, durées mesurées", async () => {
  const { res, fx, lines } = await run({ scenario: "contention" }, 8000);
  assert.equal(res.report.status, "CART_SUCCESS", lines.join("\n"));
  const tm = res.report.timings;
  assert.ok(tm.cart_success_to_ui_ready! >= 0 && tm.cart_success_to_ui_ready! < 500, `CART_SUCCESS → UI prête ${tm.cart_success_to_ui_ready} ms`);
  assert.ok(tm.ui_ready_to_user_control! >= 0 && tm.ui_ready_to_user_control! < 500, `UI prête → contrôle ${tm.ui_ready_to_user_control} ms`);
  assert.match(lines.join("\n"), /CART_SUCCESS\nPAYMENT_REQUIRED\nPAYMENT_MANUAL/);
  assert.equal(fx.state.paymentHits, 0, "aucune requête vers le paiement / une banque");
  assert.ok(!fx.state.requests.some((x) => /payment|card|cvv|cvc|3ds|bank/i.test(x)), "aucune requête de type paiement/carte/banque");
  assert.equal(fx.state.requests.at(-1), "GET /cart", "la dernière requête est la vérification du panier : plus aucune navigation ensuite");
  assert.equal(fx.state.requests.filter((x) => /^GET \/(event|account|login)/.test(x) && fx.state.requests.lastIndexOf(x) > fx.state.requests.lastIndexOf("GET /cart")).length, 0);
  assert.equal(res.report.metrics.claudeCallsTotal, 0);
  console.log(`CART_SUCCESS → UI prête : ${tm.cart_success_to_ui_ready} ms · UI prête → contrôle utilisateur : ${tm.ui_ready_to_user_control} ms`);
});
