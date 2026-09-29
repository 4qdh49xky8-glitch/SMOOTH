import type { AdapterMeta } from "./SiteAdapter.js";

const MAX_AGE_DAYS = 180;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Le cœur n'exécute un adaptateur que s'il déclare une base d'autorisation (API officielle, CGU
 * autorisant l'outil, ou démo locale) relue récemment. Ce n'est PAS un avis juridique : c'est un
 * garde-fou qui force à décider explicitement, site par site, avant toute exécution.
 */
export function assertCompliant(meta: AdapterMeta, eventUrl: string, now = Date.now()): void {
  const c = meta.compliance;
  const fail = (why: string): never => {
    throw new Error(`Adaptateur « ${meta.id} » refusé : ${why}`);
  };
  if (!c) return fail("déclaration de conformité (meta.compliance) absente.");
  if (!["official-api", "permitted-by-terms", "demo"].includes(c.policy)) return fail(`policy inconnue « ${String(c.policy)} ».`);

  const host = new URL(eventUrl).hostname;
  if (c.policy === "demo") {
    if (!LOCAL_HOSTS.has(host)) fail(`un adaptateur de démo ne peut viser que localhost (reçu ${host}).`);
    return;
  }
  if (!/^https:\/\//.test(c.termsUrl)) fail("termsUrl (https) requis : indiquez la page des CGU/de l'API qui fonde l'autorisation.");
  const reviewed = Date.parse(c.reviewedAt);
  if (Number.isNaN(reviewed)) fail("reviewedAt (AAAA-MM-JJ) invalide.");
  const ageDays = (now - reviewed) / 86_400_000;
  if (ageDays < 0) fail("reviewedAt est dans le futur.");
  if (ageDays > MAX_AGE_DAYS) fail(`CGU relues il y a ${Math.floor(ageDays)} jours (> ${MAX_AGE_DAYS}) : relisez-les et mettez reviewedAt à jour.`);
}
