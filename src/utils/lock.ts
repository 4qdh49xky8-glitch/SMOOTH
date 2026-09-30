import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface EventLock {
  file: string;
  release(): void;
  /** Ce processus détient-il ENCORE le verrou ? (fichier présent, même PID et même instance) */
  verify(): boolean;
  /**
   * Maintient le verrou pendant une longue attente : réécrit (atomiquement) sa date de renouvellement, ce qui repousse sa péremption
   * (24 h sans renouvellement). Retourne false — sans rien écrire — si le verrou n'est plus détenu par cette instance.
   */
  renew(): boolean;
}

interface LockInfo {
  pid: number;
  instance: string;
  startedAt: string;
  /** Dernier renouvellement par le détenteur (attente longue) ; la péremption à 24 h se compte depuis cette date si elle existe. */
  renewedAt?: string;
  /** Heure de démarrage du processus (Linux : /proc/<pid>/stat) : distingue un PID réutilisé par un autre processus. */
  procStart?: string;
}

/** Heure de démarrage (en ticks depuis le boot) d'un processus, ou undefined si indisponible (autre OS, processus absent). */
export function processStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" "); // après « (comm) » : champ 3 = état
    return after[19]; // champ 22 de /proc/<pid>/stat
  } catch {
    return undefined;
  }
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

/** Identifiant d'un profil de navigateur (dossier utilisateur) : un profil = un seul bot à la fois, quel que soit l'événement. */
export function profileKey(userDataDir: string): string {
  return createHash("sha1").update(`profile|${resolve(userDataDir)}`).digest("hex").slice(0, 12);
}

/** Regroupe plusieurs verrous : libérés ensemble, vérifiés ensemble. */
export function combineLocks(...locks: EventLock[]): EventLock {
  return {
    file: locks.map((l) => l.file).join("+"),
    release: () => locks.forEach((l) => l.release()),
    verify: () => locks.every((l) => l.verify()),
    renew: () => locks.map((l) => l.renew()).every(Boolean),
  };
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
  const mine: LockInfo = { pid: process.pid, instance, startedAt: new Date().toISOString(), ...(processStart(process.pid) ? { procStart: processStart(process.pid) } : {}) };
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
      const verify = (): boolean => {
        try {
          const cur = JSON.parse(readFileSync(file, "utf8")) as LockInfo;
          return cur.pid === process.pid && cur.instance === instance && cur.startedAt === mine.startedAt;
        } catch {
          return false;
        }
      };
      const renew = (): boolean => {
        if (!verify()) return false;
        try {
          const tmp = `${file}.${process.pid}.tmp`;
          writeFileSync(tmp, JSON.stringify({ ...mine, renewedAt: new Date().toISOString() }));
          renameSync(tmp, file); // remplacement atomique : un lecteur ne voit jamais un fichier partiel
          return true;
        } catch {
          return false;
        }
      };
      return { file, release, verify, renew };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let other: LockInfo | null = null;
      try {
        other = JSON.parse(readFileSync(file, "utf8")) as LockInfo;
      } catch {
        /* verrou illisible : considéré orphelin */
      }
      // Périmé : trop ancien, OU le PID existe mais appartient à un AUTRE processus que celui qui a posé le verrou (PID réutilisé).
      const reused = !!other?.procStart && !!other.pid && processStart(other.pid) !== undefined && processStart(other.pid) !== other.procStart;
      const stale = !!other && (now - Date.parse(other.renewedAt ?? other.startedAt) > LOCK_MAX_AGE_MS || reused);
      if (held.has(file) || (other && !stale && other.pid !== process.pid && alive(other.pid))) {
        throw new Error(
          `Une autre instance (« ${other?.instance ?? "ce processus"} », PID ${other?.pid ?? process.pid}, démarrée ${other?.startedAt ?? "?"}) cible déjà cet événement. ` +
            "Le bot refuse deux sessions sur le même événement ou le même profil de navigateur (pas de multiplication de sessions ni de paniers).",
        );
      }
      rmSync(file, { force: true }); // verrou orphelin
    }
  }
  throw new Error("Impossible d'acquérir le verrou d'événement.");
}

export interface LockInspection {
  state: "free" | "held" | "stale";
  /** Détenteur (si verrou présent). */
  owner?: { instance: string; pid: number; startedAt: string };
}

/**
 * Lecture SEULE d'un verrou (aucune création, aucune suppression) : libre, détenu par un processus vivant, ou périmé (processus mort,
 * PID réutilisé, plus de 24 h, fichier illisible). Sert à `sale:check` : savoir si `run` serait refusé, sans rien réserver.
 */
export function inspectLock(key: string, dir = ".locks", now = Date.now()): LockInspection {
  const file = join(dir, `${key}.lock`);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { state: "free" };
  }
  let info: LockInfo | null = null;
  try {
    const parsed = JSON.parse(text) as LockInfo;
    if (parsed && typeof parsed.pid === "number" && typeof parsed.instance === "string" && typeof parsed.startedAt === "string") info = parsed;
  } catch {
    /* illisible : périmé */
  }
  if (!info) return { state: "stale" };
  const owner = { instance: info.instance, pid: info.pid, startedAt: info.startedAt };
  const reused = !!info.procStart && processStart(info.pid) !== undefined && processStart(info.pid) !== info.procStart;
  const old = now - Date.parse(info.renewedAt ?? info.startedAt) > LOCK_MAX_AGE_MS;
  if (held.has(file)) return { state: "held", owner };
  if (!old && !reused && info.pid !== process.pid && alive(info.pid)) return { state: "held", owner };
  return { state: "stale", owner };
}
