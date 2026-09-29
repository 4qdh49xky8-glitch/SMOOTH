import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireEventLock, eventKey } from "../../src/utils/lock.js";
import { assertNoSensitiveData, expectRun, runStress } from "./harness.js";

/** Scénario 12 — deux instances simultanées : sessions, logs et télémétries séparés. */
test("12 · deux instances simultanées (événements différents) : résultats, logs et télémétries strictement séparés", async () => {
  const dir = mkdtempSync(join(tmpdir(), "two-instances-"));
  const [a, b] = await Promise.all([
    runStress("01-together-90-vs-separate-70", { profile: "concert", telemetryDir: dir, scope: "concert#111" }),
    runStress("03-category-a-unavailable", { profile: "festival", telemetryDir: dir, scope: "festival#222" }),
  ]);
  expectRun(a, { status: "in-cart", finalState: "CART_SUCCESS", offerId: "ensemble-90", attempts: 1 }, "instance A");
  expectRun(b, { status: "in-cart", finalState: "CART_SUCCESS", offerId: "b-dispo", attempts: 1 }, "instance B");

  // Télémétries : deux fichiers distincts dans le même dossier, chacun avec SON profil et SES états.
  assert.equal(readdirSync(dir).length, 2);
  assert.notEqual(a.telemetryFile, b.telemetryFile);
  assert.equal(a.record.profile, "concert");
  assert.equal(b.record.profile, "festival");

  // Logs : chaque ligne porte l'identité de son instance et ne mentionne jamais l'autre événement.
  assert.ok(a.logs.length > 5 && b.logs.length > 5);
  assert.ok(a.logs.every((l) => l.includes("[concert#111")), "ligne de A sans identité d'instance");
  assert.ok(b.logs.every((l) => l.includes("[festival#222")), "ligne de B sans identité d'instance");
  assert.ok(!a.logs.join("\n").includes("Festival (exemple)") && !a.logs.join("\n").includes("b-dispo"));
  assert.ok(!b.logs.join("\n").includes("Concert (exemple)") && !b.logs.join("\n").includes("ensemble-90"));
  // Sessions (faux sites) : chaque instance n'a parlé qu'à son propre site simulé.
  assert.notEqual(a.adapter, b.adapter);
  assert.ok(!a.adapter.calls.some((c) => c === "selectOffer") || a.adapter.calls.filter((c) => c === "addToCart").length === 1);
  assert.equal(a.adapter.calls.filter((c) => c === "addToCart").length, 1);
  assert.equal(b.adapter.calls.filter((c) => c === "addToCart").length, 1);
  assertNoSensitiveData(a, "A");
  assertNoSensitiveData(b, "B");
});

test("12 · dix instances en parallèle vers le même dossier : aucune télémétrie écrasée, aucun mélange", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ten-instances-"));
  const runs = await Promise.all(
    Array.from({ length: 10 }, (_, i) => runStress("14-price-equals-max", { telemetryDir: dir, scope: `i${i}`, startInMs: 500 })),
  );
  assert.equal(readdirSync(dir).length, 10);
  assert.equal(new Set(runs.map((r) => r.telemetryFile)).size, 10);
  for (const [i, r] of runs.entries()) {
    expectRun(r, { status: "in-cart", finalState: "CART_SUCCESS", offerId: "pile", attempts: 1 }, `i${i}`);
    assert.ok(r.logs.every((l) => l.includes(`[i${i}`)), `logs de i${i} mélangés`);
  }
});

test("12 · verrou d'événement : un seul bot par événement, événements différents en parallèle, verrou orphelin récupéré", () => {
  const dir = mkdtempSync(join(tmpdir(), "locks-"));
  const k1 = eventKey("site-a", "https://billets.example/evenement/42?utm=x&ref=y");
  assert.equal(k1, eventKey("site-a", "https://billets.example/evenement/42?autre=1"), "les paramètres d'URL ne changent pas l'événement");
  assert.notEqual(k1, eventKey("site-a", "https://billets.example/evenement/43"));
  assert.notEqual(k1, eventKey("site-b", "https://billets.example/evenement/42"));

  const first = acquireEventLock(k1, "concert#1", dir);
  assert.throws(() => acquireEventLock(k1, "concert-bis#2", dir), /même événement/, "deuxième instance sur le même événement");
  const other = acquireEventLock(eventKey("site-a", "https://billets.example/evenement/43"), "festival#3", dir);
  other.release();
  first.release();
  acquireEventLock(k1, "concert#4", dir).release(); // libéré : de nouveau disponible

  // Verrou orphelin (processus mort) : récupéré automatiquement.
  const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
  writeFileSync(join(dir, `${k1}.lock`), JSON.stringify({ pid: dead, instance: "mort#0", startedAt: new Date().toISOString() }));
  const recovered = acquireEventLock(k1, "vivant#5", dir);
  recovered.release();
});
