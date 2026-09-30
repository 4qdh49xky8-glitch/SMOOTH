import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { authorizeAdapter } from "../src/platforms/authorize.js";
import { STATUSES, buildCatalog, loadCatalog, parseCatalogFile, stateOf, type Catalog } from "../src/platforms/catalog.js";
import { CHANNELS, loadEvidence, validateEvidence } from "../src/platforms/evidence.js";
import { resolveChannel } from "../src/agent/channels.js";
import { DAY, NOW, adapter, catalogWith, daysAgo, ev, plat } from "./helpers/platformFixtures.js";

/** AUDIT du modèle de preuves : chaque refus et chaque règle de calcul du statut, y compris les cas pièges. */
const PLATFORMS = [{ id: "p", officialHosts: ["p.example"] }];
const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  platform: "p", checkedAt: daysAgo(1), source: { url: "https://www.p.example/conditions", title: "Conditions (FICTIVES)" }, channel: "browser",
  authorization: "Texte FICTIF de test décrivant ce que la source autorise.", excerpt: "Passage FICTIF de test, cité tel quel depuis la page officielle fictive.", ...over,
});
const check = (over: Record<string, unknown>) => validateEvidence(base(over), { platforms: PLATFORMS, now: NOW, allowExpired: false });
const codes = (over: Record<string, unknown>): string[] => check(over).issues.map((i) => i.code);
const url = (u: string): Record<string, unknown> => ({ source: { url: u, title: "t" } });

// ───────────────────────────── URL et domaine ─────────────────────────────
test("URL : seul https est accepté (http, ftp, javascript:, data:, file:, schéma relatif, vide → refus)", () => {
  assert.deepEqual(codes({}), [], "référence : la preuve de base est valide");
  for (const u of ["http://www.p.example/x", "ftp://www.p.example/x", "javascript:alert(1)", "data:text/html,<p>x", "file:///etc/passwd", "//www.p.example/x", "www.p.example/x", "", "   "]) {
    assert.ok(codes(url(u)).includes("NO_HTTPS_URL"), `refusée : « ${u} »`);
  }
  assert.ok(codes({ source: { title: "t" } }).includes("NO_HTTPS_URL"), "url absente");
  assert.ok(codes({ source: "https://www.p.example/" }).includes("NO_SOURCE"), "source non objet");
  assert.ok(codes({ source: { url: 42, title: "t" } }).includes("NO_HTTPS_URL"), "url non textuelle");
});

test("domaine : sosies, sous-domaines d'un tiers, identifiants intégrés, barre oblique inverse, point final, encodage → refus ; vrais sous-domaines et casse → acceptés", () => {
  const refused = [
    "https://evilp.example/x", // suffixe sans point
    "https://p.example.evil.com/x", // la plateforme n'est qu'un sous-domaine du tiers
    "https://www.p.example.evil.com/x",
    "https://p.example@evil.com/x", // userinfo : l'hôte réel est evil.com
    "https://www.p.example:pw@evil.com/x",
    "https://evil.com\\@www.p.example/x", // la barre oblique inverse coupe l'hôte avant le @
    "https://evil.com#@www.p.example/",
    "https://evil.com?.p.example/",
    "https://www.p.example%2eevil.com/x", // point encodé
    "https://www.p.example./x", // point final : refusé par prudence
    "https://xn--p-example.com/x", // punycode
    "https://p.example.com/x",
    "https://example/x",
    "https://127.0.0.1/x",
    "https://[::1]/x",
  ];
  for (const u of refused) assert.ok(codes(url(u)).some((c) => c === "DOMAIN_MISMATCH" || c === "NO_HTTPS_URL"), `refusée : ${u}`);
  for (const u of ["https://p.example/x", "https://www.p.example/x", "https://a.b.p.example/x", "HTTPS://WWW.P.EXAMPLE/X", "https://www.p.example:8443/x"]) assert.deepEqual(codes(url(u)), [], `acceptée : ${u}`);
});

