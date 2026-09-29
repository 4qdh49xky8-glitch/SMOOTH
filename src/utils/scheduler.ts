import type { Clock } from "./clock.js";

const nextTick = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * Attend jusqu'à `targetEpochMs` (heure serveur via `clock`).
 * 1) setTimeout grossier par paliers (n'occupe pas le CPU) ;
 * 2) boucle setImmediate sur les derniers `spinThresholdMs` pour éviter la gigue des timers.
 * Retourne le dépassement en ms (≥ 0) : c'est la précision réellement obtenue.
 */
export async function waitUntil(
  targetEpochMs: number,
  clock: Clock,
  opts: { spinThresholdMs?: number; onTick?: (remainingMs: number) => void } = {},
): Promise<number> {
  const spin = opts.spinThresholdMs ?? 25;
  let lastTick = 0;
  for (;;) {
    const remaining = targetEpochMs - clock.now();
    if (remaining <= spin) break;
    if (opts.onTick && Date.now() - lastTick >= 1000) {
      lastTick = Date.now();
      opts.onTick(remaining);
    }
    // On dort au plus 1 s pour rester réactif à un recalage d'horloge.
    await new Promise((r) => setTimeout(r, Math.min(remaining - spin - 5, 1000)));
  }
  while (clock.now() < targetEpochMs) await nextTick();
  return Math.max(0, clock.now() - targetEpochMs);
}
