import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";
import { resolveChannel } from "../agent/channels.js";
import { listProfiles, loadConfig, PROFILES_DIR } from "../config/load.js";
import { validateConfig } from "../config/validate.js";
import { channelOf, platformOf } from "../platforms/authorize.js";
import { checkCatalogIntegrity, loadCatalog, stateOf, type Catalog } from "../platforms/catalog.js";
import { EVIDENCE_DIR } from "../platforms/evidence.js";
import { checkAdapterContract } from "../sites/contract.js";
import { discoverAdapterEntries, type AdapterEntry } from "../sites/registry.js";
import { LOG_LEVELS } from "../utils/logger.js";

export type Level = "ok" | "info" | "warn" | "error";
export interface Check {
  area: string;
  level: Level;
  message: string;
  /** Que faire, si ce n'est pas « ok ». */
  fix?: string;
}
export interface DoctorReport {
  checks: Check[];
  errors: number;
  warnings: number;
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  now?: number;
  catalog?: Catalog;
  entries?: AdapterEntry[];
  evidenceDir?: string;
  /** Dossier du projet (défaut : dossier courant). */
  root?: string;
  /** Fichiers de configuration à examiner (défaut : config/event.json + profils). */
  configs?: string[];
  /** Exécutable Chromium (défaut : CHROMIUM_PATH ou celui de Playwright). */
  chromiumPath?: string;
  isTTY?: boolean;
}

const SOON_DAYS = 30;

