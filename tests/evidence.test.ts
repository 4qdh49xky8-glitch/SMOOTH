import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadCatalog, stateOf, type PlatformStatus } from "../src/platforms/catalog.js";
import { EVIDENCE_MAX_AGE_DAYS, expiresAt, isExpired, loadEvidence, validateEvidence } from "../src/platforms/evidence.js";
import { DAY, NOW, TODAY, catalogWith, daysAgo, ev, fact, plat } from "./helpers/platformFixtures.js";

const platforms = [plat("p"), plat("q", { officialHosts: ["q.example", "docs.q.example"] })];
const good = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  platform: "p", checkedAt: TODAY, source: { url: "https://www.p.example/cgu", title: "CGU (FICTIVES)" }, channel: "browser",
  authorization: "Texte FICTIF de test : l'automatisation est autorisée.", excerpt: "Passage FICTIF de test, cité tel quel depuis la page officielle fictive.", ...over,
});
const check = (raw: unknown, allowExpired = false) => validateEvidence(raw, { platforms, now: NOW, allowExpired });
const codes = (raw: unknown, allowExpired = false): string[] => check(raw, allowExpired).issues.map((i) => i.code);

// ───────────────────────────── refus d'une preuve ─────────────────────────────
test("une preuve conforme au format demandé est acceptée (api | browser | both | human)", () => {
  for (const channel of ["api", "browser", "both", "human"]) assert.deepEqual(codes(good({ channel })), [], channel);
  assert.equal(check(good()).record?.topic, "automation");
});

test("preuve REFUSÉE sans URL https", () => {
  assert.ok(codes(good({ source: { url: "http://www.p.example/cgu", title: "t" } })).includes("NO_HTTPS_URL"));
  assert.ok(codes(good({ source: { url: "ftp://www.p.example/cgu", title: "t" } })).includes("NO_HTTPS_URL"));
  assert.ok(codes(good({ source: { url: "www.p.example/cgu", title: "t" } })).includes("NO_HTTPS_URL"));
  assert.ok(codes(good({ source: { title: "t" } })).includes("NO_HTTPS_URL"));
  assert.ok(codes(good({ source: undefined })).includes("NO_SOURCE"));
});

test("preuve REFUSÉE sans date (ou avec une date invalide ou future)", () => {
  assert.ok(codes(good({ checkedAt: undefined })).includes("NO_DATE"));
  assert.ok(codes(good({ checkedAt: "" })).includes("NO_DATE"));
  assert.ok(codes(good({ checkedAt: "hier" })).includes("NO_DATE"));
  assert.ok(codes(good({ checkedAt: "2026-13-45" })).includes("NO_DATE"));
  assert.ok(codes(good({ checkedAt: new Date(NOW + 3 * DAY).toISOString().slice(0, 10) })).includes("FUTURE_DATE"));
});

test("preuve REFUSÉE sans extrait (ou avec un extrait trop court pour être un passage)", () => {
  assert.ok(codes(good({ excerpt: undefined })).includes("NO_EXCERPT"));
  assert.ok(codes(good({ excerpt: "" })).includes("NO_EXCERPT"));
  assert.ok(codes(good({ excerpt: "   " })).includes("NO_EXCERPT"));
  assert.ok(codes(good({ excerpt: "ok, autorisé" })).includes("NO_EXCERPT"));
  assert.ok(codes(good({ authorization: "" })).includes("NO_AUTHORIZATION"));
  assert.ok(codes(good({ source: { url: "https://www.p.example/cgu", title: "" } })).includes("NO_TITLE"));
});

test("preuve REFUSÉE si sa date dépasse 180 jours (à l'ajout) ; conservée comme EXPIRÉE au chargement", () => {
  assert.ok(codes(good({ checkedAt: daysAgo(181) })).includes("TOO_OLD"));
  assert.equal(check(good({ checkedAt: daysAgo(181) })).record, undefined);
  const kept = check(good({ checkedAt: daysAgo(181) }), true);
  assert.equal(kept.expired, true);
  assert.ok(kept.record, "au chargement, la preuve ancienne reste dans l'historique");
  // frontière exacte : 180 jours = encore valide, 181 = expirée
  assert.equal(isExpired(daysAgo(180), NOW), false);
  assert.equal(isExpired(daysAgo(181), NOW), true);
  assert.deepEqual(codes(good({ checkedAt: daysAgo(180) })), []);
  assert.equal(expiresAt("2026-01-01"), "2026-06-30");
  assert.equal(EVIDENCE_MAX_AGE_DAYS, 180);
});