test("identifiants dans l'URL de la preuve : refusés (l'URL est conservée dans l'historique et les exports)", () => {
  assert.ok(codes(url("https://user:secret@www.p.example/x")).includes("CREDENTIALS_IN_URL"));
  assert.ok(codes(url("https://token@www.p.example/x")).includes("CREDENTIALS_IN_URL"));
});

test("redirections : une preuve n'est jamais TÉLÉCHARGÉE ni suivie — sa validation et son chargement ne font aucune requête", async () => {
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    throw new Error("réseau interdit");
  }) as typeof fetch;
  try {
    // L'hôte d'une URL de redirection ouverte (…/redirect?to=https://evil.com) est celui de la plateforme : seule la vérification
    // d'hôte s'applique, le contenu n'est jamais résolu. Limite documentée : l'auditeur doit citer l'URL de la page lue.
    check(url("https://www.p.example/redirect?to=https://evil.com"));
    const dir = mkdtempSync(join(tmpdir(), "ev-"));
    writeFileSync(join(dir, "a.json"), JSON.stringify(base()));
    loadEvidence(dir, PLATFORMS, NOW);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(fetched, 0);
});

// ───────────────────────────── dates ─────────────────────────────
test("dates : future refusée ; jour inexistant refusé (pas de débordement sur le mois suivant) ; formats douteux refusés", () => {
  assert.ok(codes({ checkedAt: daysAgo(-1) }).includes("FUTURE_DATE"), "demain");
  assert.ok(codes({ checkedAt: daysAgo(-400) }).includes("FUTURE_DATE"));
  for (const d of ["2026-02-30", "2026-02-31", "2026-04-31", "2026-13-01", "2026-00-10", "2026-01-00", "2026-9-1", "26-09-01", "2026/09/01", "01/09/2026", "2026-09-01T00:00:00Z", "hier", "", 20260901, null]) {
    assert.ok(codes({ checkedAt: d }).includes("NO_DATE"), `refusée : ${JSON.stringify(d)}`);
  }
  assert.deepEqual(codes({ checkedAt: "2024-02-29" }).filter((c) => c !== "TOO_OLD"), [], "29 février d'une année bissextile : réel");
  assert.ok(codes({ checkedAt: "2025-02-29" }).includes("NO_DATE"), "29 février d'une année non bissextile : inexistant");
});

test("expiration : valide au jour 180, expirée au jour 181 (limites exactes, à l'ajout ET dans le calcul du statut)", () => {
  const at = (n: number) => catalogWith([plat("p")], [ev("p", "browser", daysAgo(n))]);
  assert.equal(stateOf(at(179), "p", NOW).status, "BROWSER_ONLY");
  assert.equal(stateOf(at(180), "p", NOW).status, "BROWSER_ONLY", "jour 180 : encore valide");
  assert.equal(stateOf(at(180), "p", NOW).expiresInDays, 0, "dernier jour de validité");
  assert.equal(stateOf(at(181), "p", NOW).status, "EXPIRED", "jour 181 : expirée");
  assert.deepEqual(codes({ checkedAt: daysAgo(180) }), [], "ajout : jour 180 accepté");
  assert.deepEqual(codes({ checkedAt: daysAgo(181) }), ["TOO_OLD"], "ajout : jour 181 refusé");
  // Le même relevé, évalué à des instants différents : l'expiration suit l'horloge, pas un état enregistré.
  const c = at(170);
  assert.equal(stateOf(c, "p", NOW + 10 * DAY).status, "BROWSER_ONLY");
  assert.equal(stateOf(c, "p", NOW + 11 * DAY).status, "EXPIRED");
  // Juste avant / après minuit UTC : le jour est calendaire, pas une fenêtre glissante de 24 h.
  const d180 = Date.parse(`${daysAgo(180)}T00:00:00Z`);
  assert.equal(stateOf(at(180), "p", d180 + 180 * DAY + DAY - 1).status, "BROWSER_ONLY");
  assert.equal(stateOf(at(180), "p", d180 + 181 * DAY).status, "EXPIRED");
});

