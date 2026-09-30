import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { startDemoServer } from "../../demo/server.js";
import { DIGEST_SCRIPT, sanitizeDigest, buildHealPrompt, type RawDigest } from "../../src/agent/claude.js";
import { installNetworkGuards } from "../../src/browser/guards.js";
import { openBrowser, type BrowserSession } from "../../src/browser/launch.js";
import { ConfigSchema } from "../../src/config/schema.js";
import { main } from "../../src/index.js";
import { detectCommonBlocker } from "../../src/selectors/blockers.js";
import ExampleSite from "../../src/sites/ExampleSite.js";
import { silentLogger } from "../../src/utils/logger.js";
import { sleep } from "./harness.js";

/**
 * Contrôles qui exigent un VRAI navigateur (Chromium local, site factice local — aucun réseau externe).
 * Ignorés, avec la raison affichée, si Chromium est indisponible.
 */
let browser: Browser | undefined;
let skipReason: string | undefined;
let demo: Awaited<ReturnType<typeof startDemoServer>>;
const sessions: BrowserSession[] = [];
const tmp = mkdtempSync(join(tmpdir(), "e2e-"));

const cfg = (extra: Record<string, unknown> = {}) =>
  ConfigSchema.parse({
    site: "example",
    event: { name: "E2E", url: `${demo.url}/event` },
    sale: { startTime: new Date(Date.now() + 60_000).toISOString() },
    tickets: { quantity: 2, maxPricePerTicket: 150 },
    browser: { headless: true, executablePath: process.env.CHROMIUM_PATH },
    ...extra,
  });

before(async () => {
  demo = await startDemoServer({ openAt: Date.now() - 1000 });
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] });
  } catch (e) {
    skipReason = `Chromium indisponible (${(e as Error).message.split("\n")[0]}) — définissez CHROMIUM_PATH`;
  }
});
after(async () => {
  for (const s of sessions) await s.shutdown().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await demo.close();
  rmSync(tmp, { recursive: true, force: true });
});

const withPage = async (html: string): Promise<Page> => {
  const page = await browser!.newPage();
  await page.setContent(html);
  return page;
};
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: undefined }, async (ctx) => (skipReason ? ctx.skip(skipReason) : fn()));

t("12 · deux navigateurs simultanés : ports, profils, cookies et onglets séparés ; un profil se retrouve, jamais un autre", async () => {
  const [a, b] = await Promise.all([
    openBrowser(cfg(), silentLogger, { userDataDir: join(tmp, "profil-a") }),
    openBrowser(cfg(), silentLogger, { userDataDir: join(tmp, "profil-b") }),
  ]);
  sessions.push(a, b);
  assert.notEqual(a.port, b.port, "ports CDP distincts (choisis automatiquement)");
  assert.notEqual(a.userDataDir, b.userDataDir);

  // A se connecte au site ; B ne doit pas hériter de la session.
  await a.page.goto(`${demo.url}/login`);
  await a.page.fill('[data-testid="login-email"]', "demo@example.com");
  await a.page.fill('[data-testid="login-password"]', "demo");
  await a.page.click('[data-testid="login-submit"]');
  await a.page.waitForURL(/\/account/);
  await b.page.goto(`${demo.url}/account`);
  assert.match(a.page.url(), /\/account$/);
  assert.match(b.page.url(), /\/login$/, "la session de A a fuité vers B");
  assert.notEqual(a.page, b.page);

  // Réouverture du profil A : on retrouve SON navigateur (même port), sans toucher à B.
  const again = await openBrowser(cfg(), silentLogger, { userDataDir: join(tmp, "profil-a") });
  sessions.push(again);
  assert.equal(again.port, a.port);
  assert.notEqual(again.port, b.port);
  await again.detach();

  // Un port fixe déjà pris par un autre profil est refusé au lieu d'être partagé en silence.
  await assert.rejects(openBrowser(cfg({ browser: { headless: true, executablePath: process.env.CHROMIUM_PATH, debugPort: a.port } }), silentLogger, { userDataDir: join(tmp, "profil-c") }), /déjà utilisé par un autre navigateur/);
});

