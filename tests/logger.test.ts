import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLogger, parseLogLevel, pickLevel, type LogLevel } from "../src/utils/logger.js";

const capture = (level: LogLevel, scope?: string) => {
  const lines: string[] = [];
  const log = createLogger({ level, scope, sink: (_l, line) => lines.push(line) });
  return { log, lines };
};
const emitAll = (log: ReturnType<typeof createLogger>): void => {
  log.error("e");
  log.warn("w");
  log.info("i");
  log.debug("d");
};

test("niveaux ERROR / WARN / INFO / DEBUG : chaque niveau inclut les plus graves", () => {
  const expected: Record<LogLevel, string[]> = { silent: [], error: ["ERROR"], warn: ["ERROR", "WARN"], info: ["ERROR", "WARN", "INFO"], debug: ["ERROR", "WARN", "INFO", "DEBUG"] };
  for (const [level, tags] of Object.entries(expected) as [LogLevel, string[]][]) {
    const { log, lines } = capture(level);
    emitAll(log);
    assert.deepEqual(lines.map((l) => l.split(/\s+/)[1]), tags, level);
  }
});

test("format clair : heure, niveau aligné, périmètre imbriqué", () => {
  const { log, lines } = capture("info", "agent");
  log.child("sim").info("bonjour");
  assert.match(lines[0]!, /^\d{2}:\d{2}:\d{2}\.\d{3} INFO  \[agent:sim\] bonjour$/);
});

test("analyse du niveau et fichier de log en texte brut", () => {
  assert.equal(parseLogLevel("DEBUG"), "debug");
  assert.equal(parseLogLevel("bavard"), undefined);
  const file = join(mkdtempSync(join(tmpdir(), "log-")), "sub", "bot.log");
  const log = createLogger({ level: "info", file, sink: () => undefined });
  log.info("écrit");
  log.debug("ignoré");
  const text = readFileSync(file, "utf8");
  assert.match(text, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z INFO  écrit\n$/);
  assert.ok(!text.includes("\x1b"));
});

test("priorité du niveau : option > variable LOG_LEVEL > profil > info", () => {
  assert.equal(pickLevel("debug", "error", "warn"), "debug");
  assert.equal(pickLevel(undefined, "error", "warn"), "error");
  assert.equal(pickLevel(undefined, undefined, "warn"), "warn");
  assert.equal(pickLevel(undefined, undefined, undefined), "info");
  assert.equal(pickLevel("n'importe quoi", "debug", "warn"), "debug"); // valeur invalide ignorée
});
