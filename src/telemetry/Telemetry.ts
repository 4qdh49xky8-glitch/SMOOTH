import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { FailureReason, State } from "../agent/states.js";
import { redact } from "../utils/redact.js";
import type { Clock } from "../utils/clock.js";

/**
 * Télémétrie 100 % locale (un fichier JSON par run dans `runs/`, jamais envoyé nulle part).
 * Données collectées : identifiant d'adaptateur, états, durées, compteurs, catégorie/prix des offres
 * tentées, quantité/total du panier. JAMAIS : identifiants, cookies, e-mail, nom du compte, URLs,
 * contenu des pages, numéros de siège, ni texte libre non assaini.
 */
export const TELEMETRY_SCHEMA_VERSION = 1;

export interface AttemptRecord {
  n: number;
  category?: string;
  pricePerTicket?: number;
  outcome: "cart" | "selected" | "unavailable" | "error";
  reason?: FailureReason;
  durationMs: number;
}

export interface TelemetryRecord {
  schemaVersion: number;
  startedAt: string;
  mode: "live" | "simulation";
  site: string;
  profile?: string;
  status: string;
  finalState: State;
  failureReason?: FailureReason;
  metrics: {
    timeToAvailabilityMs: number | null;
    timeToSelectionMs: number | null;
    timeToCartMs: number | null;
    attempts: number;
    humanHandoffs: number;
    polls: number;
    pollLatencyMs: { avg: number; p95: number } | null;
    triggerOvershootMs: number | null;
    clockOffsetMs: number | null;
    clockRttMs: number | null;
  };
  states: { state: State; tMs: number; detail?: string }[];
  attemptsDetail: AttemptRecord[];
  timeline: { name: string; tMs: number }[];
  cart?: { itemCount: number; totalPrice: number; currency: string };
}

/** Retire URLs, e-mails, clés, cartes et longues suites de chiffres d'un texte libre, puis le tronque. */
export function sanitize(text: string, max = 160): string {
  return redact(text, { urls: "drop", minDigits: 6, tokens: true }).slice(0, max);
}

const round = (n: number): number => Math.round(n * 10) / 10;

export interface TelemetryOptions {
  clock: Clock;
  saleEpochMs: number;
  mode: "live" | "simulation";
  site: string;
  profile?: string;
  enabled: boolean;
  dir: string;
}

export class Telemetry {
  private readonly startedAt = new Date().toISOString();
  private marks: { name: string; at: number }[] = [];
  private states: TelemetryRecord["states"] = [];
  private attempts: AttemptRecord[] = [];
  private pollDurations: number[] = [];
  private handoffs = 0;
  private overshoot: number | null = null;
  private clockInfo: { offsetMs: number; rttMs: number } | null = null;

  constructor(private readonly o: TelemetryOptions) {}

  private t(): number {
    return this.o.clock.now() - this.o.saleEpochMs;
  }
  mark(name: string): void {
    this.marks.push({ name, at: this.o.clock.now() });
  }
  hasMark(name: string): boolean {
    return this.marks.some((m) => m.name === name);
  }
  state(state: State, detail?: string): void {
    this.states.push({ state, tMs: round(this.t()), ...(detail ? { detail: sanitize(detail, 80) } : {}) });
  }
  attempt(a: Omit<AttemptRecord, "n">): void {
    this.attempts.push({ n: this.attempts.length + 1, ...a, durationMs: round(a.durationMs) });
  }
  poll(durationMs: number): void {
    this.pollDurations.push(durationMs);
  }
  handoff(): void {
    this.handoffs++;
  }
  setOvershoot(ms: number): void {
    this.overshoot = round(ms);
  }
  setClock(offsetMs: number, rttMs: number): void {
    this.clockInfo = { offsetMs: round(offsetMs), rttMs: round(rttMs) };
  }
  get attemptCount(): number {
    return this.attempts.length;
  }

