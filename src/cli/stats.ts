import { aggregate, loadRecords } from "../telemetry/Telemetry.js";

/** `npm run stats` : agrégats locaux sur les runs enregistrés (médiane, p95, taux de réussite, échecs). */
export function statsCommand(dir: string, opts: { json: boolean; mode?: string }): number {
  const records = loadRecords(dir).filter((r) => !opts.mode || r.mode === opts.mode);
  const agg = aggregate(records);
  if (opts.json) return console.log(JSON.stringify(agg, null, 2)), 0;
  if (!records.length) return console.log(`Aucun run enregistré dans ${dir}/ (télémétrie locale).`), 0;
  const f = (v: number | null): string => (v === null ? "—" : `${v} ms`);
  console.log(`Runs : ${agg.runs} · réussite ${agg.successRate === null ? "—" : Math.round(agg.successRate * 100)} %`);
  console.log(`États finaux : ${JSON.stringify(agg.finalStates)}`);
  if (Object.keys(agg.failureReasons).length) console.log(`Raisons d'échec : ${JSON.stringify(agg.failureReasons)}`);
  console.log(`Disponibilité  médiane ${f(agg.timeToAvailabilityMs.median)}  p95 ${f(agg.timeToAvailabilityMs.p95)}`);
  console.log(`Sélection      médiane ${f(agg.timeToSelectionMs.median)}  p95 ${f(agg.timeToSelectionMs.p95)}`);
  console.log(`Panier         médiane ${f(agg.timeToCartMs.median)}  p95 ${f(agg.timeToCartMs.p95)}`);
  const STAGES = ["browser_start", "page_ready", "availability_detected", "decision", "selection", "cart_request", "cart_confirmed"] as const;
  const med = (name: (typeof STAGES)[number]): number | null => {
    const v = records.flatMap((r) => (r.stagesMs?.[name] == null ? [] : [r.stagesMs[name]!])).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)]! : null;
  };
  console.log(`Étapes (médiane) : ${STAGES.map((n) => `${n} ${f(med(n))}`).join(" · ")}`);
  if (records.some((r) => r.mode === "simulation")) console.log("⚠ Les runs « simulation » mesurent un FAUX site : ces durées ne reflètent pas la vitesse d'un achat réel (filtrez avec --mode live).");
  console.log(`Tentatives     médiane ${agg.attempts.median ?? "—"}  max ${agg.attempts.max}`);
  return 0;
}
