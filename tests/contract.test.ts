import assert from "node:assert/strict";
import { test } from "node:test";
import ExampleSite from "../src/sites/ExampleSite.js";
import { checkAdapterContract, scanSource, stripComments } from "../src/sites/contract.js";
import { discoverAdapterEntries, discoverAdapters, getAdapter } from "../src/sites/registry.js";
import type { SiteAdapter } from "../src/sites/SiteAdapter.js";

const codes = (a: SiteAdapter, now?: number): string[] => checkAdapterContract(a, { now }).filter((i) => i.severity === "error").map((i) => i.code);
const patched = (patch: (a: ExampleSite) => Record<string, PropertyDescriptor>): SiteAdapter => {
  const a = new ExampleSite();
  return Object.create(a, patch(a)) as SiteAdapter;
};

test("l'adaptateur de démo respecte le contrat", () => {
  assert.deepEqual(codes(new ExampleSite()), []);
});

test("le contrat détecte les manquements", () => {
  assert.ok(codes(patched(() => ({ fetchSale: { value: undefined } }))).includes("METHOD_MISSING"));
  assert.ok(codes(patched(() => ({ paymentUrlPatterns: { value: [] } }))).includes("PAYMENT_GUARD"));
  assert.ok(codes(patched(() => ({ paymentUrlPatterns: { value: [/\/payment/g] } }))).includes("PAYMENT_GUARD_FLAGS"));
  assert.ok(codes(patched(() => ({ paymentUrlPatterns: { value: [/.*/] } }))).includes("PAYMENT_GUARD_BROAD")); // bloquerait la page événement
  assert.ok(codes(patched((a) => ({ meta: { value: { ...a.meta, id: "Mauvais Id" } } }))).includes("META_ID"));
  assert.ok(codes(patched((a) => ({ meta: { value: { ...a.meta, capabilities: { ...a.meta.capabilities, seatSelection: "automatic" } } } }))).includes("SEATS_METHOD"));
  assert.ok(codes(patched((a) => ({ meta: { value: { ...a.meta, capabilities: { ...a.meta.capabilities, preciseServerTime: true } } }, getServerTime: { value: undefined } }))).includes("CLOCK_METHOD"));
  assert.ok(codes(patched((a) => ({ meta: { value: { ...a.meta, compliance: { ...a.meta.compliance, policy: "official-api", termsUrl: "https://a.example/t", reviewedAt: "2026-09-01" } } } }))).includes("OFFICIAL_API"));
});

test("le contrat exige une autorisation relue récemment", () => {
  const reviewed = (date: string, policy: "permitted-by-terms" | "demo" = "permitted-by-terms"): SiteAdapter =>
    patched((a) => ({ meta: { value: { ...a.meta, compliance: { policy, termsUrl: "https://a.example/cgu", reviewedAt: date } } } }));
  const now = Date.parse("2026-09-29");
  assert.deepEqual(codes(reviewed("2026-08-01"), now), []);
  assert.ok(codes(reviewed("2025-01-01"), now).includes("COMPLIANCE")); // > 180 jours
  assert.ok(codes(reviewed("pas-une-date"), now).includes("COMPLIANCE"));
  assert.ok(codes(patched((a) => ({ meta: { value: { ...a.meta, compliance: { policy: "permitted-by-terms", termsUrl: "http://pas-https", reviewedAt: "2026-09-01" } } } })), now).includes("COMPLIANCE"));
});

test("scan du code source : motifs interdits détectés, commentaires ignorés", () => {
  const bad: Record<string, string> = {
    "résolution de CAPTCHA": "await solveCaptcha(page)",
    "masquage": "args: ['--disable-blink-features=AutomationControlled']",
    "contournement": "function bypassQueue() {}",
    "proxys": "const p = rotateProxy()",
    "comptes": "await createAccount(email)",
    "clic paiement": "await page.getByText('Payer').click(); await page.click('#payer')",
    "bancaire": "fill(cardNumber)",
    "paiement auto": "autoPayment: true",
  };
  for (const [why, code] of Object.entries(bad)) assert.ok(scanSource(code).length > 0, why);
  assert.equal(scanSource("// on ne doit jamais bypasser la file\n/* stealth interdit */\nconst ok = 1;").length, 0);
  assert.equal(scanSource("await page.click('[data-testid=\"add-to-cart\"]')").length, 0);
  assert.equal(stripComments("a // c\nb /* d */ e").replace(/\s+/g, " ").trim(), "a b e");
});

test("découverte : déposer un fichier suffit ; doublon et export manquant sont refusés", async () => {
  const ok = await discoverAdapterEntries("tests/fixtures/sites-ok");
  assert.deepEqual(ok.map((e) => e.adapter.meta.id), ["good"]);
  assert.deepEqual(checkAdapterContract(ok[0]!.adapter, { sourceFile: ok[0]!.file, now: Date.parse("2026-09-29") }), []);
  assert.equal((await getAdapter("good", "tests/fixtures/sites-ok")).meta.displayName, "Bon site");
  await assert.rejects(getAdapter("absent", "tests/fixtures/sites-ok"), /Adaptateur inconnu/);
  await assert.rejects(discoverAdapters("tests/fixtures/sites-dup"), /en double/);
  await assert.rejects(discoverAdapters("tests/fixtures/sites-bad"), /exporter par défaut/);
});