  private at(name: string, which: "first" | "last"): number | null {
    const list = this.marks.filter((m) => m.name === name);
    const m = which === "first" ? list[0] : list[list.length - 1];
    return m ? m.at : null;
  }

  finalize(f: Pick<TelemetryRecord, "status" | "finalState" | "failureReason" | "cart">): TelemetryRecord {
    const sale = this.o.saleEpochMs;
    const detected = this.at("availability-detected", "first");
    const selected = this.at("offer-selected", "last");
    const added = this.at("added-to-cart", "last");
    const sorted = [...this.pollDurations].sort((a, b) => a - b);
    return {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      startedAt: this.startedAt,
      mode: this.o.mode,
      site: this.o.site,
      ...(this.o.profile ? { profile: this.o.profile } : {}),
      ...f,
      metrics: {
        timeToAvailabilityMs: detected === null ? null : round(detected - sale),
        timeToSelectionMs: selected === null || detected === null ? null : round(selected - detected),
        timeToCartMs: added === null ? null : round(added - sale),
        attempts: this.attempts.length,
        humanHandoffs: this.handoffs,
        polls: this.pollDurations.length,
        pollLatencyMs: sorted.length
          ? {
              avg: round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
              p95: round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!),
            }
          : null,
        triggerOvershootMs: this.overshoot,
        clockOffsetMs: this.clockInfo?.offsetMs ?? null,
        clockRttMs: this.clockInfo?.rttMs ?? null,
      },
      states: this.states,
      attemptsDetail: this.attempts,
      timeline: this.marks.map((m) => ({ name: m.name, tMs: round(m.at - sale) })),
    };
  }

  /** Écrit l'enregistrement si la télémétrie est activée. Retourne le chemin, ou null. */
  save(record: TelemetryRecord): string | null {
    if (!this.o.enabled) return null;
    mkdirSync(this.o.dir, { recursive: true });
    const file = join(this.o.dir, `run-${this.startedAt.replace(/[:.]/g, "-")}-${record.mode}-${randomBytes(3).toString("hex")}.json`);
    writeFileSync(file, JSON.stringify(record, null, 2));
    return file;
  }
}

export function loadRecords(dir: string): TelemetryRecord[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith("run-") && f.endsWith(".json"))
      .flatMap((f) => {
        try {
          const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as TelemetryRecord;
          return r.schemaVersion === TELEMETRY_SCHEMA_VERSION ? [r] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

const pct = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return round(s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]!);
};

/** Agrégats simples sur plusieurs runs (médiane, p95, taux de réussite, raisons d'échec). */
export function aggregate(records: TelemetryRecord[]) {
  const pick = (f: (r: TelemetryRecord) => number | null): number[] => records.flatMap((r) => (f(r) === null ? [] : [f(r)!]));
  const count = <T extends string>(xs: T[]): Record<string, number> => xs.reduce<Record<string, number>>((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {});
  return {
    runs: records.length,
    successRate: records.length ? round(records.filter((r) => r.finalState === "CART_SUCCESS").length / records.length) : null,
    finalStates: count(records.map((r) => r.finalState)),
    failureReasons: count(records.flatMap((r) => (r.failureReason ? [r.failureReason] : []))),
    timeToAvailabilityMs: { median: pct(pick((r) => r.metrics.timeToAvailabilityMs), 0.5), p95: pct(pick((r) => r.metrics.timeToAvailabilityMs), 0.95) },
    timeToSelectionMs: { median: pct(pick((r) => r.metrics.timeToSelectionMs), 0.5), p95: pct(pick((r) => r.metrics.timeToSelectionMs), 0.95) },
    timeToCartMs: { median: pct(pick((r) => r.metrics.timeToCartMs), 0.5), p95: pct(pick((r) => r.metrics.timeToCartMs), 0.95) },
    attempts: { median: pct(pick((r) => r.metrics.attempts), 0.5), max: Math.max(0, ...pick((r) => r.metrics.attempts)) },
  };
}
