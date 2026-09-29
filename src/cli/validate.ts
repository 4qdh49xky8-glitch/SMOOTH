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
  // Deux profils qui partagent un même profil Chromium ne peuvent pas tourner en même temps (un navigateur = un profil).
  const byDir = new Map<string, string[]>();
  for (const r of reports) {
    const dir = r.config?.browser.userDataDir;
    if (dir) byDir.set(dir, [...(byDir.get(dir) ?? []), r.profile]);
  }
  for (const [dir, names] of byDir)
    if (names.length > 1) for (const r of reports) if (names.includes(r.profile)) r.warnings.push(`browser.userDataDir « ${dir} » partagé avec ${names.filter((n) => n !== r.profile).join(", ")} : ces profils ne pourront pas tourner simultanément (laissez userDataDir vide : un navigateur par profil).`);
  if (opts.json) console.log(JSON.stringify(reports.map(({ config: _c, ...r }) => r), null, 2));
  else {
    reports.forEach(print);
    if (reports.length > 1) console.log(`\n${reports.filter((r) => r.ok).length}/${reports.length} profil(s) valide(s).`);
  }
  return reports.every((r) => r.ok) ? 0 : 1;
}