// ───────────────────────────── plusieurs preuves ─────────────────────────────
const status = (...records: ReturnType<typeof ev>[]) => stateOf(catalogWith([plat("p")], records), "p", NOW);
const permutations = <T,>(a: T[]): T[][] => (a.length <= 1 ? [a] : a.flatMap((x, i) => permutations([...a.slice(0, i), ...a.slice(i + 1)]).map((r) => [x, ...r])));

const api = (file = "api"): ReturnType<typeof ev> => ev("p", "api", daysAgo(2), { source: { url: "https://developer.p.example/terms", title: "Conditions de l'API (FICTIVES)" }, file });
const web = (file = "web"): ReturnType<typeof ev> => ev("p", "browser", daysAgo(2), { source: { url: "https://www.p.example/cgu", title: "CGU (FICTIVES)" }, file });

test("une preuve API + une preuve Browser (pages officielles différentes) → API_AND_BROWSER, quel que soit l'ordre", () => {
  for (const order of permutations([api(), web()])) {
    const st = status(...order);
    assert.equal(st.status, "API_AND_BROWSER");
    assert.deepEqual(st.channels, ["official-api", "browser"]);
  }
  assert.equal(status(ev("p", "both")).status, "API_AND_BROWSER", "une preuve « both » aussi");
  assert.equal(status(api()).status, "API_ONLY", "API seule : le navigateur n'est PAS autorisé");
  assert.equal(status(web()).status, "BROWSER_ONLY", "navigateur seul : l'API n'est PAS autorisée");
});

test("une preuve plus restrictive n'est JAMAIS neutralisée par une plus permissive (toutes permutations)", () => {
  // Interdiction « human » : veto sur tout, même face à des preuves « both » plus récentes, d'autres pages, ou cumulées.
  const grants = [ev("p", "both", daysAgo(1)), api(), web(), ev("p", "browser", daysAgo(0), { source: { url: "https://www.p.example/autre", title: "Autre page" }, file: "autre" })];
  const prohibition = ev("p", "prohibited", daysAgo(150), { source: { url: "https://www.p.example/robots", title: "Règles robots (FICTIVES)" }, file: "human" });
  for (const order of permutations([prohibition, ...grants.slice(0, 3)])) assert.equal(status(...order).status, "NOT_ALLOWED", order.map((r) => r.channel).join(","));
  assert.deepEqual(status(prohibition, ...grants).channels, []);
  // Même page officielle : le plus restrictif l'emporte (both + api → api ; both + browser → browser ; api + browser → rien).
  const same = (ch: "both" | "api" | "browser" | "prohibited", d: number) => ev("p", ch, daysAgo(d));
  for (const order of permutations([same("both", 1), same("api", 3)])) assert.equal(status(...order).status, "API_ONLY", "both ∩ api");
  for (const order of permutations([same("both", 1), same("browser", 3)])) assert.equal(status(...order).status, "BROWSER_ONLY", "both ∩ browser");
  for (const order of permutations([same("api", 1), same("browser", 3)])) assert.equal(status(...order).status, "NOT_ALLOWED", "contradiction sur une même page");
  // Une interdiction plus ANCIENNE (mais valide) n'est pas levée par une preuve plus récente.
  assert.equal(status(same("prohibited", 170), same("both", 0)).status, "NOT_ALLOWED");
  assert.ok(status(same("prohibited", 170), same("both", 0)).conflicts.length > 0, "la divergence est signalée");
  // Une preuve permissive EXPIRÉE n'accorde rien ; une interdiction expirée ne fait pas d'une reconsultation récente une autorisation cachée.
  assert.equal(status(ev("p", "both", daysAgo(181))).status, "EXPIRED");
  assert.equal(status(ev("p", "both", daysAgo(181)), same("prohibited", 2)).status, "NOT_ALLOWED");
  assert.equal(status(same("prohibited", 181)).status, "EXPIRED", "interdiction expirée seule : EXPIRED (jamais une autorisation)");
});

