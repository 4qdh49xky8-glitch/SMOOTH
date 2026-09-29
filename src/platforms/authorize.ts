import type { AdapterMeta } from "../sites/SiteAdapter.js";
import { findPlatform, stateOf, type Catalog, type PlatformStatus } from "./catalog.js";

/** Canal technique d'un adaptateur : API officielle ou pilotage du navigateur. */
export const channelOf = (meta: AdapterMeta): "official-api" | "browser" => meta.channel ?? (meta.capabilities.officialApi ? "official-api" : "browser");

/** Identifiant de plateforme (entrée du catalogue) d'un adaptateur. */
export const platformOf = (meta: AdapterMeta): string => meta.platform ?? meta.id;

export interface Authorization {
  ok: boolean;
  reason?: string;
  status?: PlatformStatus;
}

/**
 * Un adaptateur de démo est exempté (il est limité à localhost par assertCompliant). Tout autre adaptateur doit
 * correspondre à une plateforme dont le STATUT, déduit des PREUVES officielles valides et non expirées, autorise
 * son canal. NOT_VERIFIED, EXPIRED et NOT_ALLOWED ne l'autorisent jamais.
 */
export function authorizeAdapter(meta: AdapterMeta, catalog: Catalog, now = Date.now()): Authorization {
  if (meta.compliance.policy === "demo") return { ok: true };
  const platform = findPlatform(catalog, platformOf(meta));
  if (!platform) return { ok: false, reason: `plateforme « ${platformOf(meta)} » absente du catalogue (platforms/catalog.json)` };
  const st = stateOf(catalog, platform.id, now);
  const channel = channelOf(meta);
  if (!st.channels.includes(channel)) {
    return { ok: false, status: st.status, reason: `statut de la plateforme « ${platform.id} » : ${st.status} (${st.reasons.join("; ")}) ; canal « ${channel} » non autorisé par les preuves` };
  }
  const policy = meta.compliance.policy;
  if ((channel === "official-api") !== (policy === "official-api")) {
    return { ok: false, status: st.status, reason: `meta.compliance.policy « ${policy} » incohérente avec le canal « ${channel} »` };
  }
  return { ok: true, status: st.status };
}

/** Version qui lève : garde-fou appliqué par le cœur avant toute action. */
export function assertAuthorized(meta: AdapterMeta, catalog: Catalog, now = Date.now()): void {
  const a = authorizeAdapter(meta, catalog, now);
  if (!a.ok) throw new Error(`Adaptateur « ${meta.id} » refusé : ${a.reason}`);
}
