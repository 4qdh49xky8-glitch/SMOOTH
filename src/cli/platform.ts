import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { findPlatform, loadCatalog, stateOf, topicLabel, type Catalog } from "../platforms/catalog.js";
import { EVIDENCE_DIR, EVIDENCE_MAX_AGE_DAYS, TOPICS, TOPIC_VALUES, isExpired, loadEvidence, validateEvidence, type Topic } from "../platforms/evidence.js";

export interface PlatformArgs {
  sub?: string;
  /** Plateforme (verify, template, history) ou fichier (check, add). */
  target?: string;
  topic?: string;
  json: boolean;
  evidenceDir?: string;
  catalog?: Catalog;
  now?: number;
}

const SOON_DAYS = 30;

const TOPIC_NEEDS: Record<Topic, string> = {
  automation:
    "Passage des conditions d'utilisation / CGV / règlement qui traite des robots, scripts et de l'automatisation. `channel` : api (API officielle autorisée) · browser (automatisation de l'interface autorisée) · both · human (rien d'automatisé). Le silence des conditions se note `human`.",
  api: `Documentation développeur officielle : existence d'une API et à qui elle est ouverte. \`value\` : ${TOPIC_VALUES.api.join(" | ")}.`,
  queue: `Page officielle sur la file d'attente / tirage au sort. \`value\` : ${TOPIC_VALUES.queue.join(" | ")}.`,
  limits: `Limites d'achat documentées (billets par commande/personne). \`value\` : ${TOPIC_VALUES.limits.join(" | ")} ; les chiffres vont dans \`note\`.`,
  cart: `Mécanisme officiel de réservation/panier. \`value\` : ${TOPIC_VALUES.cart.join(" | ")}.`,
};

const out = (s = ""): void => console.log(s);

/** Modèle de preuve à compléter : volontairement INVALIDE tant que chaque champ n'est pas rempli à partir de la page officielle. */
export function evidenceTemplate(platformId: string, topic: Topic = "automation"): Record<string, unknown> {
  return {
    platform: platformId,
    checkedAt: "AAAA-MM-JJ",
    source: { url: "https://… (page officielle, domaine de la plateforme)", title: "Titre de la page officielle" },
    ...(topic === "automation" ? { channel: "api | browser | both | human | prohibited" } : { topic, value: TOPIC_VALUES[topic as Exclude<Topic, "automation">].join(" | ") }),
    authorization: "Ce que la source autorise ou interdit, en une phrase.",
    excerpt: "Passage EXACT copié de la page officielle (≥ 30 caractères).",
    note: "facultatif",
  };
}

/**
 * `npm run platform <verify|template|check|add|history>` — gestion des preuves officielles.
 * Aucune sous-commande n'effectue de requête réseau : lire la page officielle est un acte humain ; ici on
 * dit exactement quoi consigner, on valide, et on calcule les statuts.
 */
export async function platformCommand(a: PlatformArgs): Promise<number> {
  const now = a.now ?? Date.now();
  const dir = a.evidenceDir ?? EVIDENCE_DIR;
  const catalog = a.catalog ?? loadCatalog({ evidenceDir: dir, now });

  switch (a.sub) {
    case "verify":
      return verify(catalog, a.target, a.json, now);
    case "history":
      return history(catalog, a.target, a.json, now);
    case "template": {
      if (!a.target || !findPlatform(catalog, a.target)) return fail(`Plateforme inconnue « ${a.target ?? ""} ». Voir : npm run platforms`);
      const topic = (a.topic ?? "automation") as Topic;
      if (!(TOPICS as readonly string[]).includes(topic)) return fail(`--topic ∈ ${TOPICS.join(" | ")}`);
      out(JSON.stringify(evidenceTemplate(a.target, topic), null, 2));
      return 0;
    }
    case "check":
      return check(catalog, dir, a.target, now);
    case "add":
      return add(catalog, dir, a.target, now);
    default:
      out(`Usage : npm run platform <sous-commande>
  verify [plateforme]       preuves nécessaires et informations manquantes (hors ligne)     npm run platform verify
  history <plateforme>      historique des vérifications (date, URL, source, canal, expiration, note)
  template <plateforme>     modèle de fichier de preuve à compléter (--topic automation|api|queue|limits|cart)
  check [fichier]           valide les preuves de ${EVIDENCE_DIR}/ (ou un fichier) : refuse l'invalide
  add <fichier>             valide puis range une preuve dans ${EVIDENCE_DIR}/ (refuse plus de ${EVIDENCE_MAX_AGE_DAYS} jours)
Aucune sous-commande ne contacte de site.`);
      return a.sub ? 1 : 0;
  }
}

