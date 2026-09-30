import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { saleInstantCommand } from "../src/cli/instant.js";
import { liveCommand } from "../src/cli/live.js";
import { saleWaitCommand } from "../src/cli/sale.js";
import { main } from "../src/index.js";
import type { Catalog } from "../src/platforms/catalog.js";
import { stripComments, scanSource } from "../src/sites/contract.js";
import { ScriptedSaleAdapter } from "../testkit/scriptedSale.js";
import { offer } from "./helpers/fakeAdapter.js";
import { catalogWith, daysAgo, ev, plat } from "./helpers/platformFixtures.js";

/** sale:instant : enchaîne sale:wait (inchangé) puis InstantSaleRunner ; mêmes verrous, mêmes refus, aucun contournement. */
const GOOD = offer({ id: "good", category: "Cat A", pricePerTicket: 100, available: 2, seatsTogether: true });
const session = () => ({
  context: { route: async () => undefined, unroute: async () => undefined } as never,
  page: { bringToFront: async () => undefined } as never,
  detach: async () => undefined,
  shutdown: async () => undefined,
});
const setup = (opts: { nonDemo?: boolean; catalog?: Catalog; onAdd?: (n: number, locks: string[]) => void; open?: boolean } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "inst-cmd-"));
  const locksDir = join(dir, "locks");
  const t0 = Date.now() + 1500;
  const holder: { locksDuringRun?: string[]; controllers?: { wait: number; run: string } } = {};
  const adapter = new ScriptedSaleAdapter({
    t0,
    frame: () => ({ open: opts.open ?? true, offers: [GOOD] }),
    onAdd: (n) => (opts.onAdd?.(n, (() => { try { return readdirSync(locksDir).filter((f) => f.endsWith(".lock")); } catch { return []; } })()), "ok"),
  });
  if (opts.nonDemo) adapter.meta = { ...adapter.meta, id: "scripted-web", platform: "p", channel: "browser", testOnly: undefined, compliance: { policy: "permitted-by-terms", termsUrl: "https://www.p.example/cgu", reviewedAt: new Date().toISOString().slice(0, 10) } };
  const file = join(dir, "sale.json");
  writeFileSync(file, JSON.stringify({
    site: adapter.authorization.platform, event: { name: "Événement générique", url: opts.nonDemo ? "https://www.p.example/e/1" : "http://127.0.0.1:9/event" }, sale: { startTime: new Date(t0).toISOString() },
    tickets: { quantity: 2, maxPricePerTicket: 120, categories: ["Cat A"], seatsTogether: true }, timing: { preArmSeconds: 0.5, pollIntervalMs: 200, maxWaitAfterSaleSeconds: 6 },
    notifications: { desktop: false, sound: false }, telemetry: { enabled: false }, browser: { headless: true, userDataDir: join(dir, "profil") },
  }));
  const catalog = opts.catalog ?? catalogWith([plat("p")], [ev("p", "browser", daysAgo(3, Date.now()), { source: { url: "https://www.p.example/cgu", title: "CGU (FICTIVES)" } })]);
  const out: string[] = [];
  const deps = {
    wait: { print: (l: string) => void out.push(l), assessOptions: { adapters: [adapter], catalog, env: {}, locksDir } },
    runner: { session: session(), locksDir },
    live: { adapters: [adapter], catalog },
  };
  return { dir, locksDir, file, adapter, catalog, out, deps, holder };
};
const lockFiles = (d: string): string[] => { try { return readdirSync(d).filter((f) => f.endsWith(".lock")); } catch { return []; } };

test("sale:instant nominal : évaluation complète → verrous pris et CONSERVÉS → préparation → chemin critique → CART_SUCCESS → verrous libérés, paiement manuel", async () => {
  let seen: string[] = [];
  const t = setup({ onAdd: (_n, locks) => void (seen = locks) });
  const code = await saleInstantCommand({ target: t.file, recheckSeconds: 1 }, t.deps);
  const text = t.out.join("\n");
  assert.equal(code, 0, text);
  assert.match(text, /^SALE CHECK/m);
  assert.match(text, /Verrou acquis \(événement \+ profil de navigateur\) : conservé pendant toute l'attente/);
  assert.match(text, /SALE WAIT : remise au lancement/);
  assert.match(text, /\] SALE_READY[\s\S]*\[T0\] SALE_OPEN[\s\S]*\] AVAILABILITY[\s\S]*\] CART_REQUEST[\s\S]*\] CART_SUCCESS[\s\S]*STATUS: CART_SUCCESS/);
  assert.match(text, /Payment remains manual\./);
  assert.match(text, /FINALISEZ LE PAIEMENT VOUS-MÊME/);
  assert.equal(seen.length, 2, "les deux verrous (événement + profil) sont tenus PENDANT l'exécution, sans interruption depuis l'attente");
  assert.deepEqual(lockFiles(t.locksDir), [], "libérés à la fin");
  assert.equal(t.adapter.count("addToCart"), 1);
});

