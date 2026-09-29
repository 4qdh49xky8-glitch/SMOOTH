import { readdirSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SiteAdapter } from "./SiteAdapter.js";

/** Fichiers de src/sites/ qui ne sont pas des adaptateurs. */
const NON_ADAPTERS = new Set(["SiteAdapter", "BaseSiteAdapter", "registry", "compliance", "contract"]);

/**
 * Découverte automatique : tout fichier `src/sites/<Nom>.ts` dont l'export par défaut est une classe
 * d'adaptateur (constructeur sans argument) est disponible. Ajouter un site = déposer UN fichier ;
 * ni le cœur, ni ce registre, ni la config ne sont modifiés.
 */
export interface AdapterEntry {
  adapter: SiteAdapter;
  /** Chemin du fichier source (utilisé par le contrôle de contrat). */
  file: string;
}

export async function discoverAdapterEntries(dir = dirname(fileURLToPath(import.meta.url))): Promise<AdapterEntry[]> {
  const files = readdirSync(dir).filter((f) => /\.(ts|js)$/.test(f) && !/\.d\.ts$/.test(f));
  const names = [...new Set(files.map((f) => basename(f, extname(f))))].filter((n) => !NON_ADAPTERS.has(n));
  const found: AdapterEntry[] = [];
  const seen = new Map<string, string>();
  for (const name of names) {
    const file = files.find((f) => basename(f, extname(f)) === name)!;
    const mod = (await import(pathToFileURL(join(dir, file)).href)) as { default?: new () => SiteAdapter };
    if (typeof mod.default !== "function") throw new Error(`${join(dir, file)} doit exporter par défaut une classe d'adaptateur.`);
    const adapter = new mod.default();
    const id = adapter.meta?.id;
    if (!id) throw new Error(`${join(dir, file)} : meta.id manquant.`);
    if (seen.has(id)) throw new Error(`Identifiant d'adaptateur en double « ${id} » (${seen.get(id)} et ${file}).`);
    seen.set(id, file);
    found.push({ adapter, file: join(dir, file) });
  }
  return found;
}

export async function discoverAdapters(dir?: string): Promise<SiteAdapter[]> {
  return (await discoverAdapterEntries(dir)).map((e) => e.adapter);
}

export async function getAdapter(id: string, dir?: string): Promise<SiteAdapter> {
  const all = await discoverAdapters(dir);
  const adapter = all.find((a) => a.meta.id === id);
  if (!adapter) {
    throw new Error(`Adaptateur inconnu : « ${id} ». Disponibles : ${all.map((a) => a.meta.id).join(", ") || "(aucun)"}`);
  }
  return adapter;
}