test("NOT_ALLOWED bloque TOUJOURS l'exécution : autorisation, choix du canal, canal forcé", () => {
  const cat = catalogWith([plat("p")], [ev("p", "both", daysAgo(1)), api(), ev("p", "prohibited", daysAgo(100), { source: { url: "https://www.p.example/robots", title: "t" }, file: "h" })]);
  assert.equal(stateOf(cat, "p", NOW).status, "NOT_ALLOWED");
  for (const ch of ["browser", "official-api"] as const) {
    const a = adapter(`p-${ch}`, { platform: "p", channel: ch });
    assert.equal(authorizeAdapter(a.meta, cat, NOW).ok, false, ch);
    assert.throws(() => resolveChannel({ platform: "p", adapters: [a], catalog: cat, env: { P_KEY: "x" }, config: { channel: ch }, now: NOW }), /indisponible/);
    assert.equal(resolveChannel({ platform: "p", adapters: [a], catalog: cat, env: {}, config: { channel: "auto" }, now: NOW }).channel, "human");
  }
});

// ───────────────────────────── refus de format ─────────────────────────────
test("champs, plateforme, sujet et canal inconnus ou déguisés → refus (casse, espaces, clés de prototype, types)", () => {
  for (const k of ["status", "verified", "allowUnverified", "__proto__x", "Channel", "channels", "expires", "expiresAt", "id"]) assert.ok(codes({ [k]: "x" }).includes("UNKNOWN_FIELD"), `champ inconnu : ${k}`);
  for (const p of ["q", "P", "__proto__", "constructor", "toString", "hasOwnProperty", "", 7, null, ["p"], { id: "p" }]) {
    const c = codes({ platform: p });
    assert.ok(c.includes("UNKNOWN_PLATFORM") || c.includes("NO_PLATFORM"), `plateforme refusée : ${JSON.stringify(p)}`);
  }
  for (const ch of ["Browser", "BROWSER", "web", "all", "auto", "official-api", "none", "forbidden", "Human", "constructor", "__proto__", "", 1, true, null, ["api"], undefined]) {
    assert.ok(codes({ channel: ch }).includes("BAD_CHANNEL"), `canal refusé : ${JSON.stringify(ch)}`);
  }
  for (const t of ["Automation", "auto", "terms", "", 0, null, ["api"], {}]) assert.ok(codes({ topic: t }).includes("BAD_TOPIC"), `sujet refusé : ${JSON.stringify(t)}`);
  for (const v of ["oui", "", "NONE", undefined, 3]) assert.ok(codes({ topic: "api", channel: undefined, value: v }).includes("BAD_VALUE"), `valeur refusée : ${JSON.stringify(v)}`);
  for (const raw of [null, undefined, 3, "x", [], [base()], true]) assert.equal(validateEvidence(raw, { platforms: PLATFORMS, now: NOW, allowExpired: false }).issues[0]?.code, "NOT_OBJECT");
  assert.deepEqual([...CHANNELS], ["api", "browser", "both", "human", "prohibited"], "la liste des canaux ne change pas sans décision explicite");
});

test("un fichier refusé n'autorise RIEN, même avec un canal permissif : la plateforme reste NOT_VERIFIED", () => {
  const dir = mkdtempSync(join(tmpdir(), "ev-"));
  const bad: Record<string, unknown>[] = [
    base({ channel: "Browser" }), base({ platform: "inconnue" }), base({ status: "BROWSER_ONLY" }), base({ source: { url: "http://www.p.example/x", title: "t" } }),
    base({ source: { url: "https://www.evil.example/x", title: "t" } }), base({ checkedAt: daysAgo(-1) }), base({ checkedAt: "2026-02-30" }), base({ excerpt: "trop court" }),
  ];
  bad.forEach((b, i) => writeFileSync(join(dir, `bad-${i}.json`), JSON.stringify(b)));
  writeFileSync(join(dir, "broken.json"), "{ pas du json");
  const loaded = loadEvidence(dir, PLATFORMS, NOW);
  assert.equal(loaded.records.length, 0);
  assert.equal(loaded.rejected.length, bad.length + 1);
  assert.equal(stateOf(buildCatalog([plat("p")], loaded.records, loaded.rejected), "p", NOW).status, "NOT_VERIFIED");
});

