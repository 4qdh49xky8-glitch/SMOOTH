import assert from "node:assert/strict";
import { test } from "node:test";
import type { Blocker } from "../../src/sites/SiteAdapter.js";
import { actionsBetween, expectRun, runStress, sleep, type StressOutcome } from "./harness.js";

/**
 * Stress test du moteur de décision — 18 scénarios, uniquement contre le faux site (aucun réseau).
 * Chaque scénario vérifie : état final, offre choisie, raison d'échec, tentatives, télémétrie, absence de données sensibles.
 * Les scénarios 10 (Claude), 11-bis, 12 (deux instances) et les contrôles navigateur sont dans les fichiers voisins.
 */
const called = (o: StressOutcome, step: string): number => o.adapter.calls.filter((c) => c === step).length;

test("01 · côte à côte à 90 € vs séparés à 70 € → côte à côte (seatsTogether=true)", async () => {
  const o = await runStress("01-together-90-vs-separate-70");
  expectRun(o, { status: "in-cart", finalState: "CART_SUCCESS", offerId: "ensemble-90", attempts: 1 }, "01");
});

test("02 · côte à côte à 160 € avec budget 120 € → jamais sélectionnée ; repli sur séparés à 100 €", async () => {
  const o = await runStress("02-over-budget-together-160");
  expectRun(o, { status: "in-cart", finalState: "CART_SUCCESS", offerId: "separes-100", attempts: 1 }, "02");
  assert.ok(!o.adapter.calls.some((c) => c === "selectOffer") || o.result.offer?.id !== "ensemble-160");
  assert.equal(o.result.telemetry.attemptsDetail.some((a) => a.pricePerTicket === 160), false, "l'offre à 160 € n'a jamais été tentée");
});

test("02b · même cas en mode strict → aucune offre retenue, rien n'est tenté", async () => {
  const o = await runStress("02b-over-budget-together-strict");
  expectRun(o, { status: "sale-timeout", finalState: "AVAILABLE", failureReason: "NO_MATCHING_OFFER", attempts: 0 }, "02b");
  assert.equal(called(o, "selectOffer"), 0);
});

test("03 · catégorie A épuisée, B disponible → passage à B", async () => {
  const o = await runStress("03-category-a-unavailable");
  expectRun(o, { status: "in-cart", finalState: "CART_SUCCESS", offerId: "b-dispo", attempts: 1 }, "03");
  assert.equal(called(o, "selectOffer"), 1, "l'offre épuisée n'est même pas ouverte");
});

test("04 · plusieurs offres dans le budget → l'ordre des catégories est respecté (C > A > B)", async () => {
  const o = await runStress("04-category-priority");
  expectRun(o, { status: "in-cart", finalState: "CART_SUCCESS", offerId: "c", attempts: 1 }, "04");
});

test("04b · priorityCategories passe avant l'ordre de tickets.categories", async () => {
  const o = await runStress("04b-priority-categories-override");
  expectRun(o, { status: "in-cart", finalState: "CART_SUCCESS", offerId: "b", attempts: 1 }, "04b");
});

test("05 · l'offre devient indisponible avant l'ajout → passage propre à la suivante, sans réessayer la vendue", async () => {
  const o = await runStress("05-offer-sold-before-cart");
  expectRun(o, { status: "in-cart", finalState: "CART_SUCCESS", offerId: "b-stable", attempts: 2 }, "05");
  assert.deepEqual(o.record.attemptsDetail.map((a) => a.outcome), ["unavailable", "cart"]);
  assert.equal(o.record.attemptsDetail[0]!.reason, "OFFER_UNAVAILABLE");
  assert.equal(called(o, "addToCart"), 1, "un seul ajout : celui de l'offre suivante");
});

test("06a · quantité 4 mais seulement des offres de 2 → aucune sélection, aucun panier incomplet", async () => {
  const o = await runStress("06a-quantity-4-only-2-available");
  expectRun(o, { status: "sale-timeout", finalState: "AVAILABLE", failureReason: "NO_MATCHING_OFFER", attempts: 0 }, "06a");
  assert.equal(called(o, "addToCart"), 0);
  assert.ok(!o.notifications.some((n) => /PANIER OBTENU/.test(n.title)));
});

