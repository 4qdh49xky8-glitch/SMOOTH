import { buildCatalog, type Catalog, type Platform } from "../../src/platforms/catalog.js";
import type { EvidenceChannel, EvidenceRecord } from "../../src/platforms/evidence.js";
import type { AdapterMeta, SiteAdapter } from "../../src/sites/SiteAdapter.js";
import { FakeAdapter } from "./fakeAdapter.js";

/** Tout ce fichier ne manipule que des plateformes FICTIVES (*.example) : jamais une vraie plateforme, jamais une vraie preuve. */
export const DAY = 86_400_000;
export const TODAY = new Date().toISOString().slice(0, 10);
export const NOW = Date.parse(`${TODAY}T12:00:00Z`);
export const daysAgo = (n: number, now = NOW): string => new Date(now - n * DAY).toISOString().slice(0, 10);

export const plat = (id = "p", over: Partial<Platform> = {}): Platform => ({
  id, name: `Plateforme ${id}`, regions: ["FR"], eventTypes: ["concert"], officialHosts: [`${id}.example`], clues: [], allowedQueryParams: [], ...over,
});

/** Preuve d'automatisation (par défaut valide, du jour). */
export const ev = (platform: string, channel: EvidenceChannel, checkedAt = TODAY, over: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
  platform, checkedAt, source: { url: `https://www.${platform}.example/conditions`, title: "Conditions d'utilisation (FICTIVES)" },
  topic: "automation", channel, authorization: "Texte FICTIF de test décrivant ce que la source autorise.",
  excerpt: "Passage FICTIF de test, cité tel quel depuis la page officielle fictive.", file: `${platform}-${checkedAt}-${channel}.json`, ...over,
});
/** Preuve documentaire (api, queue, limits, cart). */
export const fact = (platform: string, topic: "api" | "queue" | "limits" | "cart", value: string, checkedAt = TODAY): EvidenceRecord =>
  ev(platform, "human", checkedAt, { topic, value, channel: undefined, file: `${platform}-${checkedAt}-${topic}.json` });

export const catalogWith = (platforms: Platform[], records: EvidenceRecord[] = []): Catalog => buildCatalog(platforms, records, []);

export function adapter(id: string, o: { platform?: string; channel?: "official-api" | "browser"; policy?: "official-api" | "permitted-by-terms" | "demo"; env?: string[] } = {}): FakeAdapter {
  const a = new FakeAdapter();
  const policy = o.policy ?? (o.channel === "official-api" ? "official-api" : "permitted-by-terms");
  a.meta = {
    ...a.meta, id, platform: o.platform, channel: o.channel,
    compliance: policy === "demo" ? a.meta.compliance : { policy, termsUrl: `https://www.${o.platform ?? id}.example/conditions`, reviewedAt: TODAY },
    capabilities: { ...a.meta.capabilities, officialApi: o.channel === "official-api" },
    requires: o.env ? { env: o.env } : undefined,
  } as AdapterMeta;
  return a;
}
export type { SiteAdapter };
