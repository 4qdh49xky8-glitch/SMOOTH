import assert from "node:assert/strict";
import { test } from "node:test";
import { loadCatalog } from "../src/platforms/catalog.js";
import { checkAdapterContract } from "../src/sites/contract.js";
import { discoverAdapterEntries } from "../src/sites/registry.js";

/**
 * `npm run test:adapters` — contrat appliqué automatiquement à TOUT adaptateur déposé dans src/sites/.
 * Un nouveau site est vérifié sans toucher à ce fichier. Pour n'en vérifier qu'un : ADAPTER=<id> npm run test:adapters
 */
const only = process.env.ADAPTER;
const entries = (await discoverAdapterEntries()).filter((e) => !only || e.adapter.meta.id === only);

test("au moins un adaptateur est découvert et les identifiants sont uniques", () => {
  assert.ok(entries.length >= 1, only ? `adaptateur « ${only} » introuvable` : "aucun adaptateur");
  assert.equal(new Set(entries.map((e) => e.adapter.meta.id)).size, entries.length);
});

for (const { adapter, file } of entries) {
  test(`contrat « ${adapter.meta.id} » : méthodes, capacités, autorisation, garde-fou de paiement, code source`, () => {
    const issues = checkAdapterContract(adapter, { sourceFile: file, catalog: loadCatalog() });
    const errors = issues.filter((i) => i.severity === "error");
    if (errors.some((e) => e.code === "SKELETON_NOT_VERIFIED")) {
      // Squelette explicitement NOT_VERIFIED : il doit être BLOQUÉ (non exécutable), ce qui est l'état attendu.
      assert.ok(errors.some((e) => e.code === "PLATFORM_AUTH" || e.code === "COMPLIANCE"), "un squelette NOT_VERIFIED doit aussi être refusé par l'autorisation");
      return;
    }
    assert.deepEqual(errors.map((e) => `[${e.code}] ${e.message}`), []);
  });
}
