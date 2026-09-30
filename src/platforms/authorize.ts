import type { BotConfig } from "../config/schema.js";
import type { AdapterAuthorization, AdapterMeta, SiteAdapter } from "../sites/SiteAdapter.js";
import { hostMatches } from "./evidence.js";
import { AUTHORIZATION_MODEL, STATUSES, findPlatform, stateOf, type Catalog, type PlatformStatus } from "./catalog.js";

/** Canal technique d'un adaptateur : API officielle ou pilotage du navigateur. */
export const channelOf = (meta: AdapterMeta): "official-api" | "browser" => meta.channel ?? (meta.capabilities.officialApi ? "official-api" : "browser");

/** Identifiant de plateforme (entrée du catalogue) d'un adaptateur. */
export const platformOf = (meta: AdapterMeta): string => meta.platform ?? meta.id;

/**
 * Déclaration d'autorisation d'un adaptateur (lecture de `meta`) : de quelle plateforme il dépend et quels STATUTS de cette
 * plateforme autorisent son canal (déduits du modèle figé). Ce n'est pas une autorisation : c'est ce que l'adaptateur EXIGE ;
 * seule la preuve (catalogue) peut le satisfaire. Un adaptateur de test (demo) n'exige aucune preuve et reste limité à localhost.
 */
export function authorizationOf(meta: AdapterMeta): AdapterAuthorization {
  const channel = channelOf(meta);
  const demo = meta.compliance.policy === "demo";
  return {
    platform: platformOf(meta),
    channel,
    policy: meta.compliance.policy,
    evidenceRequired: !demo,
    requiresStatus: demo ? [] : STATUSES.filter((s) => (channel === "official-api" ? AUTHORIZATION_MODEL[s].api : AUTHORIZATION_MODEL[s].browser)),
  };
}

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

const LOCAL = ["127.0.0.1", "localhost", "::1", "[::1]"];

/**
 * Autorisation → hôte autorisé → adaptateur → réseau. Aucune configuration utilisateur ne doit mener au réseau sans passer ici :
 * l'URL de l'événement ET chaque hôte déclaré par l'adaptateur doivent appartenir aux domaines officiels de la plateforme
 * (catalogue), ou, pour l'adaptateur de démonstration, à la boucle locale.
 */
export function platformHosts(meta: AdapterMeta, catalog: Catalog): string[] {
  if (meta.compliance.policy === "demo") return LOCAL;
  return findPlatform(catalog, platformOf(meta))?.officialHosts ?? [];
}

export function assertNetworkAllowed(adapter: SiteAdapter, config: BotConfig, catalog: Catalog): void {
  const hosts = platformHosts(adapter.meta, catalog);
  const check = (what: string, raw: string): void => {
    let ok = false;
    try {
      const u = new URL(raw);
      ok = (u.protocol === "https:" || (adapter.meta.compliance.policy === "demo" && u.protocol === "http:")) && hostMatches(raw, hosts);
    } catch {
      ok = false;
    }
    if (!ok) throw new Error(`Adaptateur « ${adapter.meta.id} » refusé : ${what} hors des domaines autorisés pour « ${platformOf(adapter.meta)} » (${hosts.join(", ") || "aucun"}) — aucune requête n'a été émise`);
  };
  check("l'URL de l'événement", adapter.resolveEventUrl(config));
  for (const h of adapter.allowedHosts(config)) check(`l'hôte « ${h} »`, `https://${h}/`);
}
