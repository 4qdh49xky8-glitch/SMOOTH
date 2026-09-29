import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { platformCommand, evidenceTemplate } from "../src/cli/platform.js";
import { validateEvidence } from "../src/platforms/evidence.js";
import { NOW, TODAY, catalogWith, daysAgo, ev, fact, plat } from "./helpers/platformFixtures.js";

/** Exécute une sous-commande en capturant la sortie ET en prouvant qu'aucune requête réseau n'est faite. */
async function run(args: Parameters<typeof platformCommand>[0]): Promise<{ code: number; out: string; network: number }> {
  const lines: string[] = [];
  const log = console.log;
  const err = console.error;
  const realFetch = globalThis.fetch;
  let network = 0;
  globalThis.fetch = (async () => void network++) as never;
  console.log = (m?: unknown) => void lines.push(String(m));
  console.error = (m?: unknown) => void lines.push(String(m));
  try {
    const code = await platformCommand({ now: NOW, ...args });
    return { code, out: lines.join("\n"), network };
  } finally {
    console.log = log;
    console.error = err;
    globalThis.fetch = realFetch;
  }
}
const dir = (): string => mkdtempSync(join(tmpdir(), "pcli-"));
const write = (d: string, name: string, data: unknown): string => {
  const f = join(d, name);
  writeFileSync(f, JSON.stringify(data));
  return f;
};
const valid = (over: Record<string, unknown> = {}) => ({
  platform: "p", checkedAt: TODAY, source: { url: "https://www.p.example/cgu", title: "CGU (FICTIVES)" }, channel: "browser",
  authorization: "Texte FICTIF de test : l'automatisation est autorisée.", excerpt: "Passage FICTIF de test, cité tel quel depuis la page officielle fictive.", ...over,
});

test("platform verify <id> : affiche EXACTEMENT les preuves nécessaires et les informations manquantes, sans aucune requête réseau", async () => {
  const cat = catalogWith([plat("p", { clues: [{ url: "https://www.p.example/api", note: "piste non lue", verified: false, origin: "résumé" }] })]);
  const r = await run({ sub: "verify", target: "p", json: false, catalog: cat });
  assert.equal(r.code, 0);
  assert.equal(r.network, 0, "aucune requête réseau");
  assert.match(r.out, /Statut : NOT_VERIFIED/);
  assert.match(r.out, /BLOQUANT\s+automation/);
  for (const t of ["api", "queue", "limits", "cart"]) assert.match(r.out, new RegExp(`complémentaire\\s+${t} `));
  assert.match(r.out, /Domaines officiels acceptés pour la source : p\.example/);
  assert.match(r.out, /platforms\/evidence\/p-AAAA-MM-JJ/);
  assert.match(r.out, /channel/);
  assert.match(r.out, /piste non lue/);
  assert.match(r.out, /aucune requête réseau/);
  // liste globale
  const all = await run({ sub: "verify", json: false, catalog: cat });
  assert.match(all.out, /p\s+NOT_VERIFIED\s+—\s+1 bloquante\(s\), 4 complémentaire\(s\)/);
  assert.equal((await run({ sub: "verify", target: "inconnue", json: false, catalog: cat })).code, 1);
});