test("preuve REFUSÉE si le domaine ne correspond pas à la plateforme (sous-domaines officiels acceptés, sosies refusés)", () => {
  const withUrl = (url: string) => good({ source: { url, title: "t" } });
  assert.deepEqual(codes(withUrl("https://p.example/cgu")), []);
  assert.deepEqual(codes(withUrl("https://help.p.example/cgu")), [], "sous-domaine officiel");
  for (const bad of ["https://autre-site.example/cgu", "https://p.example.evil.example/cgu", "https://evilp.example/cgu", "https://p-example.com/cgu", "https://www.q.example/cgu", "https://evil.example/p.example"]) {
    assert.ok(codes(withUrl(bad)).includes("DOMAIN_MISMATCH"), bad);
  }
  assert.deepEqual(validateEvidence({ ...good(), platform: "q", source: { url: "https://docs.q.example/a", title: "t" } }, { platforms, now: NOW, allowExpired: false }).issues, []);
});

test("preuve REFUSÉE : plateforme inconnue, champ inconnu (faute de frappe), canal ou valeur invalides, JSON non objet", () => {
  assert.ok(codes(good({ platform: "inconnue" })).includes("UNKNOWN_PLATFORM"));
  assert.ok(codes(good({ platform: undefined })).includes("NO_PLATFORM"));
  assert.ok(codes(good({ chanel: "api" })).includes("UNKNOWN_FIELD"));
  assert.ok(codes(good({ channel: "tout" })).includes("BAD_CHANNEL"));
  assert.ok(codes(good({ channel: undefined })).includes("BAD_CHANNEL"));
  assert.ok(codes(good({ topic: "magie" })).includes("BAD_TOPIC"));
  assert.ok(codes(good({ topic: "queue", channel: undefined, value: "toujours" })).includes("BAD_VALUE"));
  assert.deepEqual(codes(good({ topic: "queue", channel: undefined, value: "lottery" })), []);
  for (const raw of [null, "texte", 42, [good()]]) assert.deepEqual(codes(raw), ["NOT_OBJECT"]);
});

// ───────────────────────────── chargement du dossier ─────────────────────────────
test("le dossier de preuves : valides chargées, invalides REFUSÉES et signalées, fichiers « _ » et non-JSON ignorés", () => {
  const dir = mkdtempSync(join(tmpdir(), "evid-"));
  const w = (name: string, data: unknown): void => writeFileSync(join(dir, name), typeof data === "string" ? data : JSON.stringify(data));
  w("p-ok.json", good());
  w("p-ancienne.json", good({ checkedAt: daysAgo(200) }));
  w("p-sans-extrait.json", good({ excerpt: "" }));
  w("p-http.json", good({ source: { url: "http://www.p.example/x", title: "t" } }));
  w("p-cassé.json", "{ pas du json");
  w("_modele.json", good());
  w("README.md", "# lisez-moi");
  const r = loadEvidence(dir, platforms, NOW);
  assert.deepEqual(r.records.map((x) => x.file).sort(), ["p-ancienne.json", "p-ok.json"]);
  assert.deepEqual(r.rejected.map((x) => x.file).sort(), ["p-cassé.json", "p-http.json", "p-sans-extrait.json"]);
  assert.equal(r.rejected.find((x) => x.file === "p-cassé.json")!.issues[0]!.code, "INVALID_JSON");
  assert.deepEqual(loadEvidence(join(dir, "absent"), platforms, NOW), { records: [], rejected: [] });
});

// ───────────────────────────── statuts, expiration, historique ─────────────────────────────
test("les six statuts, déduits UNIQUEMENT des preuves", () => {
  const status = (records = [] as ReturnType<typeof ev>[], now = NOW): PlatformStatus => stateOf(catalogWith([plat("p")], records), "p", now).status;
  assert.equal(status(), "NOT_VERIFIED");
  assert.equal(status([ev("p", "api")]), "API_ONLY");
  assert.equal(status([ev("p", "browser")]), "BROWSER_ONLY");
  assert.equal(status([ev("p", "both")]), "API_AND_BROWSER");
  assert.equal(status([ev("p", "prohibited")]), "NOT_ALLOWED");
  assert.equal(status([ev("p", "both", daysAgo(181))]), "EXPIRED");
  // des preuves documentaires seules ne vérifient rien
  assert.equal(status([fact("p", "api", "open-transactional"), fact("p", "queue", "none")]), "NOT_VERIFIED");
});

test("expiration AUTOMATIQUE après 180 jours : la même preuve autorise, puis n'autorise plus", () => {
  const cat = catalogWith([plat("p")], [ev("p", "both", TODAY)]);
  assert.equal(stateOf(cat, "p", NOW).status, "API_AND_BROWSER");
  assert.equal(stateOf(cat, "p", NOW + 180 * DAY).status, "API_AND_BROWSER", "dernier jour de validité");
  const later = stateOf(cat, "p", NOW + 181 * DAY);
  assert.equal(later.status, "EXPIRED");
  assert.deepEqual(later.channels, []);
  assert.match(later.reasons[0]!, /expiré/);
  assert.ok(later.missing.some((m) => m.blocking && /expirée/.test(m.reason)));
  assert.equal(stateOf(cat, "p", NOW).expiresAt, expiresAt(TODAY));
  assert.equal(stateOf(cat, "p", NOW).expiresInDays, 180);
});

