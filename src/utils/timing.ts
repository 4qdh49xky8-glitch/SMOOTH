import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "./clock.js";

/** Marque les étapes clés et calcule les délais par rapport à l'heure officielle. */
export class LatencyTracker {
  private marks: { name: string; at: number }[] = [];
  constructor(
    private readonly clock: Clock,
    private readonly saleEpochMs: number,
  ) {}

  mark(name: string): void {
    this.marks.push({ name, at: this.clock.now() });
  }

  report(): { name: string; sinceSaleMs: number; sincePreviousMs: number }[] {
    let prev = this.saleEpochMs;
    return this.marks.map((m) => {
      const row = { name: m.name, sinceSaleMs: round(m.at - this.saleEpochMs), sincePreviousMs: round(m.at - prev) };
      prev = m.at;
      return row;
    });
  }

  format(): string {
    return this.report()
      .map((r) => `  ${r.name.padEnd(16)} T+${String(r.sinceSaleMs).padStart(7)} ms   (Δ ${r.sincePreviousMs} ms)`)
      .join("\n");
  }

  save(dir = "runs", extra: Record<string, unknown> = {}): string {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify({ ...extra, timeline: this.report() }, null, 2));
    return file;
  }
}

const round = (n: number): number => Math.round(n * 10) / 10;