test("platform verify : plateforme vérifiée (échéance), proche de l'expiration, expirée, preuves contradictoires", async () => {
  const cat = catalogWith([plat("ok"), plat("bientot"), plat("vieille"), plat("conflit")], [
    ev("ok", "both", daysAgo(10)), fact("ok", "queue", "none", daysAgo(10)),
    ev("bientot", "browser", daysAgo(160)),
    ev("vieille", "api", daysAgo(200)),
    ev("conflit", "both", daysAgo(9)), ev("conflit", "api", daysAgo(3)),
  ]);
  const ok = (await run({ sub: "verify", target: "ok", json: false, catalog: cat })).out;
  assert.match(ok, /Statut : VERIFIED_API_AND_BROWSER/);
  assert.match(ok, /Expire le \d{4}-\d{2}-\d{2} \(dans 170 j\)/);
  assert.ok(!ok.includes("BLOQUANT"), "l'automatisation est prouvée : plus rien de bloquant");
  assert.doesNotMatch(ok, /complémentaire\s+queue /, "la file d'attente est déjà documentée");
  assert.match((await run({ sub: "verify", target: "bientot", json: false, catalog: cat })).out, /dans 20 j\) ⚠ à revérifier bientôt/);
  const old = (await run({ sub: "verify", target: "vieille", json: false, catalog: cat })).out;
  assert.match(old, /Statut : EXPIRED/);
  assert.match(old, /BLOQUANT\s+automation.*expirée le .* à revérifier/);
  assert.match((await run({ sub: "verify", target: "conflit", json: false, catalog: cat })).out, /preuves divergentes/);
  const json = JSON.parse((await run({ sub: "verify", target: "vieille", json: true, catalog: cat })).out);
  assert.equal(json.platforms[0].status, "EXPIRED");
  assert.equal(json.network, "aucune requête effectuée");
});

test("platform template : modèle volontairement INVALIDE tant que les champs ne sont pas renseignés depuis la page officielle", async () => {
  const cat = catalogWith([plat("p")]);
  for (const topic of ["automation", "api", "queue", "limits", "cart"]) {
    const r = await run({ sub: "template", target: "p", topic, json: false, catalog: cat });
    assert.equal(r.code, 0);
    const tpl = JSON.parse(r.out) as Record<string, unknown>;
    assert.equal(tpl.platform, "p");
    const v = validateEvidence(tpl, { platforms: cat.platforms, now: NOW, allowExpired: false });
    assert.ok(v.issues.length > 0, `le modèle ${topic} ne doit pas être valide tel quel`);
    assert.ok(v.issues.some((i) => ["NO_DATE", "NO_HTTPS_URL", "NO_EXCERPT", "BAD_CHANNEL", "BAD_VALUE"].includes(i.code)));
  }
  assert.deepEqual(evidenceTemplate("p").channel, "api | browser | both | human");
  assert.equal((await run({ sub: "template", target: "inconnue", json: false, catalog: cat })).code, 1);
  assert.equal((await run({ sub: "template", target: "p", topic: "magie", json: false, catalog: cat })).code, 1);
});

test("platform check : accepte les preuves valides, signale l'expirée, REFUSE l'invalide (code de sortie 1)", async () => {
  const cat = catalogWith([plat("p")]);
  const d = dir();
  write(d, "p-ok.json", valid());
  let r = await run({ sub: "check", json: false, catalog: cat, evidenceDir: d });
  assert.equal(r.code, 0);
  assert.match(r.out, /✓ p-ok\.json/);
  write(d, "p-vieille.json", valid({ checkedAt: daysAgo(190) }));
  write(d, "p-http.json", valid({ source: { url: "http://www.p.example/x", title: "t" } }));
  write(d, "p-domaine.json", valid({ source: { url: "https://evil.example/x", title: "t" } }));
  write(d, "p-vide.json", valid({ excerpt: "" }));
  r = await run({ sub: "check", json: false, catalog: cat, evidenceDir: d });
  assert.equal(r.code, 1);
  assert.match(r.out, /⚠ p-vieille\.json.*expirée/);
  assert.match(r.out, /✗ p-http\.json[\s\S]*NO_HTTPS_URL/);
  assert.match(r.out, /✗ p-domaine\.json[\s\S]*DOMAIN_MISMATCH/);
  assert.match(r.out, /✗ p-vide\.json[\s\S]*NO_EXCERPT/);
  assert.match(r.out, /2\/5 preuve\(s\) acceptée\(s\)|2\/5/);
  assert.equal(r.network, 0);
  // un fichier précis
  const single = await run({ sub: "check", target: join(d, "p-http.json"), json: false, catalog: cat, evidenceDir: d });
  assert.equal(single.code, 1);
  // dossier vide : normal
  assert.equal((await run({ sub: "check", json: false, catalog: cat, evidenceDir: dir() })).code, 0);
});

