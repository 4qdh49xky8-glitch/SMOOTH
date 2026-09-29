import assert from "node:assert/strict";
import { test } from "node:test";
import { renderNewSite, toCamel, toPascal } from "../scripts/new-site.js";
import { scanSource } from "../src/sites/contract.js";

test("le générateur produit adaptateur, sélecteurs et test, non conformes tant que l'autorisation n'est pas renseignée", () => {
  const files = renderNewSite("fnac-spectacles", "Site Exemple");
  assert.deepEqual(Object.keys(files).sort(), ["src/selectors/fnac-spectacles.ts", "src/sites/FnacSpectacles.ts", "tests/fnac-spectacles.test.ts"]);
  const adapter = files["src/sites/FnacSpectacles.ts"]!;
  assert.match(adapter, /export default class FnacSpectacles extends BaseSiteAdapter/);
  assert.match(adapter, /id: "fnac-spectacles"/);
  assert.equal((adapter.match(/TODO\(COMPLIANCE\)/g) ?? []).length, 4); // les 4 champs d'autorisation à renseigner
  assert.match(adapter, /termsUrl: "TODO"/); // échoue au contrat et au contrôle de conformité du cœur
  assert.equal(scanSource(adapter).length, 0); // le squelette lui-même ne déclenche aucun motif interdit
  assert.match(files["src/selectors/fnac-spectacles.ts"]!, /fnacSpectaclesSelectors/);
});

test("le générateur refuse un identifiant invalide et assainit le nom affiché", () => {
  assert.throws(() => renderNewSite("Mon Site", "x"), /minuscules/);
  assert.throws(() => renderNewSite("../evil", "x"), /minuscules/);
  assert.ok(!renderNewSite("ok", 'a"; process.exit(1); //')["src/sites/Ok.ts"]!.includes('"; process.exit'));
  assert.equal(toPascal("see-tickets"), "SeeTickets");
  assert.equal(toCamel("axs"), "axs");
});
