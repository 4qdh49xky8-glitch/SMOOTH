import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stringify as yaml } from "yaml";
import { liveCommand } from "../src/cli/live.js";
import { saleWaitCommand, HANDOVER_LEAD_SECONDS, type SaleWaitDeps } from "../src/cli/sale.js";
import type { Catalog } from "../src/platforms/catalog.js";
import type { SaleAssessment } from "../src/sale/assess.js";
import { assessSale } from "../src/sale/assess.js";
import { lockKeysFor } from "../src/sale/lockKeys.js";
import { ConfigSchema } from "../src/config/schema.js";
import { acquireEventLock, combineLocks, eventKey, inspectLock, profileKey, LOCK_MAX_AGE_MS } from "../src/utils/lock.js";
import type { FakeAdapter } from "./helpers/fakeAdapter.js";
import { NOW, adapter, catalogWith, daysAgo, ev, plat } from "./helpers/platformFixtures.js";

/**
 * sale:wait ATOMIQUE vis-à-vis des autres instances : il prend les mêmes verrous que `run` après les vérifications initiales, les conserve
 * (et les renouvelle) pendant toute l'attente, s'arrête si un verrou est perdu, revérifie tout juste avant le premier contact, transmet les
 * verrous à `run` sans interruption, et les libère dans tous les cas. Aucun réseau pendant l'attente.
 */
const URL_ = "https://www.p.example/e/1";
const START = (ms: number): Record<string, unknown> => ({ startTime: new Date(NOW + ms).toISOString().slice(0, 19), timezone: "UTC" });
const profile = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  event: { platform: "p", eventUrl: URL_, name: "Événement générique" }, sale: START(2 * 3600_000), tickets: { quantity: 2, seatsTogether: true, strictTogether: false },
  budget: { maxPrice: 120 }, selection: { strategy: "priority" }, behavior: { autoAddToCart: true, autoPayment: false }, ...over,
});
const writeYaml = (obj: unknown): string => {
  const f = join(mkdtempSync(join(tmpdir(), "swl-")), "sale.yaml");
  writeFileSync(f, yaml(obj));
  return f;
};
const okCatalog = (): Catalog => catalogWith([plat("p")], [ev("p", "browser", daysAgo(3, NOW), { source: { url: "https://www.p.example/cgu", title: "CGU (FICTIVES)" } })]);
const web = (): FakeAdapter => adapter("p-web", { platform: "p", channel: "browser" });
const lockFiles = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith(".lock"));
function clock() {
  let t = NOW;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), get t() { return t; } };
}
interface Harness {
  out: string[];
  runs: { at: number; held?: { keys: string[] } }[];
  locksDir: string;
  catalog: Catalog;
  c: ReturnType<typeof clock>;
  deps: SaleWaitDeps;
}
function harness(over: Partial<SaleWaitDeps> = {}, o: { catalog?: Catalog; locksDir?: string } = {}): Harness {
  const c = clock();
  const out: string[] = [];
  const runs: Harness["runs"] = [];
  const catalog = o.catalog ?? okCatalog();
  const locksDir = o.locksDir ?? mkdtempSync(join(tmpdir(), "swl-locks-"));
  const deps: SaleWaitDeps = {
    now: c.now, sleep: c.sleep, print: (l) => void out.push(l),
    assessOptions: { adapters: [web()], catalog, env: {}, locksDir },
    run: async (_o, d) => (runs.push({ at: c.now(), held: d?.held }), 0),
    ...over,
  };
  return { out, runs, locksDir, catalog, c, deps };
}
const spyNetwork = <T>(fn: () => Promise<T>): Promise<{ result: T; fetched: number; external: number }> => {
  const real = globalThis.fetch;
  let fetched = 0;
  const g = globalThis as { __externalNetAttempts?: string[] };
  const before = (g.__externalNetAttempts ?? []).length;
  globalThis.fetch = (async () => (fetched++, new Response("x"))) as typeof fetch;
  return fn().then((result) => ({ result, fetched, external: (g.__externalNetAttempts ?? []).length - before })).finally(() => void (globalThis.fetch = real));
};
const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("condition non atteinte");
    await new Promise((r) => setTimeout(r, 10));
  }
};

