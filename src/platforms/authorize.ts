import type { AdapterMeta } from "../sites/SiteAdapter.js";
import { adapterVerdict, findPlatform, type AdapterVerdict, type Catalog } from "./catalog.js";

/** Canal technique d'un adaptateur : API officielle ou pilotage du navigateur. */
export const channelOf = (meta: AdapterMeta): "official-api" | "browser" => meta.channel ?? (meta.capabilities.officialApi ? "official-api" : "browser");

/** Identifiant de plateforme (entrée du catalogue) d'un adaptateur. */
export const platformOf = (meta: AdapterMeta): string => meta.platform ?? meta.id;

export interface Authorization {
  ok: boolean;
  reason?: string;
  verdict?: AdapterVerdict;
}

/**
 * Un adaptateur de démo est exempté (il est limité à localhost par assertCompliant). Tout autre adaptateur doit
 * correspondre à une plateforme du catalogue dont le verdict, déduit des PREUVES officielles, autorise son canal.
 */
export function authorizeAdapter(meta: AdapterMeta, catalog: Catalog, now = Date.now()): Authorization {
  if (meta.compliance.policy === "demo") return { ok: true };
  const platform = findPlatform(catalog, platformOf(meta));
  if (!platform) return { ok: false, reason: `plateforme « ${platformOf(meta)} » absente du catalogue (platforms/catalog.json)` };
  const { verdict, channels, reasons } = adapterVerdict(platform, now);
  const channel = channelOf(meta);
  if (!channels.includes(channel)) {
    return { ok: false, verdict, reason: `verdict de la plateforme « ${platform.id} » : ${verdict} (${reasons.join("; ")}) ; canal « ${channel} » non autorisé par les preuves` };
  }
  const policy = meta.compliance.policy;
  if ((channel === "official-api") !== (policy === "official-api")) {
    return { ok: false, verdict, reason: `meta.compliance.policy « ${policy} » incohérente avec le canal « ${channel} »` };
  }
  return { ok: true, verdict };
}

/** Version qui lève : garde-fou appliqué par le cœur avant toute action. */
export function assertAuthorized(meta: AdapterMeta, catalog: Catalog, now = Date.now()): void {
  const a = authorizeAdapter(meta, catalog, now);
  if (!a.ok) throw new Error(`Adaptateur « ${meta.id} » refusé : ${a.reason}`);
}
