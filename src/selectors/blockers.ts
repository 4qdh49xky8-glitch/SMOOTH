import type { Page } from "playwright";
import type { Blocker } from "../sites/SiteAdapter.js";

/**
 * Détection (lecture seule) des situations où le bot doit céder la main à un humain ou s'arrêter.
 * Le bot ne clique jamais dans un CAPTCHA, ne contourne pas une file d'attente virtuelle
 * et ne tente pas de masquer son automatisation.
 *
 * Éviter les faux positifs : cette détection s'exécute à CHAQUE lecture de disponibilité. Les motifs textuels
 * ne s'appliquent donc qu'à des pages courtes (une salle d'attente est presque vide ; une page événement
 * qui mentionne « file d'attente » dans sa FAQ est longue) et les limites d'achat exigent une formulation
 * de limite ATTEINTE, pas une simple information (« limite de 4 billets par commande »).
 */
/**
 * Script exécuté DANS la page. `String.raw` + guillemets doubles côté page : aucune séquence d'échappement
 * (`\'`, `\d`) n'est interprétée par le gabarit TypeScript — une apostrophe mal échappée ferait échouer tout le
 * script, et l'erreur serait avalée (aucune détection). Le test « pages réelles » (tests/stress) verrouille ce point.
 */
export const BLOCKER_SCRIPT = String.raw`(() => {
  const q = (s) => document.querySelector(s);
  if (q("iframe[src*=recaptcha], iframe[src*=hcaptcha], iframe[src*=\"challenges.cloudflare.com\"], .g-recaptcha, .h-captcha, [data-testid=captcha]"))
    return { state: "CAPTCHA", message: "CAPTCHA affiché" };
  if (q("[data-testid=waiting-room], #waiting-room"))
    return { state: "QUEUE", message: "File d attente virtuelle" };
  const full = (document.body && document.body.innerText) || "";
  const t = full.slice(0, 3000).toLowerCase();
  const short = full.length < 1500;
  if (short && /(file d.attente|waiting room|you are in line|vous êtes dans la file|queue-it)/.test(t))
    return { state: "QUEUE", message: "File d attente virtuelle (texte détecté)" };
  if (/(vous avez atteint la limite|limite (d.achat|de billets|de \d+ billets?) (est )?atteinte|nombre maximum de billets (atteint|dépassé)|quantité maximale (atteinte|dépassée)|you have reached (the|your) (ticket|purchase) limit|(ticket|purchase) limit (has been )?reached|cannot add more tickets)/.test(t))
    return { state: "PURCHASE_LIMIT", message: "Limite d achat atteinte sur ce site" };
  if (short && /(are you a robot|êtes-vous un robot|vérification de sécurité|verify you are human|access denied|unusual traffic|trafic inhabituel)/.test(t))
    return { state: "BLOCKED", message: "Contrôle anti-bot / accès refusé" };
  return null;
})()`;

export async function detectCommonBlocker(page: Page): Promise<Blocker | null> {
  try {
    return (await page.evaluate(BLOCKER_SCRIPT)) as Blocker | null;
  } catch {
    return null; // navigation en cours : on réessaiera
  }
}
