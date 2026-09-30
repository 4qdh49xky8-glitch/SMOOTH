import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { stripComments } from "../src/sites/contract.js";

/**
 * Le navigateur n'utilise QUE les mécanismes normaux du site. Interdits (balayage du code) : furtivité, usurpation d'empreinte,
 * résolution de CAPTCHA, proxys, modification de cookies/session/en-têtes, scripts injectés, réécriture de réponses, paiement.
 */
const ts = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? ts(join(dir, f)) : f.endsWith(".ts") ? [join(dir, f)] : []));
const FILES = ["src/browser", "src/sites", "src/selectors", "src/agent", "src/cli"].flatMap(ts).filter((f) => !f.endsWith("src/sites/contract.ts"));
const code = (f: string): string => stripComments(readFileSync(f, "utf8"));

const FORBIDDEN: [RegExp, string][] = [
  [/stealth|undetected|puppeteer-extra|playwright-extra/i, "furtivité"],
  [/AutomationControlled|navigator\.webdriver|disable-blink-features/i, "masquage de l'automatisation"],
  [/userAgent|setUserAgentOverride|user-agent|Sec-CH-UA|setExtraHTTPHeaders|extraHTTPHeaders/i, "usurpation d'identité navigateur / en-têtes"],
  [/fingerprint|canvas.*noise|webgl.*vendor|spoof|Emulation\.set(Device|Timezone|Locale|Geolocation|Hardware)/i, "usurpation d'empreinte"],
  [/addInitScript|evaluateOnNewDocument|exposeFunction|exposeBinding/i, "script injecté dans les pages"],
  [/addCookies|clearCookies|deleteCookie|Network\.(set|delete|clear)Cookie|storageState|localStorage\.setItem|sessionStorage\.setItem|document\.cookie\s*=/i, "modification de cookies / session"],
  [/proxy[-_ ]?server|proxy:|rotateProxy|proxy[-_ ]?(rotat|pool)|residential/i, "proxy"],
  [/route\.fulfill|\.fulfill\(|route\.continue\(\s*\{|overrides|Fetch\.(fulfill|continue)Request/i, "réécriture de requêtes/réponses"],
  [/2captcha|anti-?captcha|capsolver|solve-?captcha|captcha[-_ ]?solver/i, "résolution de CAPTCHA"],
  [/createAccount|registerAccount|signUp\(|generateAccount|fakeAccount/i, "création de compte"],
  [/--disable-web-security|--ignore-certificate-errors|--disable-site-isolation|ignoreHTTPSErrors/i, "sécurité du navigateur affaiblie"],
  [/Network\.setBlockedURLs[\s\S]{0,200}(analytics|doubleclick|googletagmanager|hotjar|recaptcha|hcaptcha|turnstile|datadome|perimeterx|akamai|cloudflare)/i, "blocage de scripts de protection/analytique"],
];
for (const [re, why] of FORBIDDEN) {
  test(`navigateur : aucun motif « ${why} » dans src/ (browser, sites, selectors, agent, cli)`, () => {
    const hits = FILES.filter((f) => re.test(code(f)));
    assert.deepEqual(hits, [], why);
  });
}

test("lancement de Chromium : liste EXACTE des arguments (aucune option d'invisibilité, de proxy ou d'affaiblissement) — toute nouvelle option doit être examinée ici", () => {
  const src = code("src/browser/launch.ts");
  const args = [...src.slice(src.indexOf("const args = ["), src.indexOf("];", src.indexOf("const args = [")))
    .matchAll(/["`](--[a-z][a-z-]*|about:blank)/g)].map((m) => m[1]!);
  assert.deepEqual(args, [
    "--remote-debugging-port", "--user-data-dir", "--no-first-run", "--no-default-browser-check", "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--window-size", "--headless", "--no-sandbox", "about:blank",
  ]);
});

test("blocage de ressources : uniquement images, polices et vidéos — aucun script, aucun domaine tiers", () => {
  const src = code("src/browser/cdp.ts");
  const list = src.slice(src.indexOf("const HEAVY_URL_PATTERNS"), src.indexOf("];", src.indexOf("const HEAVY_URL_PATTERNS")));
  const patterns = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(patterns.length > 0);
  for (const p of patterns) assert.match(p, /^\*\.(png|jpg|jpeg|gif|webp|avif|svg|woff2?|mp4|webm)$/, p);
  assert.ok(!/Emulation\./.test(src), "aucune émulation (focus, appareil, fuseau) : le navigateur se comporte normalement");
});

test("garde réseau : un seul point d'interception ; il n'annule que le paiement et les navigations hors domaines autorisés, et laisse passer le reste sans modification", () => {
  const src = code("src/browser/guards.ts");
  assert.equal([...src.matchAll(/context\.route\(/g)].length, 1);
  assert.equal([...src.matchAll(/route\.abort\(\)/g)].length, 2, "deux refus : paiement, navigation");
  assert.match(src, /route\.fallback\(\)/);
  assert.ok(!/fulfill|continue\(|setExtraHTTPHeaders/.test(src));
});

test("mesures de latence, pas de délais artificiels : aucun sleep fixe ni setTimeout littéral dans les adaptateurs et sélecteurs", () => {
  const offenders = ["src/sites", "src/selectors"].flatMap(ts).filter((f) => /waitForTimeout\(|\bsleep\(\s*\d{2,}|setTimeout\([^)]*,\s*\d{3,}/.test(code(f)));
  assert.deepEqual(offenders, []);
});