test("le catalogue statique ne peut porter aucune autorisation : des champs « status/channels/verified » injectés n'ont aucun effet", () => {
  const dir = mkdtempSync(join(tmpdir(), "cat-"));
  const file = join(dir, "catalog.json");
  writeFileSync(file, JSON.stringify({ schemaVersion: 2, platforms: [{ id: "p", name: "P", regions: ["FR"], eventTypes: ["concert"], officialHosts: ["p.example"], clues: [], status: "BROWSER_ONLY", channels: ["browser"], verified: true, allowedChannels: ["browser"] }] }));
  let cat: Catalog | undefined;
  try {
    cat = loadCatalog({ path: file, evidenceDir: join(dir, "vide"), now: NOW });
  } catch {
    cat = undefined; // refuser un catalogue qui prétend autoriser est tout aussi sûr
  }
  if (cat) assert.equal(stateOf(cat, "p", NOW).status, "NOT_VERIFIED");
  assert.throws(() => parseCatalogFile({ schemaVersion: 2, platforms: [{ id: "p" }] }), /Catalogue invalide/);
});

test("absence totale de preuve = NOT_VERIFIED, pour toute plateforme et à tout instant ; les 7 statuts sont les seuls possibles", () => {
  const cat = catalogWith([plat("p"), plat("q")]);
  for (const t of [NOW, 0, NOW + 10_000 * DAY]) for (const id of ["p", "q"]) {
    const st = stateOf(cat, id, t);
    assert.equal(st.status, "NOT_VERIFIED");
    assert.deepEqual(st.channels, []);
  }
  assert.deepEqual([...STATUSES], ["NOT_VERIFIED", "API_ONLY", "BROWSER_ONLY", "API_AND_BROWSER", "HUMAN_ONLY", "EXPIRED", "NOT_ALLOWED"]);
  assert.equal(stateOf(cat, "inconnue", NOW).status, "NOT_VERIFIED", "plateforme absente du catalogue : jamais autorisée");
  // Preuves d'une AUTRE plateforme : aucun effet.
  assert.equal(stateOf(catalogWith([plat("p"), plat("q")], [ev("q", "both")]), "p", NOW).status, "NOT_VERIFIED");
});

// ───────────────────────────── phase B : URL stricte, historique, aucune preuve inventée ─────────────────────────────
test("URL de preuve : fragment refusé ; query refusée sauf paramètres EXPLICITEMENT déclarés dans le catalogue ; lien de redirection/suivi refusé", () => {
  assert.ok(codes(url("https://www.p.example/cgu#article-4")).includes("FRAGMENT_IN_URL"));
  assert.ok(codes(url("https://www.p.example/cgu#")).includes("FRAGMENT_IN_URL"), "fragment vide");
  for (const u of ["https://www.p.example/cgu?lang=fr", "https://www.p.example/cgu?", "https://www.p.example/cgu?a=1&b=2", "https://www.p.example/cgu?url=https://evil.example"]) {
    assert.ok(codes(url(u)).includes("QUERY_IN_URL"), u);
  }
  // nécessité explicitement définie : la plateforme déclare le paramètre ; les autres restent refusés
  const withLang = [{ id: "p", officialHosts: ["p.example"], allowedQueryParams: ["lang"] }];
  const c = (u: string) => validateEvidence(base(url(u)), { platforms: withLang, now: NOW, allowExpired: false }).issues.map((i) => i.code);
  assert.deepEqual(c("https://www.p.example/cgu?lang=fr"), []);
  assert.ok(c("https://www.p.example/cgu?lang=fr&utm_source=x").includes("QUERY_IN_URL"));
  assert.ok(c("https://www.p.example/cgu?next=https://evil.example").includes("QUERY_IN_URL"));
  for (const u of ["https://www.p.example/redirect/abc", "https://www.p.example/out/abc", "https://www.p.example/go/abc", "https://www.p.example/r/abc", "https://www.p.example/l/abc", "https://www.p.example/click/abc", "https://www.p.example/tracking/abc", "https://www.p.example/cgu/link/42", "https://www.p.example/url/x"]) {
    assert.ok(codes(url(u)).includes("REDIRECT_LIKE_URL"), u);
  }
  for (const u of ["https://www.p.example/conditions-generales", "https://www.p.example/legal/terms", "https://www.p.example/goals", "https://www.p.example/outdoor", "https://developer.p.example/api/terms"]) assert.deepEqual(codes(url(u)), [], `faux positif : ${u}`);
});

