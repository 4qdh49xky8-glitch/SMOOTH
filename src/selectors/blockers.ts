import type { Page } from "playwright";
import type { Blocker } from "../sites/SiteAdapter.js";

/**
 * Détection (lecture seule) des situations où le bot doit céder la main à un humain.
 * Le bot ne clique jamais dans un CAPTCHA, ne contourne pas une file d'attente virtuelle
 * et ne tente pas de masquer son automatisation.
 */
const SCRIPT = `(() => {
  const q = (s) => document.querySelector(s);
  if (q('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], .g-recaptcha, .h-captcha, [data-testid="captcha"]'))
    return { kind: 'captcha', message: 'CAPTCHA affiché' };
  if (q('[data-testid="waiting-room"], #waiting-room'))
    return { kind: 'queue', message: 'File d\\'attente virtuelle' };
  const t = (document.body && document.body.innerText || '').slice(0, 3000).toLowerCase();
  if (/(file d.attente|waiting room|you are in line|vous êtes dans la file|queue-it)/.test(t))
    return { kind: 'queue', message: 'File d\\'attente virtuelle (texte détecté)' };
  if (/(are you a robot|êtes-vous un robot|vérification de sécurité|verify you are human|access denied|unusual traffic|trafic inhabituel)/.test(t))
    return { kind: 'anti-bot', message: 'Contrôle anti-bot / accès refusé' };
  return null;
})()`;

export async function detectCommonBlocker(page: Page): Promise<Blocker | null> {
  try {
    return (await page.evaluate(SCRIPT)) as Blocker | null;
  } catch {
    return null; // navigation en cours : on réessaiera
  }
}