test("platform add : range une preuve valide (nom normalisé, statut recalculé) ; refuse invalide, trop ancienne ou doublon", async () => {
  const cat = catalogWith([plat("p")]);
  const d = dir();
  const src = write(dir(), "brouillon.json", valid({ channel: "both" }));
  const r = await run({ sub: "add", target: src, json: false, catalog: cat, evidenceDir: join(d, "evidence") });
  assert.equal(r.code, 0);
  assert.match(r.out, /Statut de p : VERIFIED_API_AND_BROWSER \(expire le /);
  assert.deepEqual(readdirSync(join(d, "evidence")), [`p-${TODAY}.json`]);
  assert.deepEqual(JSON.parse(readFileSync(join(d, "evidence", `p-${TODAY}.json`), "utf8")), valid({ channel: "both" }), "le contenu est copié tel quel, sans réécriture");
  // doublon
  const dup = await run({ sub: "add", target: src, json: false, catalog: cat, evidenceDir: join(d, "evidence") });
  assert.equal(dup.code, 1);
  assert.match(dup.out, /existe déjà/);
  // sujet documentaire : nom avec le sujet
  const q = write(dir(), "q.json", valid({ channel: undefined, topic: "queue", value: "lottery" }));
  assert.equal((await run({ sub: "add", target: q, json: false, catalog: cat, evidenceDir: join(d, "evidence") })).code, 0);
  assert.ok(existsSync(join(d, "evidence", `p-${TODAY}-queue.json`)));
  // refus : trop ancienne, sans https, hors domaine — RIEN n'est écrit
  const before = readdirSync(join(d, "evidence")).length;
  for (const bad of [valid({ checkedAt: daysAgo(181) }), valid({ source: { url: "http://www.p.example/x", title: "t" } }), valid({ source: { url: "https://evil.example/x", title: "t" } }), valid({ excerpt: "" })]) {
    const res = await run({ sub: "add", target: write(dir(), "x.json", bad), json: false, catalog: cat, evidenceDir: join(d, "evidence") });
    assert.equal(res.code, 1);
    assert.match(res.out, /REFUSÉE/);
  }
  assert.equal(readdirSync(join(d, "evidence")).length, before, "aucune preuve refusée n'est enregistrée");
  assert.match((await run({ sub: "add", target: write(dir(), "old.json", valid({ checkedAt: daysAgo(181) })), json: false, catalog: cat, evidenceDir: join(d, "evidence") })).out, /TOO_OLD/);
});

test("platform history : date, URL, source, canal, expiration, note", async () => {
  const cat = catalogWith([plat("p")], [ev("p", "browser", daysAgo(200), { note: "ancienne version" }), ev("p", "both", daysAgo(4), { note: "CGU 2026" })]);
  const r = await run({ sub: "history", target: "p", json: false, catalog: cat });
  assert.equal(r.code, 0);
  assert.match(r.out, new RegExp(`${daysAgo(4)}\\s+automation\\s+both\\s+valide\\s+jusqu'au`));
  assert.match(r.out, /https:\/\/www\.p\.example\/conditions/);
  assert.match(r.out, /Conditions d'utilisation \(FICTIVES\)/);
  assert.match(r.out, /note : CGU 2026/);
  assert.match(r.out, /EXPIRÉE/);
  const j = JSON.parse((await run({ sub: "history", target: "p", json: true, catalog: cat })).out);
  assert.equal(j.history.length, 2);
  assert.equal(j.status, "VERIFIED_API_AND_BROWSER");
  assert.equal((await run({ sub: "history", target: "inconnue", json: false, catalog: cat })).code, 1);
  assert.equal((await run({ sub: "nimporte", json: false, catalog: cat })).code, 1);
  assert.equal((await run({ json: false, catalog: cat })).code, 0, "sans sous-commande : aide");
});