test("06b · le site n'ajoute que 2 billets sur 4 → panier NON déclaré réussi, alerte explicite, arrêt sans empiler", async () => {
  const o = await runStress("06b-partial-cart");
  expectRun(o, { status: "cart-mismatch", finalState: "ERROR", offerId: "quatre", failureReason: "CART_MISMATCH", attempts: 1 }, "06b");
  assert.equal(called(o, "addToCart"), 1, "aucun second ajout : on n'empile pas les paniers");
  assert.ok(o.notifications.some((n) => /vérif|incomplet|⚠/i.test(`${n.title} ${n.message}`)), "l'utilisateur est alerté");
});

test("07a · limite du site = 2, quantité = 4 (limite connue) → arrêt définitif avant toute action sur le site", async () => {
  const o = await runStress("07a-purchase-limit-declared");
  expectRun(o, { status: "blocked", finalState: "PURCHASE_LIMIT", failureReason: "PURCHASE_LIMIT", attempts: 0 }, "07a");
  assert.deepEqual(o.adapter.calls, [], "aucun appel au site");
  assert.equal(o.handoffs.length, 0);
});

test("07b · limite révélée à la sélection → arrêt définitif, une seule tentative, aucune insistance", async () => {
  const o = await runStress("07b-purchase-limit-revealed");
  expectRun(o, { status: "blocked", finalState: "PURCHASE_LIMIT", failureReason: "PURCHASE_LIMIT", attempts: 1 }, "07b");
  assert.equal(called(o, "selectOffer"), 1, "l'autre offre n'est pas tentée pour « contourner » la limite");
  assert.equal(called(o, "addToCart"), 0);
  assert.equal(o.handoffs.length, 0, "pas de cession de main : la limite n'est pas contournable par l'humain non plus");
});

test("08 · file d'attente alors que l'API liste des offres → aucune action de sélection pendant la file", async () => {
  const o = await runStress("08-queue-window");
  expectRun(o, { status: "in-cart", finalState: "CART_SUCCESS", offerId: "o", attempts: 1 }, "08");
  const w = o.scenario.blockWindows[0]!;
  assert.deepEqual(o.adapter.violations, [], "le bot a agi pendant la file d'attente");
  assert.deepEqual(actionsBetween(o, o.saleStart + w.fromMs, o.saleStart + w.untilMs), []);
  assert.equal(o.handoffs.length, 1);
  assert.equal(o.handoffs[0]!.state, "QUEUE");
  assert.ok(o.record.states.some((s) => s.state === "QUEUE"));
});

test("09a · CAPTCHA affiché → le bot cède la main, n'agit plus, reprend seulement après", async () => {
  const o = await runStress("09a-captcha-window");
  expectRun(o, { status: "in-cart", finalState: "CART_SUCCESS", offerId: "o", attempts: 1 }, "09a");
  const w = o.scenario.blockWindows[0]!;
  assert.deepEqual(o.adapter.violations, []);
  assert.deepEqual(actionsBetween(o, o.saleStart + w.fromMs, o.saleStart + w.untilMs), []);
  assert.equal(o.handoffs[0]!.state, "CAPTCHA");
});

test("09b · CAPTCHA sans humain (headless) → arrêt propre, aucune action, aucune tentative de contournement", async () => {
  const o = await runStress("09b-captcha-headless");
  expectRun(o, { status: "error", finalState: "ERROR", failureReason: "HUMAN_REQUIRED_HEADLESS", attempts: 0 }, "09b");
  assert.deepEqual(o.adapter.violations, []);
  assert.equal(called(o, "selectOffer") + called(o, "addToCart"), 0);
  assert.ok(o.record.states.some((s) => s.state === "CAPTCHA"));
});

test("11 · huit offres simultanées → un seul choix cohérent, indépendant de l'ordre de la liste", async () => {
  const chosen = new Set<string>();
  let seed = 7;
  const rnd = (): number => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  for (let i = 0; i < 6; i++) {
    const o = await runStress("11-simultaneous-offers", {
      mutate: (s) => ({ ...s, offers: [...s.offers].sort(() => rnd() - 0.5), latencyMs: { ...s.latencyMs, selectOffer: 5, addToCart: 5 } }),
    });
    expectRun(o, { status: "in-cart", finalState: "CART_SUCCESS", offerId: "o5", attempts: 1 }, `11#${i}`);
    // Séquence cohérente : sélection de l'offre X puis UN seul ajout, puis lecture du panier de X.
    const steps = o.adapter.calls.filter((c) => ["selectOffer", "addToCart", "readCart"].includes(c));
    assert.deepEqual(steps, ["selectOffer", "addToCart", "readCart"]);
    chosen.add(o.result.offer!.id);
  }
  assert.deepEqual([...chosen], ["o5"]);
});

