import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { LOCK_MAX_AGE_MS, acquireEventLock, eventKey } from "../src/utils/lock.js";

/**
 * AUDIT des verrous : un seul bot par événement (quel que soit le profil), récupération sûre après crash, événements
 * différents indépendants. Ce n'est PAS un mécanisme de concurrence : il sert uniquement à REFUSER les doublons.
 */
const LOCK_URL = pathToFileURL(resolve("src/utils/lock.ts")).href;
const children: ChildProcess[] = [];
test.after(() => children.forEach((c) => c.kill("SIGKILL")));

/** Processus séparé qui tente d'acquérir le verrou, affiche ACQUIRED/REFUSED, puis le garde `holdMs`. */
function contender(dir: string, key: string, name: string, holdMs: number): { proc: ChildProcess; result: Promise<string> } {
  const code = `import(${JSON.stringify(LOCK_URL)}).then(({acquireEventLock})=>{try{acquireEventLock(${JSON.stringify(key)},${JSON.stringify(name)},${JSON.stringify(dir)});console.log("ACQUIRED");setTimeout(()=>process.exit(0),${holdMs});}catch(e){console.log("REFUSED "+e.message);process.exit(3);}})`;
  const proc = spawn(process.execPath, ["--import", "tsx", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  children.push(proc);
  const result = new Promise<string>((res) => {
    let out = "";
    proc.stdout!.on("data", (d: Buffer) => {
      out += String(d);
      if (out.includes("\n")) res(out.trim());
    });
    proc.on("exit", () => res(out.trim() || "EXIT"));
  });
  return { proc, result };
}

const dirOf = (): string => mkdtempSync(join(tmpdir(), "locks-audit-"));
const EVENT = "https://billets.example/evenement/42";

test("deux PROCESSUS sur le même événement : un seul l'obtient, l'autre est refusé ; parent et enfant se voient", async () => {
  const dir = dirOf();
  const key = eventKey("site", EVENT);
  const a = contender(dir, key, "profil-a#1", 4000);
  assert.equal(await a.result, "ACQUIRED");
  assert.throws(() => acquireEventLock(key, "parent#2", dir), /même événement/, "le parent est refusé tant que l'enfant vit");
  const b = contender(dir, key, "profil-b#3", 500);
  assert.match(await b.result, /^REFUSED .*même événement/);
  a.proc.kill("SIGKILL");
});

test("course entre quatre processus lancés ensemble sur le même événement : exactement UN gagnant", async () => {
  const dir = dirOf();
  const key = eventKey("site", EVENT);
  const runs = [1, 2, 3, 4].map((n) => contender(dir, key, `p${n}`, 1500));
  const out = await Promise.all(runs.map((r) => r.result));
  assert.equal(out.filter((o) => o === "ACQUIRED").length, 1, out.join(" | "));
  assert.equal(out.filter((o) => o.startsWith("REFUSED")).length, 3, out.join(" | "));
  runs.forEach((r) => r.proc.kill("SIGKILL"));
});

test("crash (SIGKILL) avec verrou restant : le fichier reste, mais le verrou orphelin est récupéré au lancement suivant — sans intervention", async () => {
  const dir = dirOf();
  const key = eventKey("site", EVENT);
  const crashed = contender(dir, key, "planté#1", 60_000);
  assert.equal(await crashed.result, "ACQUIRED");
  crashed.proc.kill("SIGKILL");
  await new Promise((r) => crashed.proc.on("exit", r));
  const file = join(dir, `${key}.lock`);
  assert.ok(existsSync(file), "un crash brutal laisse bien le fichier de verrou");
  const info = JSON.parse(readFileSync(file, "utf8")) as { pid: number };
  assert.equal(info.pid, crashed.proc.pid);
  const lock = acquireEventLock(key, "reprise#2", dir); // pas de throw : PID mort → orphelin
  assert.equal(JSON.parse(readFileSync(file, "utf8")).instance, "reprise#2");
  lock.release();
  assert.ok(!existsSync(file), "libéré proprement");
});

test("verrou PÉRIMÉ : PID encore vivant mais verrou de plus de 24 h (PID réutilisé après crash/redémarrage) → récupéré ; verrou récent d'un processus vivant → refusé", async () => {
  const dir = dirOf();
  const key = eventKey("site", EVENT);
  const holder = contender(dir, eventKey("autre", EVENT), "vivant", 6000); // un vrai PID vivant, sans rapport
  await holder.result;
  const file = join(dir, `${key}.lock`);
  const write = (ageMs: number): void => writeFileSync(file, JSON.stringify({ pid: holder.proc.pid, instance: "ancien#9", startedAt: new Date(Date.now() - ageMs).toISOString() }));
  write(60_000);
  assert.throws(() => acquireEventLock(key, "neuf#1", dir), /même événement/, "récent + vivant : refusé");
  write(LOCK_MAX_AGE_MS - 60_000);
  assert.throws(() => acquireEventLock(key, "neuf#2", dir), /même événement/, "juste sous 24 h : refusé");
  write(LOCK_MAX_AGE_MS + 60_000);
  acquireEventLock(key, "neuf#3", dir).release(); // périmé : récupéré
  assert.equal(LOCK_MAX_AGE_MS, 24 * 3600_000);
  holder.proc.kill("SIGKILL");
});

test("verrou illisible (fichier tronqué, JSON invalide, vide) : considéré orphelin et récupéré ; un verrou d'un autre PID n'est jamais supprimé par le mauvais propriétaire", () => {
  const dir = dirOf();
  const key = eventKey("site", EVENT);
  const file = join(dir, `${key}.lock`);
  for (const junk of ["", "{ pas du json", "null", "[]", "{\"pid\":\"abc\"}"]) {
    writeFileSync(file, junk);
    const l = acquireEventLock(key, "x#1", dir);
    l.release();
    assert.ok(!existsSync(file), `junk : ${JSON.stringify(junk)}`);
  }
  // Reprise par un autre processus : l'ancien propriétaire qui « libère » ensuite ne supprime PAS le verrou du nouveau.
  const mine = acquireEventLock(key, "mien#1", dir);
  writeFileSync(file, JSON.stringify({ pid: process.pid + 1, instance: "autre#2", startedAt: new Date().toISOString() }));
  mine.release();
  assert.ok(existsSync(file), "le verrou d'un autre propriétaire reste en place");
});

test("événements différents : indépendants (même site, autre événement ; autre site, même URL) ; le même événement est refusé quel que soit le PROFIL", async () => {
  const dir = dirOf();
  const a = acquireEventLock(eventKey("site", "https://billets.example/evenement/1"), "concert#1", dir);
  const b = acquireEventLock(eventKey("site", "https://billets.example/evenement/2"), "festival#2", dir);
  const c = acquireEventLock(eventKey("autre-site", "https://billets.example/evenement/1"), "sport#3", dir);
  assert.equal(new Set([a.file, b.file, c.file]).size, 3);
  // Deux PROFILS (noms d'instance différents) sur le MÊME événement : refusé — il n'existe aucune option pour l'autoriser
  // (ce serait multiplier les sessions et les paniers, ce que la plateforme s'interdit).
  for (const profile of ["concert-bis#4", "autre-profil#5", "festival#6"]) {
    assert.throws(() => acquireEventLock(eventKey("site", "https://billets.example/evenement/1?profil=x#ancre"), profile, dir), /même événement/);
  }
  [a, b, c].forEach((l) => l.release());
  const code = readFileSync("src/utils/lock.ts", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.ok(!/process\.env|allowMultiple|allowSame|bypass|ignoreLock|skipLock/i.test(code), "aucun interrupteur (variable d'environnement, option) pour contourner le verrou");
});

test("clé d'événement : insensible aux paramètres et ancres, sensible à l'hôte, au chemin et à l'adaptateur", () => {
  const k = eventKey("s", "https://h.example/e/1");
  assert.equal(k, eventKey("s", "https://h.example/e/1?a=1&b=2#x"));
  assert.notEqual(k, eventKey("s", "https://h.example/e/2"));
  assert.notEqual(k, eventKey("s", "https://h2.example/e/1"));
  assert.notEqual(k, eventKey("t", "https://h.example/e/1"));
  assert.throws(() => eventKey("s", "pas une url"));
});
