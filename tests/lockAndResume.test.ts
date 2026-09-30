import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { Agent } from "../src/agent/Agent.js";
import { ClaudeAssistant } from "../src/agent/claude.js";
import { ConfigSchema } from "../src/config/schema.js";
import { main } from "../src/index.js";
import type { Catalog } from "../src/platforms/catalog.js";
import { SelectorResolver } from "../src/selectors/resolver.js";
import type { SaleSnapshot } from "../src/sites/SiteAdapter.js";
import { Clock } from "../src/utils/clock.js";
import { BlockerError } from "../src/utils/errors.js";
import { acquireEventLock, combineLocks, eventKey, processStart, profileKey } from "../src/utils/lock.js";
import { silentLogger } from "../src/utils/logger.js";
import { FakeAdapter, offer } from "./helpers/fakeAdapter.js";
import { adapter, catalogWith, daysAgo, ev, plat } from "./helpers/platformFixtures.js";

/**
 * LOCKS et REPRISE. Le verrou ne sert qu'à REFUSER les doublons (un bot par événement ET par profil de navigateur, pour run, login
 * et check) ; il n'introduit aucune concurrence. La reprise après une main humaine revérifie dans l'ordre : autorisation,
 * canal/hôtes, verrou, état. La surveillance relit LOCALEMENT les preuves (aucune requête vers la plateforme).
 */
const LOCK_URL = pathToFileURL(resolve("src/utils/lock.ts")).href;
const children: ChildProcess[] = [];
test.after(() => children.forEach((c) => c.kill("SIGKILL")));

