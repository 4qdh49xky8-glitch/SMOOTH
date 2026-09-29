import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { ConfigSchema, type BotConfig } from "./schema.js";

export const PROFILES_DIR = "config/events";

/** Ancien format plat (V1) → format générique. Permet de conserver les anciens fichiers. */
export function migrateLegacyConfig(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const r = raw as Record<string, unknown>;
  if (typeof r.event !== "string" && r.saleTime === undefined) return raw; // déjà au nouveau format
  const { event, eventUrl, saleTime, quantity, maxPricePerTicket, categories, seatsTogether, seatsTogetherStrict, autoAddToCart, autoPayment, site, ...rest } = r;
  return {
    ...rest,
    site: site ?? "example",
    event: { name: event, url: eventUrl },
    sale: { startTime: saleTime },
    tickets: { quantity, maxPricePerTicket, categories, seatsTogether, seatsTogetherStrict },
    behavior: { autoAddToCart, autoPayment },
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Fusion profonde : les objets sont fusionnés, les tableaux et scalaires de l'enfant remplacent ceux du parent. */
export function deepMerge(base: unknown, over: unknown): unknown {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

function readJson(abs: string): unknown {
  try {
    return JSON.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    throw new Error(`Impossible de lire la configuration ${abs} : ${(err as Error).message}`);
  }
}

/** Lit un fichier JSON en résolvant récursivement `extends` (profil parent, chemin relatif au fichier). */
export function readConfigFile(path: string, depth = 0): unknown {
  if (depth > 5) throw new Error(`Chaîne "extends" trop profonde ou circulaire (${path})`);
  const abs = resolve(path);
  const raw = migrateLegacyConfig(readJson(abs));
  if (isObj(raw) && typeof raw.extends === "string") {
    const parent = readConfigFile(join(dirname(abs), raw.extends), depth + 1);
    return deepMerge(parent, raw);
  }
  return raw;
}

/** Accepte un chemin de fichier ou un nom de profil (config/events/<nom>.json). */
export function resolveConfigPath(target: string | undefined, profilesDir = PROFILES_DIR): string {
  if (!target) return "config/event.json";
  if (/[\\/]/.test(target) || extname(target) === ".json") return target;
  const p = join(profilesDir, `${target}.json`);
  if (existsSync(p)) return p;
  throw new Error(`Profil inconnu « ${target} » (attendu : ${p}). Profils disponibles : ${listProfiles(profilesDir).join(", ") || "(aucun)"}`);
}

/** Profils utilisables (les fichiers commençant par « _ » sont des bases à hériter, pas des profils). */
export function listProfiles(profilesDir = PROFILES_DIR): string[] {
  try {
    return readdirSync(profilesDir)
      .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
      .map((f) => basename(f, ".json"))
      .sort();
  } catch {
    return [];
  }
}

export function parseConfig(raw: unknown, source: string): BotConfig {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(racine)"} : ${i.message}`);
    throw new Error(`Configuration invalide (${source}) :\n${issues.join("\n")}`);
  }
  const cfg = parsed.data;
  if (process.env.CHROMIUM_PATH && !cfg.browser.executablePath) cfg.browser.executablePath = process.env.CHROMIUM_PATH;
  return cfg;
}

export function loadConfig(target: string): BotConfig {
  const path = resolveConfigPath(target);
  return parseConfig(readConfigFile(path), resolve(path));
}
