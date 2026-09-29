/**
 * Horloge locale monotone (performance.now) recalée sur l'heure du serveur.
 * Date.now() peut sauter (NTP) ; performance.timeOrigin + performance.now() non.
 */
export class Clock {
  constructor(public offsetMs = 0) {}
  now(): number {
    return performance.timeOrigin + performance.now() + this.offsetMs;
  }
}

export interface OffsetEstimate {
  offsetMs: number;
  rttMs: number;
  samples: number;
}

/**
 * Estime (heure serveur − heure locale) avec la méthode NTP simplifiée :
 * on garde l'échantillon au plus petit aller-retour (offset = serveur − milieu du RTT).
 */
export async function estimateOffset(
  fetchServerTime: () => Promise<number>,
  samples = 7,
): Promise<OffsetEstimate> {
  let best: OffsetEstimate | null = null;
  for (let i = 0; i < samples; i++) {
    const t0 = performance.timeOrigin + performance.now();
    const server = await fetchServerTime();
    const t1 = performance.timeOrigin + performance.now();
    const rtt = t1 - t0;
    const offset = server - (t0 + t1) / 2;
    if (!best || rtt < best.rttMs) best = { offsetMs: offset, rttMs: rtt, samples };
  }
  return best ?? { offsetMs: 0, rttMs: 0, samples: 0 };
}

/**
 * Repli quand le site n'expose pas d'heure précise : en-tête HTTP Date (résolution 1 s,
 * donc précision ~±500 ms — insuffisant pour du fin réglage, à documenter côté adaptateur).
 */
export async function httpDateServerTime(url: string): Promise<number> {
  const res = await fetch(url, { method: "HEAD" });
  const date = res.headers.get("date");
  if (!date) throw new Error("En-tête Date absent");
  return Date.parse(date) + 500;
}