function fail(msg: string): number {
  console.error(msg);
  return 1;
}

function verify(catalog: Catalog, id: string | undefined, json: boolean, now: number): number {
  const targets = id ? catalog.platforms.filter((p) => p.id === id) : catalog.platforms;
  if (id && targets.length === 0) return fail(`Plateforme inconnue « ${id} ». Voir : npm run platforms`);

  const report = targets.map((p) => ({ p, st: stateOf(catalog, p.id, now) }));
  if (json) {
    out(JSON.stringify({ evidenceMaxAgeDays: EVIDENCE_MAX_AGE_DAYS, network: "aucune requête effectuée", platforms: report.map(({ p, st }) => ({ id: p.id, status: st.status, expiresAt: st.expiresAt ?? null, officialHosts: p.officialHosts, missing: st.missing, conflicts: st.conflicts, unverifiedClues: p.clues.map((c) => c.url) })), rejectedEvidence: catalog.rejected }, null, 2));
    return 0;
  }

  if (!id) {
    out(`${"PLATEFORME".padEnd(22)}${"STATUT".padEnd(26)}${"EXPIRE LE".padEnd(12)}PREUVES MANQUANTES`);
    for (const { p, st } of report) {
      const blocking = st.missing.filter((m) => m.blocking).length;
      const info = st.missing.length - blocking;
      out(`${p.id.padEnd(22)}${st.status.padEnd(26)}${(st.expiresAt ?? "—").padEnd(12)}${blocking ? `${blocking} bloquante(s)` : "aucune bloquante"}, ${info} complémentaire(s)${st.expiresInDays !== undefined && st.expiresInDays <= SOON_DAYS ? `  ⚠ expire dans ${st.expiresInDays} j` : ""}`);
    }
    out("\nDétail d'une plateforme : npm run platform verify <plateforme>");
  } else {
    for (const { p, st } of report) {
      out(`══ ${p.id} — ${p.name}`);
      out(`Statut : ${st.status} — ${st.reasons.join("; ")}`);
      if (st.expiresAt) out(`Expire le ${st.expiresAt} (dans ${st.expiresInDays} j)${st.expiresInDays! <= SOON_DAYS ? " ⚠ à revérifier bientôt" : ""}`);
      for (const c of st.conflicts) out(`⚠ ${c}`);
      out(`Domaines officiels acceptés pour la source : ${p.officialHosts.join(", ")}`);
      out("\nPreuves à consigner :");
      for (const m of st.missing) out(`  ${m.blocking ? "✗ BLOQUANT" : "✗ complémentaire"}  ${m.topic} — ${topicLabel(m.topic)} : ${m.reason}\n      ${TOPIC_NEEDS[m.topic]}`);
      if (st.missing.length === 0) out("  ✓ toutes les preuves sont valides");
      out(`\nUn fichier par preuve : ${EVIDENCE_DIR}/${p.id}-AAAA-MM-JJ[-sujet].json avec platform, checkedAt, source.url (https, domaine officiel), source.title, channel ou value, authorization, excerpt (≥ 30 caractères).`);
      out(`Modèle : npm run platform template ${p.id}   ·   validation : npm run platform check   ·   dépôt : npm run platform add <fichier>`);
      if (p.clues.length) {
        out("\nPistes NON vérifiées à consulter en premier (pages officielles NON lues, ne comptent pour rien) :");
        for (const c of p.clues) out(`  - ${c.url}\n      ${c.note}`);
      }
      out();
    }
  }
  for (const r of catalog.rejected) out(`✗ preuve refusée ${r.file} : ${r.issues.map((i) => i.code).join(", ")} (npm run platform check)`);
  out("Cette commande n'effectue aucune requête réseau : elle ne contacte aucun site.");
  return 0;
}

