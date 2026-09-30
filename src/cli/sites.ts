import { checkAdapterContract } from "../sites/contract.js";
import { loadCatalog } from "../platforms/catalog.js";
import { discoverAdapterEntries } from "../sites/registry.js";

/** `npm run sites` : liste des adaptateurs, base d'autorisation et état du contrat. */
export async function sitesCommand(opts: { json: boolean }): Promise<number> {
  const entries = await discoverAdapterEntries();
  const catalog = loadCatalog();
  const rows = entries.map(({ adapter, file }) => {
    const issues = checkAdapterContract(adapter, { sourceFile: file, catalog });
    const errors = issues.filter((i) => i.severity === "error");
    const c = adapter.meta.capabilities;
    return {
      id: adapter.meta.id,
      name: adapter.meta.displayName,
      policy: adapter.meta.compliance.policy,
      testOnly: adapter.meta.testOnly === true,
      termsReviewedAt: adapter.meta.compliance.reviewedAt,
      contract: errors.some((e) => e.code === "SKELETON_NOT_VERIFIED") ? "NOT_VERIFIED" : errors.length ? "KO" : "OK",
      capabilities: c,
      issues,
    };
  });
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return rows.some((r) => r.contract === "KO") ? 1 : 0;
  }
  if (!rows.length) {
    console.log("Aucun adaptateur dans src/sites/. Voir docs/ADDING_A_SITE.md");
    return 0;
  }
  const pad = (s: string, n: number): string => s.padEnd(n);
  console.log(`${pad("ID", 14)}${pad("NOM", 66)}${pad("AUTORISATION", 20)}${pad("CGU RELUES", 12)}${pad("CONTRAT", 11)}CAPACITÉS`);
  for (const r of rows) {
    const c = r.capabilities;
    const caps = [c.officialApi ? "API-officielle" : "pages", c.preciseServerTime ? "horloge" : "", c.reportsSeatAdjacency ? "côte-à-côte" : "", `places:${c.seatSelection}`].filter(Boolean).join(" ");
    console.log(`${pad(r.id, 14)}${pad(r.name, 66)}${pad(r.testOnly ? `${r.policy} TEST_ONLY` : r.policy, 20)}${pad(r.termsReviewedAt, 12)}${pad(r.contract === "OK" ? "✓ OK" : r.contract === "NOT_VERIFIED" ? "⚠ NOT_VER." : "✗ KO", 11)}${caps}`);
    for (const i of r.issues) console.log(`    ${i.severity === "error" ? "✗" : "⚠"} [${i.code}] ${i.message}`);
  }
  console.log(`\n${rows.length} adaptateur(s). Ajouter un site : docs/ADDING_A_SITE.md — vérification complète : npm run test:adapters`);
  return rows.some((r) => r.contract === "KO") ? 1 : 0;
}