test("historique CONSERVÉ : une preuve expirée reste dans l'historique après expiration et après une nouvelle preuve ; rien n'est supprimé ni écrasé", () => {
  const old = ev("p", "browser", daysAgo(200), { file: "old.json", note: "CGU 2025" });
  const fresh = ev("p", "both", daysAgo(2), { file: "new.json", note: "CGU 2026" });
  const st = stateOf(catalogWith([plat("p")], [old, fresh]), "p", NOW);
  assert.deepEqual(st.history.map((h) => [h.file, h.expired]), [["new.json", false], ["old.json", true]]);
  assert.equal(st.history.find((h) => h.file === "old.json")!.note, "CGU 2025");
  assert.equal(st.status, "API_AND_BROWSER");
  // l'expiration n'efface rien non plus
  const later = stateOf(catalogWith([plat("p")], [old, fresh]), "p", NOW + 400 * DAY);
  assert.equal(later.history.length, 2);
  assert.equal(later.status, "EXPIRED");
});

test("aucune preuve n'est INVENTÉE : le dépôt n'en contient aucune, aucun code ne les écrit hors `platform add` (fichier fourni), le chargement est en lecture seule", () => {
  assert.deepEqual(readdirSync("platforms/evidence").sort(), ["README.md"], "le dépôt ne livre aucune preuve");
  const writers = (function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") && /writeFileSync|copyFileSync|renameSync|appendFileSync|createWriteStream|\.writeFile\(/.test(readFileSync(p, "utf8")) ? [p] : [];
    });
  })("src").sort();
  // chaque fichier qui écrit sur disque : journaux, télémétrie, verrous, cache de sélecteurs, dépôt d'une preuve fournie
  assert.deepEqual(writers, ["src/cli/platform.ts", "src/selectors/resolver.ts", "src/telemetry/Telemetry.ts", "src/utils/lock.ts", "src/utils/logger.ts"]);
  const platformCli = readFileSync("src/cli/platform.ts", "utf8");
  assert.equal([...platformCli.matchAll(/copyFileSync\(/g)].length, 1, "un seul dépôt : la copie du fichier FOURNI par l'utilisateur, après validation");
  assert.ok(!/writeFileSync|fetch\(|node:https?|XMLHttpRequest|WebSocket/.test(platformCli.replace(/^\s*\/\/.*$/gm, "")), "platform ne fabrique ni ne télécharge de preuve");
  const dir = mkdtempSync(join(tmpdir(), "ro-"));
  writeFileSync(join(dir, "x.json"), JSON.stringify(base()));
  const before = readdirSync(dir).sort();
  loadEvidence(dir, PLATFORMS, NOW);
  loadEvidence(dir, PLATFORMS, NOW);
  assert.deepEqual(readdirSync(dir).sort(), before, "le chargement n'écrit rien");
});
