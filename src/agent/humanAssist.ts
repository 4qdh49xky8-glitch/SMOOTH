import { notify } from "../notifications/notify.js";
import type { Clock } from "../utils/clock.js";
import type { Logger } from "../utils/logger.js";
import { redact } from "../utils/redact.js";
import { waitUntil } from "../utils/scheduler.js";

export interface HumanAssistOptions {
  eventName: string;
  /** Adresse de l'événement, affichée telle que vous l'avez configurée (le bot n'y accède PAS). */
  eventUrl?: string;
  saleEpochMs: number;
  clock: Clock;
  log: Logger;
  /** Ce qui a conduit au canal humain (affiché). */
  reason: string;
  notifier?: typeof notify;
  /** Rappels avant l'ouverture, en ms (défaut : 10 min, 2 min, 30 s, ouverture). */
  remindersMs?: number[];
  quantity?: number;
  maxPricePerTicket?: number;
}

export interface HumanAssistResult {
  fired: number[];
}

/**
 * Canal « intervention humaine » : des rappels, RIEN d'autre. Le bot n'ouvre aucun navigateur, ne fait aucune
 * requête vers le site, ne se connecte à aucun compte : c'est vous qui achetez. Utilisable pour toute plateforme,
 * y compris celles dont les conditions interdisent l'automatisation (il n'y a alors aucune automatisation).
 */
export async function runHumanAssist(o: HumanAssistOptions): Promise<HumanAssistResult> {
  const send = o.notifier ?? notify;
  const reminders = [...(o.remindersMs ?? [600_000, 120_000, 30_000, 0])].sort((a, b) => b - a);
  const fired: number[] = [];
  const brief = [o.quantity ? `${o.quantity} billet(s)` : "", o.maxPricePerTicket ? `max ${o.maxPricePerTicket} € / billet` : ""].filter(Boolean).join(", ");
  o.log.info(`Canal humain (${o.reason}). Aucune action automatique : le bot ne contacte pas le site et ne pilote aucun navigateur.`);
  for (const r of reminders) {
    const at = o.saleEpochMs - r;
    if (at <= o.clock.now() && r !== 0) continue; // rappel déjà passé
    await waitUntil(at, o.clock, { spinThresholdMs: 5 });
    fired.push(r);
    const opening = r === 0;
    await send({
      title: opening ? "🎟️ OUVERTURE DE LA VENTE — à vous de jouer" : `⏰ Ouverture dans ${r >= 60_000 ? `${Math.round(r / 60_000)} min` : `${Math.round(r / 1000)} s`}`,
      message: redact(`${o.eventName}${brief ? ` — ${brief}` : ""}${o.eventUrl ? `\n${o.eventUrl}` : ""}\nAchat manuel : connectez-vous et ouvrez la page dès maintenant.`),
    });
  }
  return { fired };
}
