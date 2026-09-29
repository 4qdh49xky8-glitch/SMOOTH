import { channelOf, platformOf } from "../platforms/authorize.js";
import { checkCatalogIntegrity, loadCatalog, stateOf, type Catalog, type Platform, type PlatformState } from "../platforms/catalog.js";
import { EVIDENCE_MAX_AGE_DAYS } from "../platforms/evidence.js";
import { discoverAdapters } from "../sites/registry.js";

export const EXPORT_SCHEMA_VERSION = 2;

const FACT_LABEL: Record<string, string> = {
  none: "aucune", "read-only": "lecture seule", "partner-only": "partenaires", "open-transactional": "ouverte",
  "official-queue": "file officielle", lottery: "tirage au sort", documented: "documentées", "not-documented": "non documentées",
  "official-api": "API officielle", "web-only": "web seulement",
};
const factCell = (st: PlatformState, k: "api" | "queue" | "limits" | "cart"): string => {
  const f = st.facts[k];
  return f ? `${FACT_LABEL[f.value] ?? f.value}${f.expired ? " (expiré)" : ""}` : "NON VÉRIFIÉ";
};
const channelsCell = (st: PlatformState): string => (st.channels.length ? st.channels.map((c) => (c === "official-api" ? "api" : "browser")).join("+") : "—");

/** Export complet, stable et versionné : pensé pour d'autres outils (tableaux de bord, CI, scripts). */
export function exportCatalog(catalog: Catalog, adapters: { id: string; platform: string; channel: string }[], now = Date.now()) {
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    generatedAt: new Date(now).toISOString(),
    evidenceMaxAgeDays: EVIDENCE_MAX_AGE_DAYS,
    statuses: ["NOT_VERIFIED", "VERIFIED_API", "VERIFIED_BROWSER", "VERIFIED_API_AND_BROWSER", "NOT_ALLOWED", "EXPIRED"],
    platforms: catalog.platforms.map((p: Platform) => {
      const st = stateOf(catalog, p.id, now);
      return {
        id: p.id, name: p.name, regions: p.regions, eventTypes: p.eventTypes, officialHosts: p.officialHosts,
        status: st.status,
        allowedChannels: st.channels,
        expiresAt: st.expiresAt ?? null,
        expiresInDays: st.expiresInDays ?? null,
        facts: st.facts,
        history: st.history.map(({ checkedAt, url, source, topic, channel, value, authorization, expiresAt, expired, note, file }) => ({ checkedAt, url, source, topic, channel: channel ?? null, value: value ?? null, authorization, expiresAt, expired, note: note ?? null, file })),
        missing: st.missing,
        conflicts: st.conflicts,
        adapters: adapters.filter((a) => a.platform === p.id).map((a) => ({ id: a.id, channel: a.channel })),
        unverifiedClues: p.clues.map((c) => ({ url: c.url, note: c.note })),
      };
    }),
    rejectedEvidence: catalog.rejected.map((r) => ({ file: r.file, issues: r.issues })),
  };
}

/** `npm run platforms` : tableau interne des plateformes candidates, dérivé UNIQUEMENT des preuves consignées. */
export async function platformsCommand(opts: { json: boolean; check: boolean; hosts: boolean; markdown?: boolean }, catalog: Catalog = loadCatalog()): Promise<number> {
  const adapters = await discoverAdapters();
  const adapterRefs = adapters.map((a) => ({ id: a.meta.id, platform: platformOf(a.meta), channel: channelOf(a.meta) }));
  const rows = catalog.platforms.map((p) => ({ p, st: stateOf(catalog, p.id), mine: adapterRefs.filter((a) => a.platform === p.id) }));

  if (opts.hosts) {
    console.log([...new Set(catalog.platforms.flatMap((p) => p.officialHosts))].sort().join("\n"));
    return 0;
  }
  if (opts.markdown) {
    const md = (s: string): string => s.replace(/\|/g, "\\|");
    console.log("| Plateforme | Types d'événements | API officielle | Automatisation autorisée/documentée | File d'attente | Limites d'achat | Statut | Canaux autorisés | Source officielle | Vérifié le | Expire le |");
    console.log("|---|---|---|---|---|---|---|---|---|---|---|");
    for (const { p, st } of rows) {
      const auto = st.history.find((h) => h.topic === "automation" && !h.expired) ?? st.history.find((h) => h.topic === "automation");
      console.log(`| ${md(p.name)} | ${p.eventTypes.join(", ")} | ${factCell(st, "api")} | ${auto ? `${auto.channel}${auto.expired ? " (expiré)" : ""}` : "NON VÉRIFIÉ"} | ${factCell(st, "queue")} | ${factCell(st, "limits")} | ${st.status} | ${channelsCell(st)} | ${auto ? md(auto.url) : "—"} | ${auto?.checkedAt ?? "—"} | ${st.expiresAt ?? "—"} |`);
    }
  } else if (opts.json) {
    console.log(JSON.stringify(exportCatalog(catalog, adapterRefs), null, 2));
  } else {
    const pad = (s: string, n: number): string => s.padEnd(n);
    console.log(`${pad("PLATEFORME", 22)}${pad("TYPES", 44)}${pad("STATUT", 26)}${pad("CANAUX", 12)}${pad("API", 14)}${pad("FILE", 16)}${pad("LIMITES", 16)}${pad("EXPIRE LE", 12)}`);
    for (const { p, st, mine } of rows) {
      console.log(`${pad(p.id, 22)}${pad(p.eventTypes.join(","), 44)}${pad(st.status, 26)}${pad(channelsCell(st), 12)}${pad(factCell(st, "api"), 14)}${pad(factCell(st, "queue"), 16)}${pad(factCell(st, "limits"), 16)}${pad(st.expiresAt ?? "—", 12)}${mine.length ? `← ${mine.map((m) => `${m.id}(${m.channel})`).join(", ")}` : ""}`);
    }
    const count = (s: string): number => rows.filter((r) => r.st.status === s).length;
    console.log(`\n${rows.length} plateformes — ordre alphabétique, aucun classement. NOT_VERIFIED : ${count("NOT_VERIFIED")} · EXPIRED : ${count("EXPIRED")} · NOT_ALLOWED : ${count("NOT_ALLOWED")} · VERIFIED_* : ${rows.filter((r) => r.st.status.startsWith("VERIFIED")).length}`);
    console.log("Seules les preuves officielles de platforms/evidence/ décident ; sans preuve valide, le cœur n'automatise rien (canal humain).");
    console.log("Détail et pièces manquantes : npm run platform verify [plateforme]");
    if (catalog.rejected.length) console.log(`⚠ ${catalog.rejected.length} fichier(s) de preuve REFUSÉ(S) : npm run platform check`);
  }

  if (opts.check) {
    const problems = checkCatalogIntegrity(catalog);
    // Un adaptateur exécutable ne peut exister que pour une plateforme dont les preuves autorisent son canal.
    for (const a of adapters.filter((x) => x.meta.compliance.policy !== "demo")) {
      const row = rows.find((r) => r.p.id === platformOf(a.meta));
      if (!row) problems.push(`adaptateur « ${a.meta.id} » : plateforme absente du catalogue`);
      else if (!row.st.channels.includes(channelOf(a.meta))) problems.push(`adaptateur « ${a.meta.id} » : statut ${row.st.status} — canal « ${channelOf(a.meta)} » non autorisé par les preuves`);
    }
    for (const x of problems) console.error(`✗ ${x}`);
    if (!problems.length) console.log("✓ catalogue cohérent");
    return problems.length ? 1 : 0;
  }
  return 0;
}
