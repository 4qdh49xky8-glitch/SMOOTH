import type { SiteAdapter } from "./SiteAdapter.js";
import { ExampleSite } from "./ExampleSite.js";

/** Ajouter un site = créer un adaptateur + l'enregistrer ici. */
const adapters: Record<string, () => SiteAdapter> = {
  example: () => new ExampleSite(),
};

export function getAdapter(id: string): SiteAdapter {
  const make = adapters[id];
  if (!make) throw new Error(`Adaptateur inconnu : "${id}". Disponibles : ${Object.keys(adapters).join(", ")}`);
  return make();
}
