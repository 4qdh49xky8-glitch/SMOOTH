import { listProfiles, PROFILES_DIR } from "../config/load.js";
import { validateConfig, type ValidationReport } from "../config/validate.js";
import { join } from "node:path";

function print(r: ValidationReport): void {
  console.log(`${r.ok ? "✓" : "✗"} ${r.file}`);
  for (const m of r.errors) console.log(`    ✗ ${m}`);
  for (const m of r.warnings) console.log(`    ⚠ ${m}`);
  for (const m of r.info) console.log(`    · ${m}`);
}

/** `npm run validate -- <fichier|profil>` ; `--all` valide tous les profils de config/events/. */
export async function validateCommand(target: string | undefined, opts: { all: boolean; json: boolean }): Promise<number> {
  const targets = opts.all ? listProfiles().map((p) => join(PROFILES_DIR, `${p}.json`)) : [target ?? "config/event.json"];
  if (opts.all && !targets.length) {
    console.log(`Aucun profil dans ${PROFILES_DIR}/`);
    return 1;
  }
  const reports: ValidationReport[] = [];
  for (const t of targets) reports.push(await validateConfig(t));
  if (opts.json) console.log(JSON.stringify(reports.map(({ config: _c, ...r }) => r), null, 2));
  else {
    reports.forEach(print);
    if (reports.length > 1) console.log(`\n${reports.filter((r) => r.ok).length}/${reports.length} profil(s) valide(s).`);
  }
  return reports.every((r) => r.ok) ? 0 : 1;
}