test("preuves multiples : la plus restrictive l'emporte ; la nouvelle preuve remplace l'expirée ; échéance = la plus proche", () => {
  const s = (records: ReturnType<typeof ev>[]) => stateOf(catalogWith([plat("p")], records), "p", NOW);
  assert.equal(s([ev("p", "both"), ev("p", "api", daysAgo(3))]).status, "API_ONLY", "intersection both ∩ api");
  assert.ok(s([ev("p", "both"), ev("p", "api", daysAgo(3))]).conflicts.length > 0, "divergence signalée");
  assert.equal(s([ev("p", "api"), ev("p", "browser", daysAgo(3))]).status, "NOT_ALLOWED", "aucun canal commun");
  assert.equal(s([ev("p", "both", daysAgo(10)), ev("p", "prohibited", daysAgo(2))]).status, "NOT_ALLOWED", "une interdiction récente prime");
  assert.equal(s([ev("p", "browser", daysAgo(200)), ev("p", "browser", daysAgo(5))]).status, "BROWSER_ONLY", "le relevé récent remplace l'expiré");
  assert.equal(s([ev("p", "browser", daysAgo(170)), ev("p", "browser", daysAgo(5))]).expiresAt, expiresAt(daysAgo(170)), "échéance la plus proche");
});

test("historique des vérifications : date, URL, source, canal autorisé, expiration, note", () => {
  const st = stateOf(catalogWith([plat("p")], [ev("p", "browser", daysAgo(200), { note: "ancienne version des CGU" }), ev("p", "both", daysAgo(4), { note: "CGU 2026" }), fact("p", "limits", "documented", daysAgo(4))]), "p", NOW);
  assert.equal(st.history.length, 3);
  assert.deepEqual(st.history.map((h) => h.checkedAt), [daysAgo(4), daysAgo(4), daysAgo(200)], "du plus récent au plus ancien");
  const auto = st.history.find((h) => h.topic === "automation" && !h.expired)!;
  assert.deepEqual(
    { url: auto.url, source: auto.source, channel: auto.channel, expiresAt: auto.expiresAt, note: auto.note, expired: auto.expired },
    { url: "https://www.p.example/conditions", source: "Conditions d'utilisation (FICTIVES)", channel: "both", expiresAt: expiresAt(daysAgo(4)), note: "CGU 2026", expired: false },
  );
  const old = st.history.find((h) => h.expired)!;
  assert.equal(old.channel, "browser");
  assert.equal(old.note, "ancienne version des CGU");
  assert.deepEqual(st.facts.limits && { value: st.facts.limits.value, expired: st.facts.limits.expired }, { value: "documented", expired: false });
});

test("pièces manquantes : l'automatisation est BLOQUANTE, les autres sujets sont complémentaires", () => {
  const none = stateOf(catalogWith([plat("p")]), "p", NOW);
  assert.deepEqual(none.missing.map((m) => [m.topic, m.blocking]), [["automation", true], ["api", false], ["queue", false], ["limits", false], ["cart", false]]);
  const partial = stateOf(catalogWith([plat("p")], [ev("p", "browser"), fact("p", "queue", "lottery")]), "p", NOW);
  assert.deepEqual(partial.missing.map((m) => m.topic), ["api", "limits", "cart"]);
  assert.equal(partial.missing.every((m) => !m.blocking), true);
});

test("une preuve REFUSÉE ne compte jamais : la plateforme reste NOT_VERIFIED", () => {
  const dir = mkdtempSync(join(tmpdir(), "evid-"));
  writeFileSync(join(dir, "p-invalide.json"), JSON.stringify(good({ source: { url: "http://www.p.example/x", title: "t" } })));
  writeFileSync(join(dir, "p-hors-domaine.json"), JSON.stringify(good({ source: { url: "https://evil.example/x", title: "t" } })));
  const catalogFile = join(mkdtempSync(join(tmpdir(), "cat-")), "catalog.json");
  writeFileSync(catalogFile, JSON.stringify({ schemaVersion: 2, platforms: [plat("p")] }));
  const cat = loadCatalog({ path: catalogFile, evidenceDir: dir, now: NOW });
  assert.equal(cat.rejected.length, 2);
  assert.equal(stateOf(cat, "p", NOW).status, "NOT_VERIFIED");
});

test("dépôt réel : aucune preuve refusée, et toute plateforme sans fichier de preuve est NOT_VERIFIED", () => {
  const cat = loadCatalog();
  assert.deepEqual(cat.rejected, [], "un fichier de platforms/evidence/ est invalide (npm run platform check)");
  for (const p of cat.platforms) {
    if (cat.evidence.some((r) => r.platform === p.id && r.topic === "automation")) continue;
    assert.equal(stateOf(cat, p.id).status, "NOT_VERIFIED", `${p.id} n'a aucune preuve d'automatisation`);
  }
});