test("jamais deux contrôleurs : pendant qu'un sale:instant s'exécute, sale:wait, run, check/login (mêmes verrous) et un second sale:instant sont refusés", async () => {
  const results: Record<string, unknown> = {};
  const t = setup();
  let during: Promise<void> | undefined;
  // le crochet ci-dessous s'exécute PENDANT addToCart du premier contrôleur (verrous tenus)
  // `whileAdding` est attendu par addToCart : les tentatives concurrentes se terminent TOUTES avant que le contrôleur ne rende ses verrous
  // (sinon la course entre ce crochet et la fin normale du contrôleur rendait le test aléatoire).
  t.adapter.o.whileAdding = async () => {
    await (during = (async () => {
      // un sale:wait concurrent sur le MÊME événement/profil (même dossier de verrous) : refusé
      const dup = await saleWaitCommand({ target: t.file }, { print: () => undefined, assessOptions: { adapters: [t.adapter], catalog: t.catalog, env: {}, locksDir: t.locksDir }, run: async () => 0 });
      results.wait = dup;
      // un second sale:instant : refusé
      const out2: string[] = [];
      results.instant = await saleInstantCommand({ target: t.file }, { wait: { print: (l) => void out2.push(l), assessOptions: { adapters: [t.adapter], catalog: t.catalog, env: {}, locksDir: t.locksDir } }, runner: { session: session(), locksDir: t.locksDir }, live: { adapters: [t.adapter], catalog: t.catalog } });
      results.instantOut = out2.join("\n");
      // `run` (liveCommand) avec ces verrous : refusé avant d'ouvrir quoi que ce soit — même clé de verrou
      const { acquireEventLock } = await import("../src/utils/lock.js");
      const { lockKeysFor } = await import("../src/sale/lockKeys.js");
      const { loadConfig } = await import("../src/config/load.js");
      const keys = lockKeysFor(t.adapter, loadConfig(t.file), "browser", "sale");
      results.run = (() => { try { acquireEventLock(keys[0]!.key, "run#1", t.locksDir); return "acquis"; } catch (e) { return (e as Error).message; } })();
      results.profile = (() => { try { acquireEventLock(keys[1]!.key, "login#1", t.locksDir); return "acquis"; } catch (e) { return (e as Error).message; } })();
    })());
  };
  const code = await saleInstantCommand({ target: t.file, recheckSeconds: 1 }, t.deps);
  await during;
  assert.equal(code, 0);
  assert.equal(results.wait, 1, "sale:wait concurrent refusé");
  assert.equal(results.instant, 1, "second sale:instant refusé");
  assert.match(String(results.instantOut), /Verrou : verrou événement détenu par « sale-wait#\d+ »|verrou refusé/);
  assert.match(String(results.run), /même événement ou le même profil/, "run / check / login : même verrou d'événement");
  assert.match(String(results.profile), /même événement ou le même profil/, "même verrou de profil de navigateur");
  assert.deepEqual(lockFiles(t.locksDir), []);
});

test("sale:instant refuse de démarrer sans autorisation : NOT_VERIFIED, HUMAN_ONLY, NOT_ALLOWED, EXPIRED — aucune attente, aucun verrou, aucun navigateur, aucun appel", async () => {
  const cases: [string, Catalog][] = [
    ["NOT_VERIFIED", catalogWith([plat("p")])],
    ["HUMAN_ONLY", catalogWith([plat("p")], [ev("p", "human", daysAgo(3, Date.now()))])],
    ["NOT_ALLOWED", catalogWith([plat("p")], [ev("p", "prohibited", daysAgo(3, Date.now()))])],
    ["EXPIRED", catalogWith([plat("p")], [ev("p", "both", daysAgo(181, Date.now()))])],
  ];
  for (const [label, catalog] of cases) {
    const t = setup({ nonDemo: true, catalog });
    const sessionSpy: string[] = [];
    t.deps.runner.session = { ...session(), context: { route: async () => void sessionSpy.push("route"), unroute: async () => undefined } as never };
    const code = await saleInstantCommand({ target: t.file }, t.deps);
    assert.equal(code, 1, label);
    assert.match(t.out.join("\n"), /NOT_READY[\s\S]*Lancement automatique REFUSÉ/, label);
    assert.deepEqual(t.adapter.ops, [], label);
    assert.deepEqual(sessionSpy, [], label);
    assert.deepEqual(lockFiles(t.locksDir), [], label);
  }
});

test("sale:instant : pas de mode humain, pas de --force ni d'option de contournement (options inconnues refusées)", async () => {
  const t = setup();
  assert.equal(await saleInstantCommand({ target: t.file, human: true }, t.deps), 1);
  assert.match(t.out.join("\n"), /le mode humain n'a rien à automatiser/);
  assert.deepEqual(t.adapter.ops, []);
  for (const flag of ["--force", "--skip-checks", "--no-lock", "--allow-unverified", "--ignore-queue", "--aggressive", "--fast"]) {
    await assert.rejects(main(["sale", "instant", "--config", t.file, flag]), /Unknown option|unknown/i, flag);
  }
  assert.deepEqual(t.adapter.ops, []);
  const src = stripComments(readFileSync("src/cli/instant.ts", "utf8") + readFileSync("src/instant/runner.ts", "utf8") + readFileSync("src/instant/monitor.ts", "utf8"));
  assert.ok(!/\bforce\b|skipCheck|noLock|allowUnverified|bypass|ignoreQueue/i.test(src.replace(/forceHuman/g, "")), "aucune option de contournement dans le code");
  assert.deepEqual(scanSource(src), [], "aucun motif interdit (CAPTCHA, furtivité, proxy, paiement…)");
});

// ───────────────────────────── le cœur gelé n'a pas bougé ─────────────────────────────
test("le COEUR GELÉ est inchangé : empreintes SHA-256 des fichiers gelés (autorisation, sélection, sale:check/wait, verrous, garde-fous réseau, blocages, paiement)", () => {
  const frozen = JSON.parse(readFileSync("tests/frozen-core.sha256.json", "utf8")) as Record<string, string>;
  assert.ok(Object.keys(frozen).length >= 25);
  for (const f of ["src/platforms/catalog.ts", "src/agent/Agent.ts", "src/agent/matcher.ts", "src/cli/sale.ts", "src/utils/lock.ts", "src/browser/guards.ts", "src/selectors/blockers.ts", "src/api/ApiClient.ts", "src/sale/assess.ts"]) assert.ok(frozen[f], `${f} doit figurer dans la liste des fichiers gelés`);
  for (const [file, hash] of Object.entries(frozen)) assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), hash, `${file} est GELÉ : toute modification exige l'accord explicite de l'utilisateur (puis la mise à jour de cette empreinte)`);
});

test("ordre des garde-fous du runner = celui de run : canal → autorisation → conformité → hôtes → verrous → navigateur → garde réseau → préparation → Agent ; aucun réseau avant", () => {
  const src = stripComments(readFileSync("src/instant/runner.ts", "utf8"));
  const order = ["resolveChannel(", "assertAuthorized(adapter.meta", "assertCompliant(adapter.meta", "assertNetworkAllowed(adapter", "acquireEventLock(k, instance", "await openBrowser(", "await installNetworkGuards(", "new Agent("].map((m) => [m, src.indexOf(m)] as const);
  for (const [m, i] of order) assert.ok(i >= 0, `absent : ${m}`);
  assert.deepEqual([...order].sort((a, b) => a[1] - b[1]).map((o) => o[0]), order.map((o) => o[0]));
  // le runner ne contacte jamais le réseau lui-même
  assert.ok(!/\bfetch\(|node:https?|\.goto\(|WebSocket|axios/.test(src), "aucun accès réseau direct dans le runner");
  assert.ok(!/src\/agent\/Agent|\bAgent\.prototype|Object\.assign\(agent|agent\.[a-zA-Z]+\s*=/.test(src), "le cœur n'est ni patché ni surchargé");
});
