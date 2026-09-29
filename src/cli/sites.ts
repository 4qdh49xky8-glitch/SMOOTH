import { checkAdapterContract } from "../sites/contract.js";
import { discoverAdapterEntries } from "../sites/registry.js";

/** `npm run sites` : liste des adaptateurs, base d'autorisation et état du contrat. */
export async function sitesCommand(opts: { json: boolean }): Promise<number> {
  const entries = await discoverAdapterEntries();
  const rows = entries.map(({ adapter, file }) => {
    const issues = checkAdapterContract(adapter, { sourceFile: file });
    const errors = issues.filter((i) => i.severity === "error");
    const c = adapter.meta.capabilities;
    return {
      id: adapter.meta.id,
      name: adapter.meta.displayName,
      policy: adapter.meta.compliance.policy,
      termsReviewedAt: adapter.meta.compliance.reviewedAt,
      contract: errors.length ? "KO" : "OK",
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
  console.log(`${pad("ID", 14)}${pad("NOM", 34)}${pad("AUTORISATION", 20)}${pad("CGU RELUES", 12)}${pad("CONTRAT", 9)}CAPACITÉS`);
  for (const r of rows) {
    const c = r.capabilities;
    const caps = [c.officialApi ? "API-officielle" : "pages", c.preciseServerTime ? "horloge" : "", c.reportsSeatAdjacency ? "côte-à-côte" : "", `places:${c.seatSelection}`].filter(Boolean).join(" ");
    console.log(`${pad(r.id, 14)}${pad(r.name, 34)}${pad(r.policy, 20)}${pad(r.termsReviewedAt, 12)}${pad(r.contract === "OK" ? "✓ OK" : "✗ KO", 9)}${caps}`);
    for (const i of r.issues) console.log(`    ${i.severity === "error" ? "✗" : "⚠"} [${i.code}] ${i.message}`);
  }
  console.log(`\n${rows.length} adaptateur(s). Ajouter un site : docs/ADDING_A_SITE.md — vérification complète : npm run test:adapters`);
  return rows.some((r) => r.contract === "KO") ? 1 : 0;
}
