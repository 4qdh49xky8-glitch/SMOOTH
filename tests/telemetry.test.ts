import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { aggregate, loadRecords, sanitize, Telemetry } from "../src/telemetry/Telemetry.js";
import { Clock } from "../src/utils/clock.js";

const mk = (enabled = true, dir = mkdtempSync(join(tmpdir(), "telemetry-"))) => {
  const clock = new Clock();
  const sale = clock.now();
  return { t: new Telemetry({ clock, saleEpochMs: sale, mode: "simulation", site: "example", profile: "concert", enabled, dir }), dir };
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("sanitize retire URLs, e-mails et longues suites de chiffres", () => {
  const s = sanitize("Échec sur https://x.example/a?token=abc pour jean@example.com carte 4970123456789012");
  assert.ok(!s.includes("x.example") && !s.includes("jean@") && !s.includes("4970123456789012"), s);
  assert.equal(sanitize("a".repeat(500)).length, 160);
});

test("métriques : disponibilité, sélection, panier, tentatives, cadence des interrogations", async () => {
  const { t } = mk();
  t.mark("triggered");
  t.poll(10);
  t.poll(30);
  await wait(20);
  t.mark("availability-detected");
  await wait(20);
  t.attempt({ category: "Cat 2", pricePerTicket: 139, outcome: "unavailable", reason: "OFFER_UNAVAILABLE", durationMs: 15 });
  t.mark("offer-selected");
  await wait(10);
  t.mark("added-to-cart");
  t.attempt({ category: "Cat 3", pricePerTicket: 120, outcome: "cart", durationMs: 40 });
  t.state("AVAILABLE");
  t.state("CART_SUCCESS");
  t.handoff();
  t.setClock(12.34, 1.2);
  const r = t.finalize({ status: "in-cart", finalState: "CART_SUCCESS" });
  assert.equal(r.metrics.attempts, 2);
  assert.equal(r.metrics.humanHandoffs, 1);
  assert.equal(r.metrics.polls, 2);
  assert.ok(r.metrics.timeToAvailabilityMs! >= 15);
  assert.ok(r.metrics.timeToSelectionMs! >= 15);
  assert.ok(r.metrics.timeToCartMs! >= r.metrics.timeToAvailabilityMs!);
  assert.equal(r.metrics.pollLatencyMs!.avg, 20);
  assert.equal(r.metrics.clockOffsetMs, 12.3);
  assert.deepEqual(r.states.map((s) => s.state), ["AVAILABLE", "CART_SUCCESS"]);
  assert.deepEqual(r.attemptsDetail.map((a) => a.reason), ["OFFER_UNAVAILABLE", undefined]);
});

test("échec : la raison normalisée est conservée, les délais absents sont null", () => {
  const { t } = mk();
  const r = t.finalize({ status: "blocked", finalState: "PURCHASE_LIMIT", failureReason: "PURCHASE_LIMIT" });
  assert.equal(r.failureReason, "PURCHASE_LIMIT");
  assert.equal(r.metrics.timeToCartMs, null);
  assert.equal(r.metrics.timeToAvailabilityMs, null);
});

test("vie privée : le fichier enregistré ne contient ni URL, ni e-mail, ni identifiant", () => {
  const { t, dir } = mk();
  t.state("ERROR", "échec https://billet.example/cart?session=SECRET jean@example.com");
  t.attempt({ category: "Cat 1", pricePerTicket: 99, outcome: "error", reason: "ADAPTER_ERROR", durationMs: 5 });
  const file = t.save(t.finalize({ status: "error", finalState: "ERROR", failureReason: "ADAPTER_ERROR", cart: { itemCount: 2, totalPrice: 240, currency: "EUR" } }))!;
  const text = readFileSync(file, "utf8");
  assert.ok(!/https?:\/\//.test(text) && !/@/.test(text) && !text.includes("SECRET"), text);
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["attemptsDetail", "cart", "failureReason", "finalState", "metrics", "mode", "profile", "schemaVersion", "site", "stagesMs", "startedAt", "states", "status", "timeline"]);
  assert.equal(readdirSync(dir).length, 1);
});

test("télémétrie désactivée : rien n'est écrit", () => {
  const { t, dir } = mk(false);
  assert.equal(t.save(t.finalize({ status: "error", finalState: "ERROR" })), null);
  assert.equal(readdirSync(dir).length, 0);
});

test("agrégats sur plusieurs runs", () => {
  const { t, dir } = mk();
  const rec = (state: "CART_SUCCESS" | "ERROR", reason?: "ADAPTER_ERROR") => {
    const x = new Telemetry({ clock: new Clock(), saleEpochMs: Date.now(), mode: "simulation", site: "example", enabled: true, dir });
    x.mark("availability-detected");
    x.mark("added-to-cart");
    const r = x.finalize({ status: "x", finalState: state, failureReason: reason });
    x.save(r);
    return r;
  };
  void t;
  rec("CART_SUCCESS");
  rec("ERROR", "ADAPTER_ERROR");
  const a = aggregate(loadRecords(dir));
  assert.equal(a.runs, 2);
  assert.equal(a.successRate, 0.5);
  assert.deepEqual(a.failureReasons, { ADAPTER_ERROR: 1 });
});