function history(catalog: Catalog, id: string | undefined, json: boolean, now: number): number {
  if (!id || !findPlatform(catalog, id)) return fail(`Plateforme inconnue « ${id ?? ""} ». Voir : npm run platforms`);
  const st = stateOf(catalog, id, now);
  if (json) {
    out(JSON.stringify({ platform: id, status: st.status, history: st.history }, null, 2));
    return 0;
  }
  out(`${id} — ${st.status}`);
  if (st.history.length === 0) out("Aucun relevé. Voir : npm run platform verify " + id);
  for (const h of st.history) {
    out(`${h.checkedAt}  ${h.topic.padEnd(10)} ${(h.channel ?? h.value ?? "").padEnd(18)} ${h.expired ? "EXPIRÉE" : "valide "} jusqu'au ${h.expiresAt}\n    ${h.source} — ${h.url}\n    ${h.authorization}${h.note ? `\n    note : ${h.note}` : ""}  [${h.file}]`);
  }
  return 0;
}

function check(catalog: Catalog, dir: string, file: string | undefined, now: number): number {
  const platforms = catalog.platforms;
  const results: { file: string; ok: boolean; expired: boolean; issues: string[] }[] = [];
  if (file) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      return fail(`✗ ${file} : JSON illisible (${(e as Error).message})`);
    }
    const v = validateEvidence(raw, { platforms, now, allowExpired: true });
    results.push({ file, ok: !!v.record, expired: v.expired, issues: v.issues.map((i) => `${i.code} — ${i.message}`) });
  } else {
    const loaded = loadEvidence(dir, platforms, now);
    for (const r of loaded.records) results.push({ file: r.file, ok: true, expired: isExpired(r.checkedAt, now), issues: [] });
    for (const r of loaded.rejected) results.push({ file: r.file, ok: false, expired: false, issues: r.issues.map((i) => `${i.code} — ${i.message}`) });
  }
  for (const r of results) {
    out(`${!r.ok ? "✗" : r.expired ? "⚠" : "✓"} ${r.file}${r.expired ? "  (expirée : comptée pour l'historique, plus pour l'autorisation)" : ""}`);
    for (const i of r.issues) out(`    ${i}`);
  }
  if (results.length === 0) out(`Aucun fichier de preuve dans ${dir}/ : c'est normal tant qu'aucune page officielle n'a été consultée.`);
  const bad = results.filter((r) => !r.ok).length;
  out(`\n${results.length - bad}/${results.length} preuve(s) acceptée(s).`);
  return bad ? 1 : 0;
}

function add(catalog: Catalog, dir: string, file: string | undefined, now: number): number {
  if (!file) return fail("Usage : npm run platform add <fichier.json>");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return fail(`✗ ${file} : JSON illisible (${(e as Error).message})`);
  }
  const v = validateEvidence(raw, { platforms: catalog.platforms, now, allowExpired: false });
  if (!v.record) {
    out(`✗ Preuve REFUSÉE (${file}) :`);
    for (const i of v.issues) out(`    ${i.code} — ${i.message}`);
    return 1;
  }
  mkdirSync(dir, { recursive: true });
  const r = v.record;
  const name = `${r.platform}-${r.checkedAt}${r.topic === "automation" ? "" : `-${r.topic}`}.json`;
  const dest = join(dir, name);
  if (existsSync(dest)) return fail(`✗ ${dest} existe déjà : renommez le fichier ou supprimez l'ancien relevé (l'historique se conserve : un fichier par relevé).`);
  copyFileSync(file, dest);
  const st = stateOf({ ...catalog, evidence: [...catalog.evidence, { ...r, file: basename(dest) }] }, r.platform, now);
  out(`✓ Preuve enregistrée : ${dest}`);
  out(`Statut de ${r.platform} : ${st.status}${st.expiresAt ? ` (expire le ${st.expiresAt})` : ""}`);
  return 0;
}