function holder(dir: string, key: string, name: string): Promise<ChildProcess> {
  const code = `import(${JSON.stringify(LOCK_URL)}).then(({acquireEventLock})=>{acquireEventLock(${JSON.stringify(key)},${JSON.stringify(name)},${JSON.stringify(dir)});console.log("ACQUIRED");setTimeout(()=>process.exit(0),60000);})`;
  const proc = spawn(process.execPath, ["--import", "tsx", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  children.push(proc);
  return new Promise((res, rej) => {
    proc.stdout!.on("data", (d: Buffer) => String(d).includes("ACQUIRED") && res(proc));
    proc.on("exit", () => rej(new Error("le détenteur s'est arrêté")));
  });
}

const OK_CAT = (): Catalog => catalogWith([plat("p")], [ev("p", "both", daysAgo(3))]);
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log;
  console.log = () => undefined;
  try {
    return await fn();
  } finally {
    console.log = log;
  }
};
const profiles = (): string[] => (existsSync(".profile") ? readdirSync(".profile") : []);
const cfgFile = (path: string, extra: Record<string, unknown> = {}): string => {
  const f = join(mkdtempSync(join(tmpdir(), "lockcfg-")), "lockcfg-test.json");
  writeFileSync(f, JSON.stringify({
    site: "p", channel: "browser", event: { name: "e", url: `https://api.p.example/events/${path}` }, sale: { startTime: new Date(Date.now() + 500).toISOString() },
    tickets: { quantity: 2, maxPricePerTicket: 150 }, notifications: { desktop: false, sound: false }, telemetry: { enabled: false }, browser: { headless: true }, ...extra,
  }));
  return f;
};

for (const command of ["run", "login", "check"] as const) {
  test(`${command} : un autre processus détient déjà l'ÉVÉNEMENT → refus AVANT d'ouvrir un navigateur ou de contacter le site`, async () => {
    const path = `lock-${command}-${Date.now()}`;
    const web = adapter("p-web", { platform: "p", channel: "browser" });
    const key = eventKey("p-web", `https://api.p.example/events/${path}`);
    const other = await holder(".locks", key, "autre-profil#1");
    try {
      const before = profiles();
      await assert.rejects(quiet(() => main([command, "--config", cfgFile(path), "--log-level", "error"], { adapters: [web], catalog: OK_CAT() })), /même événement/);
      assert.deepEqual(web.calls, []);
      assert.deepEqual(profiles(), before, "aucun navigateur/profil ouvert");
    } finally {
      other.kill("SIGKILL");
      rmSync(join(".locks", `${key}.lock`), { force: true });
    }
  });
}

test("un autre processus détient le PROFIL de navigateur (autre événement) → refus : un profil = un seul bot à la fois", async () => {
  const dir = mkdtempSync(join(tmpdir(), "profil-lock-"));
  const other = await holder(".locks", profileKey(dir), "autre-événement#1");
  const web = adapter("p-web", { platform: "p", channel: "browser" });
  try {
    await assert.rejects(quiet(() => main(["run", "--config", cfgFile(`profil-${Date.now()}`, { browser: { headless: true, userDataDir: dir } }), "--log-level", "error"], { adapters: [web], catalog: OK_CAT() })), /même événement ou le même profil/);
    assert.deepEqual(web.calls, []);
  } finally {
    other.kill("SIGKILL");
    rmSync(join(".locks", `${profileKey(dir)}.lock`), { force: true });
  }
});

test("le verrou de l'événement ne gêne pas un AUTRE événement (même adaptateur, autre URL) — aucune dépendance entre événements", async () => {
  const d = mkdtempSync(join(tmpdir(), "locks-"));
  const a = acquireEventLock(eventKey("p-web", "https://api.p.example/events/1"), "a#1", d);
  const b = acquireEventLock(eventKey("p-web", "https://api.p.example/events/2"), "b#2", d);
  const pa = acquireEventLock(profileKey("/tmp/profil-a"), "a#1", d);
  const pb = acquireEventLock(profileKey("/tmp/profil-b"), "b#2", d);
  assert.equal(new Set([a.file, b.file, pa.file, pb.file]).size, 4);
  [a, b, pa, pb].forEach((l) => l.release());
});

test("PID réutilisé : un verrou dont le PID est vivant mais appartient à un AUTRE processus (heure de démarrage différente) est récupéré ; le vrai détenteur ne l'est pas", async () => {
  const d = mkdtempSync(join(tmpdir(), "locks-pid-"));
  const key = eventKey("p-web", "https://api.p.example/events/pid");
  const live = await holder(d, eventKey("autre", "https://x.example/"), "vivant#1"); // un vrai processus vivant, sans rapport
  const file = join(d, `${key}.lock`);
  const start = processStart(live.pid!);
  assert.ok(start === undefined || /^\d+$/.test(start), "heure de démarrage lisible (Linux) ou indisponible");
  const write = (procStart: string | undefined): void => writeFileSync(file, JSON.stringify({ pid: live.pid, instance: "ancien#9", startedAt: new Date().toISOString(), ...(procStart ? { procStart } : {}) }));
  if (start !== undefined) {
    write(start);
    assert.throws(() => acquireEventLock(key, "neuf#1", d), /même événement/, "même PID ET même processus : refusé");
    write(String(Number(start) + 12345)); // le PID a été réutilisé par un autre processus
    acquireEventLock(key, "neuf#2", d).release();
  }
  live.kill("SIGKILL");
});

test("verify() : vrai tant que CETTE instance détient le verrou ; faux si le fichier disparaît ou est repris par une autre instance", () => {
  const d = mkdtempSync(join(tmpdir(), "locks-verify-"));
  const key = eventKey("s", "https://h.example/e/verify");
  const l = acquireEventLock(key, "moi#1", d);
  assert.equal(l.verify(), true);
  rmSync(l.file);
  assert.equal(l.verify(), false, "verrou supprimé");
  writeFileSync(l.file, JSON.stringify({ pid: process.pid, instance: "intrus#2", startedAt: new Date().toISOString() }));
  assert.equal(l.verify(), false, "repris par une autre instance du même processus");
  rmSync(l.file);
  const a = acquireEventLock(key, "moi#3", d);
  const b = acquireEventLock(eventKey("s", "https://h.example/e/verify2"), "moi#3", d);
  const both = combineLocks(a, b);
  assert.equal(both.verify(), true);
  rmSync(b.file);
  assert.equal(both.verify(), false, "un verrou perdu invalide l'ensemble");
  both.release();
});

// ───────────────────────────── reprise : verrou perdu, vérification périodique ─────────────────────────────
const agentConfig = (over: Record<string, unknown> = {}) => ConfigSchema.parse({
  site: "p", event: { name: "T", url: "https://api.p.example/events/1" }, sale: { startTime: new Date(Date.now() - 300).toISOString() },
  tickets: { quantity: 2, maxPricePerTicket: 150 }, timing: { preArmSeconds: 0, pollIntervalMs: 200, maxWaitAfterSaleSeconds: 6 }, notifications: { desktop: false, sound: false }, telemetry: { enabled: false }, ...over,
});
const agentFor = (web: FakeAdapter, extra: Partial<ConstructorParameters<typeof Agent>[0]>) => {
  const config = agentConfig();
  return new Agent({
    config, adapter: web, claude: new ClaudeAssistant(config.claude, silentLogger), log: silentLogger, clock: new Clock(), notifier: async () => undefined,
    ctx: { config, context: {} as never, page: { bringToFront: async () => undefined } as never, log: silentLogger, env: {}, selectors: new SelectorResolver("fake", "/nonexistent/x.json") }, ...extra,
  });
};

test("reprise : verrou PERDU pendant l'attente humaine → arrêt (LOCK_LOST), aucune action de plus", async () => {
  const web = adapter("p-web", { platform: "p", channel: "browser" });
  web.offers = [offer({ id: "a" })];
  web.failures.selectOffer = [new BlockerError({ state: "QUEUE", message: "file" })];
  let held = true;
  let callsAtResume = -1;
  const r = await agentFor(web, { catalog: OK_CAT(), lock: { verify: () => held }, awaitHuman: async () => { held = false; callsAtResume = web.calls.length; } }).run();
  assert.equal(r.status, "error");
  assert.equal(r.failureReason, "LOCK_LOST");
  assert.equal(web.calls.length, callsAtResume);
});

test("reprise : verrou intact → reprise normale jusqu'au panier", async () => {
  const web = adapter("p-web", { platform: "p", channel: "browser" });
  web.offers = [offer({ id: "a" })];
  web.failures.selectOffer = [new BlockerError({ state: "CAPTCHA", message: "captcha" })];
  const r = await agentFor(web, { catalog: OK_CAT(), lock: { verify: () => true }, awaitHuman: async () => undefined }).run();
  assert.equal(r.finalState, "CART_SUCCESS");
});

class Polling extends FakeAdapter {
  fetches = 0;
  onFetch?: (n: number) => void;
  override async fetchSale(): Promise<SaleSnapshot> {
    this.fetches++;
    this.onFetch?.(this.fetches);
    return { open: false, offers: [] };
  }
}
const pollingAdapter = (): Polling => {
  const p = new Polling();
  const meta = adapter("p-web", { platform: "p", channel: "browser" }).meta;
  p.meta = meta;
  return p;
};

test("surveillance longue : la preuve expire EN COURS de surveillance → AUTHORIZATION_EXPIRED à la lecture suivante, ZÉRO requête de plus", async () => {
  const cat = OK_CAT();
  const web = pollingAdapter();
  let fetchesAtExpiry = -1;
  web.onFetch = (n) => {
    if (n === 3) {
      cat.evidence.length = 0;
      cat.evidence.push(ev("p", "both", daysAgo(181))); // expirée
      fetchesAtExpiry = n;
    }
  };
  const r = await agentFor(web, { catalog: cat, authCheckIntervalMs: 50 }).run();
  assert.equal(r.status, "authorization-expired");
  assert.equal(r.finalState, "AUTHORIZATION_EXPIRED");
  assert.equal(web.fetches, fetchesAtExpiry, "aucune lecture après l'expiration");
  assert.ok(web.calls.filter((c) => c.startsWith("selectOffer") || c === "addToCart").length === 0);
});

test("surveillance longue : relecture périodique des FICHIERS de preuve (chargeur) — une preuve retirée du disque arrête le bot, sans requête vers la plateforme", async () => {
  let loads = 0;
  const loader = (): Catalog => (++loads <= 1 ? OK_CAT() : catalogWith([plat("p")], [])); // 1er chargement : preuve ; ensuite : preuve retirée
  const web = pollingAdapter();
  const t0 = Date.now();
  const r = await agentFor(web, { catalogLoader: loader, authCheckIntervalMs: 300 }).run();
  assert.equal(r.status, "authorization-expired");
  assert.ok(loads >= 2, "les fichiers ont été relus");
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2500, `arrêt à l'intervalle de relecture (${elapsed} ms)`);
  const fetchesAfter = web.fetches;
  await new Promise((r2) => setTimeout(r2, 500));
  assert.equal(web.fetches, fetchesAfter, "plus aucune lecture après l'arrêt");
});

test("la vérification périodique est LOCALE : aucune requête réseau (fetch) n'est émise par la relecture des preuves", async () => {
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => (fetched++, new Response("", { headers: { date: new Date().toUTCString() } }))) as typeof fetch;
  try {
    const cat = OK_CAT();
    const web = pollingAdapter();
    web.onFetch = (n) => n === 4 && cat.evidence.splice(0);
    await agentFor(web, { catalog: cat, authCheckIntervalMs: 10 }).run();
    // seule la synchronisation d'horloge initiale (en-tête Date, AVANT la surveillance) a pu appeler fetch ; aucune pendant la surveillance
    assert.ok(fetched <= 3, `${fetched} appels fetch`);
    const after = fetched;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(fetched, after);
  } finally {
    globalThis.fetch = realFetch;
  }
  void readFileSync;
});