test("13 · événement sans catégorie : categories=[] accepte toutes les catégories (même vide ou exotique)", async () => {
  const o = await runStress("13-no-category");
  expectRun(o, { status: "in-cart", finalState: "CART_SUCCESS", offerId: "exotique", attempts: 1 }, "13");
});

test("14 · prix exactement égal au maximum → accepté", async () => {
  const o = await runStress("14-price-equals-max");
  expectRun(o, { status: "in-cart", finalState: "CART_SUCCESS", offerId: "pile", attempts: 1 }, "14");
});

test("15 · prix supérieur d'un centime au maximum → refusé", async () => {
  const o = await runStress("15-price-one-cent-over");
  expectRun(o, { status: "sale-timeout", finalState: "AVAILABLE", failureReason: "NO_MATCHING_OFFER", attempts: 0 }, "15");
  assert.equal(called(o, "selectOffer"), 0);
});

test("16 · aucun billet → SOLD_OUT, surveillance ralentie (pas de boucle agressive), aucune sélection", async () => {
  const o = await runStress("16-sold-out");
  expectRun(o, { status: "sale-timeout", finalState: "SOLD_OUT", failureReason: "NO_MATCHING_OFFER", attempts: 0 }, "16");
  const polls = o.record.metrics.polls;
  // 3 s de surveillance : 2 lectures rapides avant l'ouverture, puis une lecture toutes les ~0,8 s (et non toutes les 0,2 s).
  assert.ok(polls >= 3 && polls <= 8, `${polls} lectures de disponibilité`);
  assert.equal(called(o, "selectOffer") + called(o, "addToCart"), 0);
});

test("17 · connexion manuelle → le bot attend RÉELLEMENT l'humain, sans reprise automatique après une seconde", async () => {
  let release!: () => void;
  let asked!: (m: string) => void;
  const enterAsked = new Promise<string>((r) => (asked = r));
  const fakeEnter = (message: string) => {
    asked(message);
    return { promise: new Promise<void>((r) => (release = r)), cancel: () => undefined };
  };
  let adapter: StressOutcome["adapter"] | undefined;
  const run = runStress("17-login-required", { agentOverrides: { awaitHuman: undefined, waitForEnter: fakeEnter }, onAdapter: (a) => (adapter = a) });
  let settled = false;
  void run.then(() => (settled = true));

  await enterAsked;
  await sleep(1800); // bien plus d'une seconde (la reprise automatique fautive se produisait à ~1 s)
  assert.equal(settled, false, "le bot a repris tout seul");
  assert.deepEqual(adapter!.calls, ["login"], "aucune action tant que l'humain n'a pas confirmé (ni nouvelle connexion, ni lecture de disponibilité)");
  assert.equal(adapter!.calls.filter((c) => c === "fetchSale").length, 0);

  release();
  const o = await run;
  expectRun(o, { status: "in-cart", finalState: "CART_SUCCESS", offerId: "o", attempts: 1 }, "17");
  assert.equal(o.record.metrics.humanHandoffs, 1);
  assert.ok(o.record.states.some((s) => s.state === "LOGIN_REQUIRED"));
  assert.equal(adapter!.calls.filter((c) => c === "login").length, 2, "reconnexion vérifiée après confirmation humaine");
});

test("18 · panier obtenu → arrêt immédiat, aucune étape après la lecture du panier, aucun paiement", async () => {
  const o = await runStress("18-cart-stops-before-payment");
  expectRun(o, { status: "in-cart", finalState: "CART_SUCCESS", offerId: "o", attempts: 1 }, "18");
  const before = o.adapter.callLog.length;
  assert.equal(o.adapter.callLog.at(-1)!.step, "readCart", "readCart est la dernière interaction avec le site");
  assert.ok(!o.adapter.calls.some((c) => /pay|order|checkout/i.test(c)));
  await sleep(900); // rien ne doit continuer en arrière-plan (surveillance, boucle de reprise…)
  assert.equal(o.adapter.callLog.length, before, "activité résiduelle après l'arrêt");
  assert.ok(o.notifications.some((n) => /PANIER OBTENU/.test(n.title) && /vous-même/.test(n.title)));
  const notified: Blocker[] = o.handoffs;
  assert.equal(notified.length, 0);
});