/** Diagnostic complet, sans AUCUN accès réseau : tout est local (fichiers, processus, variables d'environnement). */
export async function runDoctor(o: DoctorOptions = {}): Promise<DoctorReport> {
  const env = o.env ?? process.env;
  const now = o.now ?? Date.now();
  const root = o.root ?? process.cwd();
  const checks: Check[] = [];
  const add = (area: string, level: Level, message: string, fix?: string): void => void checks.push({ area, level, message, fix });
  const at = (p: string): string => resolve(root, p);

  // ── Node
  const need = (() => {
    try {
      return (JSON.parse(readFileSync(at("package.json"), "utf8")) as { engines?: { node?: string } }).engines?.node ?? ">=20";
    } catch {
      return ">=20";
    }
  })();
  const min = Number(/(\d+)/.exec(need)?.[1] ?? 20);
  const major = Number(process.versions.node.split(".")[0]);
  add("Node", major >= min ? "ok" : "error", `Node ${process.versions.node} (requis ${need})`, major >= min ? undefined : `Installez Node ${min} ou plus récent.`);

  // ── Catalogue, preuves, expiration
  let catalog: Catalog | undefined = o.catalog;
  try {
    catalog ??= loadCatalog({ evidenceDir: o.evidenceDir ?? at(EVIDENCE_DIR), path: at("platforms/catalog.json"), now });
  } catch (e) {
    add("Catalogue", "error", `catalogue illisible : ${(e as Error).message}`, "Corrigez platforms/catalog.json.");
  }
  if (catalog) {
    const problems = checkCatalogIntegrity(catalog);
    add("Catalogue", problems.length ? "error" : "ok", problems.length ? `${problems.length} problème(s) d'intégrité` : `${catalog.platforms.length} plateformes, intégrité OK`, problems.length ? "npm run platforms -- --check" : undefined);
    for (const pr of problems.filter((p) => !p.startsWith("preuve refusée"))) add("Catalogue", "error", pr);
    const counts: Record<string, number> = {};
    for (const p of catalog.platforms) {
      const st = stateOf(catalog, p.id, now);
      counts[st.status] = (counts[st.status] ?? 0) + 1;
      if (st.status === "EXPIRED") add("Expiration", "warn", `${p.id} : preuves expirées`, `npm run platform verify ${p.id}`);
      else if (st.expiresInDays !== undefined && st.expiresInDays <= SOON_DAYS) add("Expiration", "warn", `${p.id} : la preuve expire le ${st.expiresAt} (dans ${st.expiresInDays} j)`, `Revérifiez la page officielle : npm run platform verify ${p.id}`);
      for (const c of st.conflicts) add("Preuves", "warn", `${p.id} : ${c}`);
    }
    add("Catalogue", "info", `statuts : ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    if (!checks.some((c) => c.area === "Expiration")) add("Expiration", "ok", `aucune preuve expirée ni proche de l'expiration (seuil ${SOON_DAYS} j)`);
    add("Preuves", catalog.rejected.length ? "error" : "ok", `${catalog.evidence.length} preuve(s) valide(s), ${catalog.rejected.length} refusée(s)`, catalog.rejected.length ? "npm run platform check" : undefined);
    for (const r of catalog.rejected) add("Preuves", "error", `${r.file} refusée : ${r.issues.map((i) => i.code).join(", ")}`, "npm run platform check");
  }

  // ── Adaptateurs
  let entries = o.entries;
  try {
    entries ??= await discoverAdapterEntries(o.root ? resolve(o.root, "src/sites") : undefined);
  } catch (e) {
    add("Adaptateurs", "error", `découverte impossible : ${(e as Error).message}`);
  }
  if (entries && catalog) {
    for (const { adapter, file } of entries) {
      const errors = checkAdapterContract(adapter, { sourceFile: file, catalog, now }).filter((i) => i.severity === "error");
      const skeleton = errors.some((e) => e.code === "SKELETON_NOT_VERIFIED");
      add("Adaptateurs", errors.length === 0 ? "ok" : skeleton ? "warn" : "error", `${adapter.meta.id} (${channelOf(adapter.meta)}, ${adapter.meta.compliance.policy}) : ${errors.length === 0 ? "contrat OK" : skeleton ? "squelette NOT_VERIFIED (non exécutable)" : errors.map((e) => e.code).join(", ")}`, errors.length && !skeleton ? "npm run sites" : skeleton ? `npm run platform verify ${platformOf(adapter.meta)}` : undefined);
      // Variables d'environnement requises par l'adaptateur
      for (const k of adapter.meta.requires?.env ?? []) add("Environnement", env[k] ? "ok" : "warn", env[k] ? `${k} définie` : `${k} absente (adaptateur « ${adapter.meta.id} » : le canal suivant sera utilisé)`, env[k] ? undefined : `Exportez ${k} (jamais dans le code ni dans un fichier commité).`);
    }
    if (entries.length === 0) add("Adaptateurs", "warn", "aucun adaptateur dans src/sites/");
  }

  // ── Configuration
  const configs = o.configs ?? [existsSync(at("config/event.json")) ? "config/event.json" : "", ...listProfiles(at(PROFILES_DIR)).map((p) => `${PROFILES_DIR}/${p}.json`)].filter(Boolean);
  if (!existsSync(at("config/event.json")) && !o.configs) add("Configuration", "warn", "config/event.json absent", "cp config/event.example.json config/event.json");
  let needsBrowser = false;
  let claudeWanted = false;
  for (const c of configs) {
    const path = c.startsWith("/") ? c : at(c);
    const r = await validateConfig(path, { now, env, catalog, adapters: entries?.map((e) => e.adapter) });
    add("Configuration", r.ok ? (r.warnings.length ? "warn" : "ok") : "error", `${c} : ${r.ok ? `valide${r.warnings.length ? `, ${r.warnings.length} avertissement(s)` : ""}` : r.errors[0]}`, r.ok ? undefined : `npm run validate -- ${c}`);
    if (r.config) {
      if (r.config.claude.enabled) claudeWanted = true;
      if (entries && catalog) {
        try {
          if (resolveChannel({ platform: r.config.site, adapters: entries.map((e) => e.adapter), catalog, env, config: r.config, now }).channel === "browser") needsBrowser = true;
        } catch {
          /* déjà signalé par validateConfig */
        }
      }
    }
  }
  if (configs.length === 0) add("Configuration", "warn", "aucune configuration trouvée");

  // ── Chromium
  const exe = o.chromiumPath ?? env.CHROMIUM_PATH ?? (() => {
    try {
      return chromium.executablePath();
    } catch {
      return "";
    }
  })();
  const severity: Level = needsBrowser ? "error" : "warn";
  if (!exe || !existsSync(exe)) {
    add("Chromium", severity, `Chromium introuvable${exe ? ` (${exe})` : ""}${needsBrowser ? " — requis par un profil au canal navigateur" : " — nécessaire seulement pour les canaux navigateur"}`, "npx playwright install chromium (ou CHROMIUM_PATH vers un Chrome/Chromium existant)");
  } else {
    try {
      const v = execFileSync(exe, ["--version"], { timeout: 8000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      add("Chromium", "ok", `${v} (${exe})`);
    } catch {
      add("Chromium", severity, `l'exécutable ${exe} ne démarre pas (bibliothèques système manquantes ?)`, "npx playwright install --with-deps chromium");
    }
  }
  if (typeof process.getuid === "function" && process.getuid() === 0) add("Chromium", "info", "exécution en root : Chromium sera lancé avec --no-sandbox");

  // ── Variables d'environnement générales
  if (claudeWanted) add("Environnement", env.ANTHROPIC_API_KEY ? "ok" : "warn", env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY définie" : "claude.enabled=true dans une configuration mais ANTHROPIC_API_KEY absente (assistant désactivé)", env.ANTHROPIC_API_KEY ? undefined : "Exportez ANTHROPIC_API_KEY ou désactivez claude.enabled.");
  if (env.LOG_LEVEL && !(LOG_LEVELS as readonly string[]).includes(env.LOG_LEVEL.toLowerCase())) add("Environnement", "warn", `LOG_LEVEL « ${env.LOG_LEVEL} » invalide (${LOG_LEVELS.join(" | ")})`);
  if (env.NOTIFY_WEBHOOK_URL) add("Environnement", /^https:\/\//.test(env.NOTIFY_WEBHOOK_URL) ? "ok" : "error", /^https:\/\//.test(env.NOTIFY_WEBHOOK_URL) ? "NOTIFY_WEBHOOK_URL définie (https)" : "NOTIFY_WEBHOOK_URL doit être en https", "Corrigez l'URL du webhook.");
  if (!checks.some((c) => c.area === "Environnement")) add("Environnement", "ok", "aucune variable requise manquante");

  // ── Permissions
  for (const d of ["runs", ".cache", ".locks", ".profile", EVIDENCE_DIR]) {
    const p = at(d);
    // Dossier pas encore créé : on vérifie le premier ancêtre existant (c'est lui qui devra accepter la création).
    let target = p;
    while (!existsSync(target) && dirname(target) !== target) target = dirname(target);
    try {
      accessSync(target, constants.W_OK);
      add("Permissions", "ok", `${d}/ : écriture possible${existsSync(p) ? "" : " (sera créé)"}`);
    } catch {
      add("Permissions", "error", `${d}/ : écriture impossible (${target})`, `Donnez les droits d'écriture sur ${target}.`);
    }
  }
  const tty = o.isTTY ?? Boolean(process.stdin.isTTY);
  add("Permissions", tty ? "ok" : "warn", tty ? "terminal interactif : la cession de main (Entrée) est possible" : "pas de terminal interactif : la cession de main par Entrée est impossible (connexion manuelle, plan de salle)", tty ? undefined : "Lancez le bot dans un terminal interactif pour un vrai événement.");
  const notifier = process.platform === "darwin" ? "osascript" : process.platform === "linux" ? "notify-send" : "powershell";
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [notifier], { stdio: "ignore" });
    add("Permissions", "ok", `notifications système disponibles (${notifier})`);
  } catch {
    add("Permissions", "info", `${notifier} absent : seules la bannière du terminal, le bip et NOTIFY_WEBHOOK_URL seront utilisés`);
  }

  return { checks, errors: checks.filter((c) => c.level === "error").length, warnings: checks.filter((c) => c.level === "warn").length };
}

const ICON: Record<Level, string> = { ok: "✓", info: "·", warn: "⚠", error: "✗" };

/** `npm run doctor` : code de sortie 1 s'il y a au moins une erreur. */
export async function doctorCommand(opts: { json: boolean }): Promise<number> {
  const report = await runDoctor();
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return report.errors ? 1 : 0;
  }
  let area = "";
  for (const c of report.checks) {
    if (c.area !== area) {
      area = c.area;
      console.log(`\n${area}`);
    }
    console.log(`  ${ICON[c.level]} ${c.message}${c.level !== "ok" && c.level !== "info" && c.fix ? `\n      → ${c.fix}` : ""}`);
  }
  console.log(`\n${report.errors ? "✗" : "✓"} ${report.errors} erreur(s), ${report.warnings} avertissement(s). Diagnostic local : aucun site n'a été contacté.`);
  return report.errors ? 1 : 0;
}
