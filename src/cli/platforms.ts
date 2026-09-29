import { checkCatalogIntegrity, adapterVerdict, loadCatalog, type Platform } from "../platforms/catalog.js";
import { discoverAdapters } from "../sites/registry.js";
import { channelOf, platformOf } from "../platforms/authorize.js";

const LABEL: Record<string, string> = {
  unknown: "NON VÉRIFIÉ",
  none: "aucune",
  "read-only": "lecture seule",
  "partner-only": "partenaires",
  "open-transactional": "ouverte",
  prohibited: "INTERDITE",
  "not-addressed": "non traitée",
  "permitted-interface": "permise (interface)",
  "permitted-api": "permise (API)",
  "permitted-both": "permise (int.+API)",
  "official-queue": "file officielle",
  lottery: "tirage au sort",
  documented: "documentées",
  "not-documented": "non documentées",
  "official-api": "API officielle",
  "web-only": "web seulement",
};
const VERDICT: Record<string, string> = {
  NON_VERIFIE: "NON VÉRIFIÉ",
  NON_AUTORISE: "NON AUTORISÉ",
  API_FIRST: "API-first",
  BROWSER: "adaptateur navigateur",
  MANUEL_SEULEMENT: "manuel seulement",
};
const cell = (f: { status: string }): string => LABEL[f.status] ?? f.status;

/** `npm run platforms` : tableau interne des plateformes candidates, dérivé UNIQUEMENT des preuves consignées. */
export async function platformsCommand(opts: { json: boolean; check: boolean; hosts: boolean; markdown?: boolean }): Promise<number> {
  const catalog = loadCatalog();
  const adapters = await discoverAdapters();
  const rows = catalog.platforms.map((p: Platform) => {
    const v = adapterVerdict(p);
    const mine = adapters.filter((a) => platformOf(a.meta) === p.id).map((a) => `${a.meta.id}(${channelOf(a.meta)})`);
    return { p, v, mine };
  });

  if (opts.hosts) {
    const hosts = [...new Set(catalog.platforms.flatMap((p) => p.officialHosts))].sort();
    console.log(hosts.join("\n"));
    return 0;
  }
  if (opts.markdown) {
    const md = (s: string): string => s.replace(/\|/g, "\\|");
    const src = (p: Platform): string => [...new Set([p.officialApi, p.automation, p.queue, p.purchaseLimits, p.cart].flatMap((f) => (f.evidence ? [f.evidence.url] : [])))].join(" ") || "—";
    console.log("| Plateforme | Types d'événements | API officielle | Automatisation autorisée/documentée | File d'attente | Limites d'achat | Adaptateur techniquement envisageable | Source officielle | Date de vérification |");
    console.log("|---|---|---|---|---|---|---|---|---|");
    for (const { p, v } of rows)
      console.log(`| ${md(p.name)} | ${p.eventTypes.join(", ")} | ${cell(p.officialApi)} | ${cell(p.automation)} | ${cell(p.queue)} | ${cell(p.purchaseLimits)} | ${VERDICT[v.verdict]} | ${md(src(p))} | ${p.verification.verifiedAt ?? "—"} |`);
    return 0;
  }
  if (opts.json) {
    console.log(JSON.stringify(rows.map(({ p, v, mine }) => ({ id: p.id, name: p.name, eventTypes: p.eventTypes, officialApi: p.officialApi.status, automation: p.automation.status, queue: p.queue.status, purchaseLimits: p.purchaseLimits.status, verdict: v.verdict, reasons: v.reasons, verifiedAt: p.verification.verifiedAt ?? null, sources: [p.officialApi, p.automation, p.queue, p.purchaseLimits, p.cart].flatMap((f) => (f.evidence ? [f.evidence.url] : [])), adapters: mine, clues: p.clues.length })), null, 2));
  } else {
    const pad = (s: string, n: number): string => s.padEnd(n);
    console.log(`${pad("PLATEFORME", 22)}${pad("TYPES", 44)}${pad("API OFFICIELLE", 16)}${pad("AUTOMATISATION", 20)}${pad("FILE", 16)}${pad("LIMITES", 16)}${pad("ADAPTATEUR", 24)}VÉRIFIÉ LE`);
    for (const { p, v, mine } of rows) {
      console.log(`${pad(p.id, 22)}${pad(p.eventTypes.join(","), 44)}${pad(cell(p.officialApi), 16)}${pad(cell(p.automation), 20)}${pad(cell(p.queue), 16)}${pad(cell(p.purchaseLimits), 16)}${pad(VERDICT[v.verdict]!, 24)}${p.verification.verifiedAt ?? "—"}${mine.length ? `   ← ${mine.join(", ")}` : ""}`);
    }
    const nv = rows.filter((r) => r.v.verdict === "NON_VERIFIE").length;
    console.log(`\n${rows.length} plateformes — ordre alphabétique, aucun classement. ${nv} non vérifiée(s) : le cœur n'automatise rien pour elles (canal humain seulement).`);
    console.log("Un verdict ne se déduit que de preuves officielles datées : voir docs/PLATFORMS.md (protocole de vérification).");
  }
  if (opts.check) {
    const problems = checkCatalogIntegrity(catalog);
    // Un adaptateur exécutable ne peut exister que pour une plateforme dont le verdict l'autorise.
    for (const a of adapters.filter((x) => x.meta.compliance.policy !== "demo")) {
      const row = rows.find((r) => r.p.id === platformOf(a.meta));
      if (!row) problems.push(`adaptateur « ${a.meta.id} » : plateforme absente du catalogue`);
      else if (!["API_FIRST", "BROWSER"].includes(row.v.verdict)) problems.push(`adaptateur « ${a.meta.id} » : verdict ${row.v.verdict} — aucun adaptateur ne doit exister pour cette plateforme`);
    }
    for (const x of problems) console.error(`✗ ${x}`);
    if (!problems.length) console.log("✓ catalogue cohérent");
    return problems.length ? 1 : 0;
  }
  return 0;
}
