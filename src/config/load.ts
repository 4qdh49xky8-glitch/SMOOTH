import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigSchema, type BotConfig } from "./schema.js";

export function loadConfig(path: string): BotConfig {
  const abs = resolve(path);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    throw new Error(`Impossible de lire la configuration ${abs} : ${(err as Error).message}`);
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(racine)"} : ${i.message}`);
    throw new Error(`Configuration invalide (${abs}) :\n${issues.join("\n")}`);
  }
  const cfg = parsed.data;
  if (process.env.CHROMIUM_PATH && !cfg.browser.executablePath) {
    cfg.browser.executablePath = process.env.CHROMIUM_PATH;
  }
  return cfg;
}