t("18 · garde-fou de paiement : la page de paiement n'est jamais atteinte pendant le run, puis accessible à la reprise manuelle", async () => {
  const s = await openBrowser(cfg(), silentLogger, { userDataDir: join(tmp, "profil-garde") });
  sessions.push(s);
  const release = await installNetworkGuards(s.context, { paymentPatterns: new ExampleSite().paymentUrlPatterns, allowedHosts: ["127.0.0.1", "localhost"], log: silentLogger });
  const before = demo.state.paymentHits;
  await assert.rejects(s.page.goto(`${demo.url}/payment`), /ERR_FAILED|aborted|net::/);
  assert.equal(demo.state.paymentHits, before, "la requête de paiement ne doit même pas atteindre le serveur");
  const other = await s.context.newPage(); // le reste du site reste accessible (onglet neuf : l'onglet bloqué affiche une page d'erreur du navigateur)
  await other.goto(`${demo.url}/event`);
  await other.close();
  await release();
  await s.page.goto(`${demo.url}/payment`);
  assert.equal(demo.state.paymentHits, before + 1, "après le run, le paiement manuel est possible");
});

t("garde réseau : une NAVIGATION vers un hôte hors domaines autorisés est annulée (y compris par redirection) sans atteindre le serveur ; les hôtes autorisés et les sous-ressources passent", async () => {
  const s = await openBrowser(cfg(), silentLogger, { userDataDir: join(tmp, "profil-hotes") });
  sessions.push(s);
  const port = new URL(demo.url).port;
  assert.equal(new URL(demo.url).hostname, "127.0.0.1");
  const seen: string[] = [];
  demo.server.on("request", (req) => void seen.push(String(req.headers.host)));
  const blocked: string[] = [];
  const release = await installNetworkGuards(s.context, { paymentPatterns: [], allowedHosts: ["127.0.0.1"], log: silentLogger, onBlocked: (u, why) => void blocked.push(`${why}:${new URL(u).hostname}`) });
  // 1. navigation directe vers un autre hôte (« localhost » ≠ « 127.0.0.1 ») : annulée, le serveur ne voit rien
  await assert.rejects(s.page.goto(`http://localhost:${port}/event`), /ERR_FAILED|aborted|net::/);
  assert.ok(!seen.some((h) => h.startsWith("localhost")), "la requête vers l'hôte non autorisé ne doit pas partir");
  assert.deepEqual(blocked, ["host:localhost"]);
  // 2. l'hôte autorisé fonctionne normalement (onglet neuf : l'onglet bloqué affiche une page d'erreur du navigateur)
  const p2 = await s.context.newPage();
  await p2.goto(`${demo.url}/event`);
  assert.match(p2.url(), /^http:\/\/127\.0\.0\.1:/, "navigation autorisée (le site peut rediriger vers sa propre page de connexion)");
  // 3. une REDIRECTION de page vers un hôte non autorisé est annulée aussi (navigation déclenchée par le script de la page)
  await p2.evaluate((target) => void (window.location.href = target), `http://localhost:${port}/event`);
  await sleep(400);
  assert.ok(!seen.some((h) => h.startsWith("localhost")), "redirection côté page vers un hôte non autorisé");
  assert.ok(blocked.length >= 2);
  // 4. les sous-ressources (fetch de la page vers un autre hôte) ne sont PAS modifiées : le garde ne réécrit pas le fonctionnement du site
  const p3 = await s.context.newPage();
  await p3.goto(`${demo.url}/event`);
  await p3.evaluate((u) => fetch(u, { mode: "no-cors" }).catch(() => undefined), `http://localhost:${port}/event/offers/none`);
  await sleep(200);
  assert.ok(seen.some((h) => h.startsWith("localhost")), "une sous-ressource suit le fonctionnement normal du site (non interceptée)");
  await release();
  const p4 = await s.context.newPage();
  await p4.goto(`http://localhost:${port}/event`); // garde levé : navigation possible
});

t("18 · de bout en bout (vrai navigateur) : panier obtenu, puis arrêt — la page de paiement n'est jamais demandée", async () => {
  const d = await startDemoServer({ openAt: Math.ceil((Date.now() + 5000) / 1000) * 1000, contention: true });
  const file = join(tmp, "stress-e2e.json");
  writeFileSync(file, JSON.stringify({
    site: "example", event: { name: "E2E", url: `${d.url}/event` }, sale: { startTime: new Date(Math.ceil((Date.now() + 5000) / 1000) * 1000).toISOString() },
    tickets: { quantity: 2, maxPricePerTicket: 150, categories: ["Catégorie 1", "Catégorie 2", "Catégorie 3"] },
    timing: { preArmSeconds: 3 }, browser: { headless: true, userDataDir: join(tmp, "profil-e2e"), executablePath: process.env.CHROMIUM_PATH },
    telemetry: { dir: join(tmp, "runs-e2e") },
  }));
  const prev = { e: process.env.EXAMPLE_EMAIL, p: process.env.EXAMPLE_PASSWORD };
  process.env.EXAMPLE_EMAIL = "demo@example.com";
  process.env.EXAMPLE_PASSWORD = "demo";
  try {
    const code = await main(["run", "--config", file, "--exit-when-done", "--log-level", "error"]);
    assert.equal(code, 0);
    assert.equal(d.state.cart.length, 1);
    assert.equal(d.state.cart[0]!.offerId, "o6", "repli après contention");
    assert.equal(d.state.paymentHits, 0, "AUCUNE requête vers la page de paiement");
    await sleep(300);
    assert.equal(d.state.addAttempts, 2, "aucune tentative d'ajout supplémentaire après le panier");
  } finally {
    process.env.EXAMPLE_EMAIL = prev.e;
    process.env.EXAMPLE_PASSWORD = prev.p;
    rmSync(join(".profile", "stress-e2e"), { recursive: true, force: true });
    await d.close();
  }
});

