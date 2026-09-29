import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigSchema, type BotConfig } from "./schema.js";

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

export function loadConfig(path: string): BotConfig {
  const abs = resolve(path);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    throw new Error(`Impossible de lire la configuration ${abs} : ${(err as Error).message}`);
  }
  const parsed = ConfigSchema.safeParse(migrateLegacyConfig(raw));
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
