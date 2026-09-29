import type { BotConfig } from "../config/schema.js";
import { authorizeAdapter, channelOf, platformOf } from "../platforms/authorize.js";
import { adapterVerdict, findPlatform, type AdapterVerdict, type Catalog } from "../platforms/catalog.js";
import type { SiteAdapter } from "../sites/SiteAdapter.js";

export type Channel = "official-api" | "browser" | "human";

export interface Rejection {
  adapter: string;
  channel: Channel;
  reason: string;
}

export interface ChannelDecision {
  channel: Channel;
  /** Adaptateur retenu (absent pour le canal humain). */
  adapter?: SiteAdapter;
  /** Verdict du catalogue pour la plateforme (absent si la plateforme n'y figure pas). */
  verdict?: AdapterVerdict;
  /** Candidats écartés et pourquoi : la décision est toujours explicable. */
  rejected: Rejection[];
  reasons: string[];
}

export interface ResolveOptions {
  /** Valeur de config.site : identifiant de plateforme (ou d'adaptateur). */
  platform: string;
  adapters: SiteAdapter[];
  catalog: Catalog;
  env: NodeJS.ProcessEnv;
  config: Pick<BotConfig, "channel">;
  now?: number;
}

const ORDER: Channel[] = ["official-api", "browser", "human"];

/**
 * Choisit le canal SELON CE QUE LES ADAPTATEURS DÉCLARENT et CE QUE LE CATALOGUE AUTORISE :
 *   API officielle  →  navigateur  →  intervention humaine.
 * Le cœur ne connaît aucun site : il lit uniquement `meta` (canal, prérequis, conformité) et le catalogue.
 *
 * Règles :
 *  - un adaptateur n'est retenu que si `authorizeAdapter` l'accepte (preuve officielle, verdict compatible) ;
 *  - un adaptateur « API » exige ses variables d'environnement (clé d'API) ; sans elles on passe au canal suivant ;
 *  - faute de canal automatisé autorisé, on retombe sur l'humain (rappels, sans aucun contact avec le site) ;
 *  - un canal forcé (`channel` ≠ auto) ne peut PAS être plus permissif : s'il n'est pas disponible, c'est une erreur.
 */
export function resolveChannel(o: ResolveOptions): ChannelDecision {
  const now = o.now ?? Date.now();
  const candidates = o.adapters.filter((a) => platformOf(a.meta) === o.platform || a.meta.id === o.platform);
  const platform = findPlatform(o.catalog, o.platform);
  const verdict = platform ? adapterVerdict(platform, now).verdict : undefined;
  const rejected: Rejection[] = [];
  const order = o.config.channel === "auto" ? ORDER : [o.config.channel];

  for (const channel of order) {
    if (channel === "human") {
      const why = candidates.length === 0 ? "aucun adaptateur pour cette plateforme" : rejected.length ? "aucun canal automatisé disponible et autorisé" : "canal humain demandé";
      return { channel: "human", verdict, rejected, reasons: [why] };
    }
    for (const adapter of candidates.filter((a) => channelOf(a.meta) === channel)) {
      const auth = authorizeAdapter(adapter.meta, o.catalog, now);
      if (!auth.ok) {
        rejected.push({ adapter: adapter.meta.id, channel, reason: auth.reason ?? "non autorisé" });
        continue;
      }
      const missing = (adapter.meta.requires?.env ?? []).filter((k) => !o.env[k]);
      if (missing.length) {
        rejected.push({ adapter: adapter.meta.id, channel, reason: `variable(s) d'environnement manquante(s) : ${missing.join(", ")}` });
        continue;
      }
      return { channel, adapter, verdict, rejected, reasons: [`adaptateur « ${adapter.meta.id} » autorisé (${auth.verdict ?? "démo"})`] };
    }
  }
  // Canal forcé indisponible : jamais de repli silencieux vers plus permissif.
  const detail = rejected.length ? rejected.map((r) => `${r.adapter} (${r.channel}) : ${r.reason}`).join(" ; ") : "aucun adaptateur déclaré pour ce canal";
  throw new Error(`Canal « ${o.config.channel} » indisponible pour « ${o.platform} » : ${detail}`);
}