const HOSTILE_PAGE = `<html><head><title>Panier de Jean Dupont — jean.dupont@example.com</title></head><body>
<header><a href="/compte?sid=SESSION-9f8e7d6c5b4a" data-testid="account">Bonjour Jean Dupont</a><a href="/logout">Déconnexion</a></header>
<nav><a href="/aide">Aide jean.dupont@example.com</a></nav>
<main>
  <p>Vos billets, Jean Dupont, 12 rue de la Paix. Carte 4970101234567890</p>
  <form>
    <input type="email" value="jean.dupont@example.com" id="mail"><input type="password" value="hunter2secret" id="pwd">
    <input type="text" value="4970101234567890" id="card" autocomplete="cc-number"><textarea id="addr">12 rue de la Paix</textarea>
    <select id="who"><option selected>Jean Dupont</option></select>
    <button type="button" data-testid="add-to-cart">Ajouter au panier</button>
    <input type="submit" value="Valider la sélection" id="go">
  </form>
</main><footer><a href="/contact">Contact — support@example.com</a></footer></body></html>`;

t("10 · sur une vraie page : Claude ne reçoit que les boutons du contenu principal — ni champs, ni menu de compte, ni titre, ni pied de page", async () => {
  const page = await withPage(HOSTILE_PAGE);
  const raw = (await page.evaluate(DIGEST_SCRIPT)) as RawDigest;
  const rawJson = JSON.stringify(raw);
  for (const s of ["hunter2secret", "jean.dupont@example.com", "4970101234567890", "Jean Dupont", "12 rue de la Paix", "SESSION-9f8e7d6c5b4a", "support@example.com"])
    assert.ok(!rawJson.includes(s), `« ${s} » déjà présent dans ce que la PAGE renvoie`);
  assert.deepEqual(raw.els.map((e) => e.testid || e.id).sort(), ["add-to-cart", "go"].sort(), "seuls les boutons du contenu principal");
  const spec = { name: "addToCart", description: "Bouton « Ajouter au panier »", candidates: [] };
  const { system, user } = buildHealPrompt(spec, sanitizeDigest(raw, spec));
  assert.ok(`${system}${user}`.includes("Ajouter au panier"));
  assert.equal(raw.title, "");
  await page.close();
});

t("détection de blocages sur pages réelles : pas de faux positif sur une page événement, détection sur une vraie file/CAPTCHA/limite", async () => {
  const faq = "<h1>Concert</h1>" + "<p>Réservez vos places pour un concert exceptionnel. </p>".repeat(60) + "<p>FAQ : en cas d'affluence, une file d'attente virtuelle peut être mise en place. Limite de 4 billets par commande. Nombre maximum de billets par client : 4.</p>";
  const cases: [string, string, string | null][] = [
    ["page événement longue (FAQ file d'attente + information de limite)", faq, null],
    ["bandeau d'information « Limite de 4 billets par commande »", "<main><button>Ajouter</button><p>Limite de 4 billets par commande.</p></main>", null],
    ["salle d'attente (page courte)", "<h1>Vous êtes dans la file d'attente</h1><p>Merci de patienter</p>", "QUEUE"],
    ["salle d'attente balisée", '<div id="waiting-room">x</div>', "QUEUE"],
    ["CAPTCHA (iframe)", '<iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe>', "CAPTCHA"],
    ["limite atteinte", "<main><p>Vous avez atteint la limite de billets pour cet événement.</p></main>", "PURCHASE_LIMIT"],
    ["accès refusé (page courte)", "<h1>Access denied</h1>", "BLOCKED"],
  ];
  for (const [label, html, expected] of cases) {
    const page = await withPage(html);
    assert.equal((await detectCommonBlocker(page))?.state ?? null, expected, label);
    await page.close();
  }
});