// ───────────────────────────── 1-2, 7 : deux sale:wait simultanés ─────────────────────────────
test("deux sale:wait SIMULTANÉS sur le même événement : un seul obtient le verrou et atteint CART_SUCCESS, l'autre est refusé (aucun lancement)", async () => {
  const locksDir = mkdtempSync(join(tmpdir(), "swl-locks-"));
  const catalog = okCatalog();
  const file = writeYaml(profile({ sale: START(30_000) })); // dans la fenêtre de préparation : remise immédiate
  let gate!: () => void;
  const hold = new Promise<void>((r) => (gate = r));
  const a = harness({ run: async (_o, d) => (a.runs.push({ at: a.c.now(), held: d?.held }), await hold, 0) }, { catalog, locksDir });
  const b = harness({}, { catalog, locksDir });
  const pa = saleWaitCommand({ target: file }, a.deps);
  const pb = saleWaitCommand({ target: file }, b.deps);
  await until(() => a.runs.length === 1 || b.runs.length === 1 || /verrou|NOT_READY/i.test(a.out.join() + b.out.join()));
  await new Promise((r) => setTimeout(r, 50));
  gate();
  const codes = await Promise.all([pa, pb]);
  assert.deepEqual([...codes].sort(), [0, 1], "exactement un succès et un refus");
  assert.equal(a.runs.length + b.runs.length, 1, "UNE seule exécution");
  const all = [...a.out, ...b.out].join("\n");
  assert.equal([...all.matchAll(/CART_SUCCESS — panier obtenu/g)].length, 1, "une seule exécution atteint CART_SUCCESS");
  assert.match(all, /verrou (refusé|événement détenu)|détenu par « sale-wait#/i, "le second est refusé à cause du verrou");
  assert.deepEqual(lockFiles(locksDir), [], "verrous libérés à la fin");
});

test("le second sale:wait reste refusé TANT QUE le premier attend (verrou conservé pendant toute l'attente), puis redevient possible après sa fin", async () => {
  const locksDir = mkdtempSync(join(tmpdir(), "swl-locks-"));
  const catalog = okCatalog();
  const file = writeYaml(profile());
  let release!: () => void;
  const paused = new Promise<void>((r) => (release = r));
  let entered!: () => void;
  const inWait = new Promise<void>((r) => (entered = r));
  const a = harness({}, { catalog, locksDir });
  let n = 0;
  a.deps.sleep = async (ms) => {
    await a.c.sleep(ms);
    if (++n === 3) {
      entered();
      await paused; // le premier est EN ATTENTE, verrou tenu
    }
  };
  const pa = saleWaitCommand({ target: file, recheckSeconds: 300 }, a.deps);
  await inWait;
  assert.equal(lockFiles(locksDir).length, 2, "verrous événement + profil tenus pendant l'attente");
  for (let i = 0; i < 3; i++) {
    const b = harness({}, { catalog, locksDir });
    assert.equal(await saleWaitCommand({ target: file }, b.deps), 1, `tentative ${i + 1}`);
    assert.deepEqual(b.runs, []);
    assert.match(b.out.join("\n"), /Verrou : verrou événement détenu par « sale-wait#\d+ »/);
  }
  release();
  assert.equal(await pa, 0);
  assert.deepEqual(lockFiles(locksDir), []);
  const c = harness({}, { catalog, locksDir });
  assert.equal(await saleWaitCommand({ target: writeYaml(profile({ sale: START(30_000) })) }, c.deps), 0, "après la fin du premier, un nouveau sale:wait est possible");
});

// ───────────────────────────── 8-9 : libération du verrou ─────────────────────────────
test("le verrou est tenu PENDANT le lancement (transmis à run, sans interruption) puis libéré après CART_SUCCESS", async () => {
  const h = harness();
  const seen: { files: number; keys?: string[] } = { files: -1 };
  h.deps.run = async (_o, d) => {
    seen.files = lockFiles(h.locksDir).length;
    seen.keys = d?.held?.keys;
    assert.equal(d?.held?.lock.verify(), true);
    return 0;
  };
  assert.equal(await saleWaitCommand({ target: writeYaml(profile()), recheckSeconds: 600 }, h.deps), 0);
  assert.equal(seen.files, 2, "verrous événement + profil encore tenus au moment du lancement");
  assert.equal(seen.keys?.length, 2);
  assert.deepEqual(lockFiles(h.locksDir), [], "libérés après le succès");
  assert.match(h.out.join("\n"), /Verrou acquis \(événement \+ profil de navigateur\)/);
  assert.match(h.out.join("\n"), /CART_SUCCESS — panier obtenu[\s\S]*FINALISEZ LE PAIEMENT VOUS-MÊME/);
});

test("le verrou est libéré après une ERREUR du lancement (code ≠ 0 ou exception), après NOT_READY en cours d'attente et après interruption", async () => {
  const fail = harness();
  fail.deps.run = async () => 1;
  assert.equal(await saleWaitCommand({ target: writeYaml(profile({ sale: START(30_000) })) }, fail.deps), 1);
  assert.deepEqual(lockFiles(fail.locksDir), [], "code 1");
  assert.match(fail.out.join("\n"), /arrêt sans panier[\s\S]*Rien n'a été payé/);
  const boom = harness();
  boom.deps.run = async () => {
    throw new Error("exception dans le lancement");
  };
  await assert.rejects(saleWaitCommand({ target: writeYaml(profile({ sale: START(30_000) })) }, boom.deps), /exception dans le lancement/);
  assert.deepEqual(lockFiles(boom.locksDir), [], "exception");
  // interruption (SIGINT) pendant l'attente
  const intr = harness();
  let n = 0;
  intr.deps.sleep = async (ms) => {
    await intr.c.sleep(ms);
    if (++n === 2) process.emit("SIGINT");
  };
  assert.equal(await saleWaitCommand({ target: writeYaml(profile()), recheckSeconds: 300 }, intr.deps), 130);
  assert.deepEqual(intr.runs, []);
  assert.deepEqual(lockFiles(intr.locksDir), [], "SIGINT");
  assert.match(intr.out.join("\n"), /Interrompu : aucune requête envoyée ; verrous libérés/);
});

// ───────────────────────────── 3-5 : arrêts pendant l'attente, sans contact réseau ─────────────────────────────
test("verrou PERDU (supprimé, écrasé ou repris) pendant l'attente → arrêt immédiat avec erreur explicite, aucun contact réseau, aucun lancement", async () => {
  for (const how of ["supprimé", "écrasé", "repris"] as const) {
    const h = harness();
    let n = 0;
    h.deps.sleep = async (ms) => {
      await h.c.sleep(ms);
      if (++n === 2) {
        for (const f of lockFiles(h.locksDir)) {
          const path = join(h.locksDir, f);
          if (how === "supprimé") rmSync(path);
          else if (how === "écrasé") writeFileSync(path, "{}");
          else writeFileSync(path, JSON.stringify({ pid: process.pid, instance: "intrus#1", startedAt: new Date().toISOString() }));
        }
      }
    };
    const { result, fetched, external } = await spyNetwork(() => saleWaitCommand({ target: writeYaml(profile()), recheckSeconds: 300 }, h.deps));
    assert.equal(result, 1, how);
    assert.deepEqual(h.runs, [], how);
    assert.equal(n, 2, `${how} : arrêt dès la vérification qui suit`);
    assert.match(h.out.join("\n"), /ERREUR — le verrou d'événement n'est plus détenu par cette instance[\s\S]*arrêt immédiat, AUCUN contact/, how);
    assert.equal(fetched + external, 0, `${how} : zéro requête`);
  }
});

test("le verrou est RENOUVELÉ pendant l'attente (renewedAt avance) et n'est pas repris par une autre instance même après plus de 24 h ; sans renouvellement il serait périmé", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swl-locks-"));
  const key = eventKey("x", "https://h.example/e/renew");
  const l = acquireEventLock(key, "attente#1", dir);
  const file = join(dir, `${key}.lock`);
  const info = () => JSON.parse(readFileSync(file, "utf8")) as { startedAt: string; renewedAt?: string };
  const old = new Date(Date.now() - LOCK_MAX_AGE_MS - 3600_000).toISOString();
  writeFileSync(file, JSON.stringify({ ...info(), startedAt: old })); // verrou posé il y a plus de 24 h
  assert.equal(inspectLock(key, dir).state === "held" || inspectLock(key, dir).state === "stale", true);
  // sans renouvellement : périmé → une autre instance pourrait le reprendre (verify échoue aussi : startedAt a changé)
  assert.equal(l.verify(), false);
  rmSync(file);
  const l2 = acquireEventLock(key, "attente#2", dir);
  assert.equal(l2.renew(), true);
  const first = info().renewedAt!;
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(l2.renew(), true);
  assert.ok(info().renewedAt! > first, "la date de renouvellement avance");
  assert.equal(l2.verify(), true, "renouveler ne fait pas perdre le verrou");
  // péremption comptée depuis le renouvellement : détenteur VIVANT (processus parent) — ancien mais renouvelé → TENU ; ni démarré ni renouvelé depuis > 24 h → périmé
  const key2 = eventKey("x", "https://h.example/e/age");
  const file2 = join(dir, `${key2}.lock`);
  const other = (extra: Record<string, unknown>) => writeFileSync(file2, JSON.stringify({ pid: process.ppid, instance: "autre#1", startedAt: old, ...extra }));
  other({ renewedAt: new Date().toISOString() });
  assert.equal(inspectLock(key2, dir).state, "held");
  other({ renewedAt: old });
  assert.equal(inspectLock(key2, dir).state, "stale", "ni démarré ni renouvelé depuis plus de 24 h");
  other({});
  assert.equal(inspectLock(key2, dir).state, "stale", "sans renouvellement : périmé après 24 h");
  other({ renewedAt: new Date().toISOString() });
  assert.throws(() => acquireEventLock(key2, "intrus#1", dir), /même événement/, "un verrou renouvelé n'est pas repris");
  other({});
  acquireEventLock(key2, "reprise#1", dir).release(); // périmé : repris
  // un verrou perdu ne se « renouvelle » pas (rien n'est réécrit)
  rmSync(file);
  assert.equal(l2.renew(), false);
  assert.ok(!existsSync(file));
  // verrous combinés : un seul perdu → le renouvellement échoue
  const a = acquireEventLock(eventKey("x", "https://h.example/e/a"), "c#1", dir);
  const b = acquireEventLock(eventKey("x", "https://h.example/e/b"), "c#1", dir);
  const both = combineLocks(a, b);
  assert.equal(both.renew(), true);
  rmSync(b.file);
  assert.equal(both.renew(), false);
  both.release();
});

test("l'autorisation expire PENDANT l'attente → arrêt sans contact réseau, verrous libérés", async () => {
  const h = harness();
  let n = 0;
  h.deps.sleep = async (ms) => {
    await h.c.sleep(ms);
    if (++n === 3) {
      h.catalog.evidence.length = 0;
      h.catalog.evidence.push(ev("p", "browser", daysAgo(181, h.c.now()), { source: { url: "https://www.p.example/cgu", title: "t" } }));
    }
  };
  const { result, fetched, external } = await spyNetwork(() => saleWaitCommand({ target: writeYaml(profile()), recheckSeconds: 300 }, h.deps));
  assert.equal(result, 1);
  assert.deepEqual(h.runs, []);
  assert.equal(n, 3);
  assert.equal(fetched + external, 0);
  assert.match(h.out.join("\n"), /EXPIRED[\s\S]*plus READY pendant l'attente — arrêt AVANT tout contact/);
  assert.deepEqual(lockFiles(h.locksDir), []);
});

test("configuration MODIFIÉE pendant l'attente (budget effacé, hôte changé, canal élargi) → arrêt avant tout contact ; verrous libérés", async () => {
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["budget effacé", { budget: { maxPrice: null } }, /budget\.maxPrice : requis/],
    ["hôte hors domaines officiels", { event: { platform: "p", eventUrl: "https://evil.example/e/1", name: "N" } }, /hors des domaines autorisés/],
    ["canal API forcé (non autorisé)", { channel: "official-api" }, /indisponible/],
    ["autre plateforme", { event: { platform: "autre", eventUrl: URL_, name: "N" } }, /aucun adaptateur pour « autre »|Adaptateur/],
  ];
  for (const [label, change, re] of cases) {
    const h = harness();
    const file = writeYaml(profile());
    let n = 0;
    h.deps.sleep = async (ms) => {
      await h.c.sleep(ms);
      if (++n === 2) writeFileSync(file, yaml(profile(change)));
    };
    const { result, fetched, external } = await spyNetwork(() => saleWaitCommand({ target: file, recheckSeconds: 300 }, h.deps));
    assert.equal(result, 1, label);
    assert.deepEqual(h.runs, [], label);
    assert.match(h.out.join("\n"), re, label);
    assert.equal(fetched + external, 0, label);
    assert.deepEqual(lockFiles(h.locksDir), [], label);
  }
});

// ───────────────────────────── 6 : aucun réseau avant l'ouverture ─────────────────────────────
test("aucun appel réseau pendant TOUTE l'attente ni avant la remise ; le lancement n'a lieu qu'à l'instant calculé (ouverture − préparation − démarrage anticipé)", async () => {
  const h = harness();
  const netAtRun: number[] = [];
  const real = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => (fetched++, new Response("x"))) as typeof fetch;
  h.deps.run = async () => (netAtRun.push(fetched), h.runs.push({ at: h.c.now() }), 0);
  try {
    const file = writeYaml(profile({ sale: START(5 * 3600_000), advanced: { timing: { preArmSeconds: 120 } } }));
    assert.equal(await saleWaitCommand({ target: file, recheckSeconds: 900 }, h.deps), 0);
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(netAtRun, [0], "zéro requête avant le lancement");
  assert.equal(h.runs[0]!.at, NOW + 5 * 3600_000 - 120_000 - HANDOVER_LEAD_SECONDS * 1000, "remise à l'instant calculé, jamais avant");
  assert.ok(h.c.t < NOW + 5 * 3600_000, "le lancement précède l'ouverture (préparation), sans contact tant qu'il n'a pas eu lieu");
});

// ───────────────────────────── 10 : pas de reprise sans vérification complète ─────────────────────────────
test("aucune reprise sans nouvelle vérification COMPLÈTE : un changement survenu après la dernière vérification périodique est détecté juste avant le premier contact", async () => {
  const h = harness();
  const real = (await import("../src/sale/assess.js")).assessSale;
  const file = writeYaml(profile({ sale: START(2 * 3600_000) }));
  const handoverAt = NOW + 2 * 3600_000 - 90_000 - HANDOVER_LEAD_SECONDS * 1000;
  let finalChecks = 0;
  h.deps.assess = async (t, o): Promise<SaleAssessment> => {
    if ((o.now ?? 0) >= handoverAt) {
      finalChecks++;
      h.catalog.evidence.length = 0; // la preuve disparaît APRÈS la dernière vérification périodique
    }
    return real(t, o);
  };
  const { result, fetched, external } = await spyNetwork(() => saleWaitCommand({ target: file, recheckSeconds: 600 }, h.deps));
  assert.equal(result, 1);
  assert.ok(finalChecks >= 1, "la vérification complète a bien lieu au moment de la remise");
  assert.deepEqual(h.runs, []);
  assert.equal(fetched + external, 0);
  assert.match(h.out.join("\n"), /plus READY (au moment de la remise|pendant l'attente)/);
  assert.deepEqual(lockFiles(h.locksDir), []);
  // et après un arrêt, une nouvelle exécution repart de ZÉRO (évaluation complète initiale) : toujours refusée tant que rien n'est corrigé
  const again = harness({}, { catalog: catalogWith([plat("p")]) });
  assert.equal(await saleWaitCommand({ target: file }, again.deps), 1);
  assert.deepEqual(again.runs, []);
  assert.match(again.out.join("\n"), /NOT_READY[\s\S]*Lancement automatique REFUSÉ/);
});

test("run refuse des verrous transmis qui ne correspondent pas à l'événement/profil réellement lancé (configuration changée entre-temps) : rien n'est ouvert, le verrou est libéré", async () => {
  const w = web();
  const file = writeYaml(profile({ channel: "browser", advanced: { browser: { headless: true, userDataDir: join(mkdtempSync(join(tmpdir(), "swl-prof-")), "p") } } }));
  const cfgUrl = "https://www.p.example/e/1";
  const dir = mkdtempSync(join(tmpdir(), "swl-locks-"));
  const partial = acquireEventLock(eventKey(w.meta.id, cfgUrl), "attente#1", dir); // seulement l'événement : le verrou de profil manque
  await assert.rejects(
    liveCommand({ command: "run", target: file, trace: false, exitWhenDone: true }, { adapters: [w], catalog: okCatalog(), held: { lock: partial, keys: [eventKey(w.meta.id, cfgUrl)] } }),
    /verrous détenus ne correspondent plus/,
  );
  assert.deepEqual(w.calls, [], "adaptateur jamais appelé");
  assert.deepEqual(lockFiles(dir), [], "verrou libéré");
  // et des clés d'un AUTRE événement sont refusées aussi
  const other = acquireEventLock(eventKey(w.meta.id, "https://www.p.example/e/AUTRE"), "attente#2", dir);
  await assert.rejects(liveCommand({ command: "run", target: file, trace: false, exitWhenDone: true }, { adapters: [w], catalog: okCatalog(), held: { lock: other, keys: [eventKey(w.meta.id, "https://www.p.example/e/AUTRE")] } }), /ne correspondent plus/);
  assert.deepEqual(w.calls, []);
  void lockKeysFor;
  void ConfigSchema;
  void profileKey;
});

test("les verrous de sale:wait sont EXACTEMENT ceux de run (mêmes clés : événement + profil de navigateur) et sale:check les lit sans les prendre", async () => {
  const h = harness();
  const file = writeYaml(profile());
  const res = await assessSale(file, { ...h.deps.assessOptions, now: NOW });
  const w = web();
  const cfg = res.config!;
  const expected = lockKeysFor(w, cfg, "browser", "sale");
  assert.deepEqual(res.lockKeys?.map((k) => k.key), expected.map((k) => k.key));
  assert.deepEqual(expected.map((k) => k.what), ["événement", "profil de navigateur"]);
  assert.deepEqual(lockFiles(h.locksDir), [], "l'évaluation ne prend aucun verrou");
});

// ───────────────────────────── deux VRAIS processus ─────────────────────────────
test("deux processus `sale wait` réels : un seul tient le verrou (aucune requête, aucune connexion) ; le second est refusé ; SIGINT libère le verrou", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swl-proc-"));
  const file = join(dir, "sale.yaml");
  const port = 40000 + Math.floor(Math.random() * 10000);
  writeFileSync(file, yaml({
    event: { platform: "example", eventUrl: `http://127.0.0.1:${port}/event-${process.pid}`, name: "Événement générique (fixture)" },
    sale: { startTime: new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 19), timezone: "UTC" },
    tickets: { quantity: 2 }, budget: { maxPrice: 150 }, selection: { strategy: "priority" },
    advanced: { browser: { headless: true, userDataDir: join(dir, "profil") }, telemetry: { enabled: false } },
  }));
  const children: ChildProcess[] = [];
  const launch = (): { proc: ChildProcess; out: () => string; done: Promise<number | null> } => {
    const proc = spawn(process.execPath, ["--import", "tsx", "--import", "./tests/setup/noNetwork.ts", "src/index.ts", "sale", "wait", "--config", file], {
      env: { ...process.env, NET_AUDIT: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(proc);
    let buf = "";
    proc.stdout!.on("data", (d: Buffer) => (buf += String(d)));
    proc.stderr!.on("data", (d: Buffer) => (buf += String(d)));
    return { proc, out: () => buf, done: new Promise((res) => proc.on("exit", (c) => res(c))) };
  };
  try {
    const first = launch();
    await until(() => /Verrou acquis/.test(first.out()), 30_000);
    const second = launch();
    const code2 = await second.done;
    assert.equal(code2, 1, second.out());
    assert.match(second.out(), /NOT_READY[\s\S]*Verrou : verrou événement détenu par « sale-wait#\d+ »|verrou refusé/);
    assert.ok(!/remise au lancement/.test(second.out()), "le second n'atteint jamais le lancement");
    first.proc.kill("SIGINT");
    const code1 = await first.done;
    assert.equal(code1, 130, first.out());
    assert.match(first.out(), /Interrompu : aucune requête envoyée ; verrous libérés/);
    assert.match(first.out(), /NET_AUDIT external=0 loopback=0 fetch=0/, "aucune connexion, aucun fetch pendant l'attente");
    assert.match(second.out(), /NET_AUDIT external=0 loopback=0 fetch=0/);
    // le verrou a été libéré : un nouveau sale wait peut le reprendre
    const third = launch();
    await until(() => /Verrou acquis/.test(third.out()), 30_000);
    third.proc.kill("SIGINT");
    assert.equal(await third.done, 130);
  } finally {
    children.forEach((c) => c.kill("SIGKILL"));
  }
});
