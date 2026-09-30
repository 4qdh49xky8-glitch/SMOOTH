import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface EventLock {
  file: string;
  release(): void;
}

interface LockInfo {
  pid: number;
  instance: string;
  startedAt: string;
}

/**
 * Un run dure quelques minutes ; un verrou de plus de 24 h est périmé même si son PID existe encore (PID réutilisé après
 * un crash ou un redémarrage du conteneur) : sans cette borne, un verrou orphelin pourrait bloquer l'événement pour toujours.
 */
export const LOCK_MAX_AGE_MS = 24 * 3600_000;

/** Verrous détenus par CE processus : une seconde acquisition dans le même processus est refusée aussi. */
const held = new Set<string>();

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // existe mais appartient à un autre utilisateur
  }
};

/** Identifiant stable d'un événement : adaptateur + hôte + chemin (sans paramètres d'URL). */
export function eventKey(siteId: string, eventUrl: string): string {
  const u = new URL(eventUrl);
  return createHash("sha1").update(`${siteId}|${u.origin}${u.pathname}`).digest("hex").slice(0, 12);
}

/**
 * Un seul bot par événement à la fois. Deux instances sur des événements DIFFÉRENTS sont possibles
 * (navigateur, profil, logs et télémétrie séparés) ; deux instances sur le MÊME événement sont refusées :
 * elles multiplieraient les sessions et les paniers, ce que la plateforme s'interdit (limites d'achat).
 * Un verrou orphelin (processus mort) est récupéré automatiquement.
 */
export function acquireEventLock(key: string, instance: string, dir = ".locks", now = Date.now()): EventLock {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${key}.lock`);
  const mine: LockInfo = { pid: process.pid, instance, startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, JSON.stringify(mine), { flag: "wx" }); // création atomique
      held.add(file);
      const release = (): void => {
        held.delete(file);
        try {
          if ((JSON.parse(readFileSync(file, "utf8")) as LockInfo).pid === process.pid) rmSync(file, { force: true });
        } catch {
          /* déjà libéré */
        }
      };
      process.once("exit", release);
      return { file, release };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let other: LockInfo | null = null;
      try {
        other = JSON.parse(readFileSync(file, "utf8")) as LockInfo;
      } catch {
        /* verrou illisible : considéré orphelin */
      }
      const stale = !!other && now - Date.parse(other.startedAt) > LOCK_MAX_AGE_MS;
      if (held.has(file) || (other && !stale && other.pid !== process.pid && alive(other.pid))) {
        throw new Error(
          `Une autre instance (« ${other?.instance ?? "ce processus"} », PID ${other?.pid ?? process.pid}, démarrée ${other?.startedAt ?? "?"}) cible déjà cet événement. ` +
            "Le bot refuse deux sessions sur le même événement (pas de multiplication de sessions ni de paniers).",
        );
      }
      rmSync(file, { force: true }); // verrou orphelin
    }
  }
  throw new Error("Impossible d'acquérir le verrou d'événement.");
}
