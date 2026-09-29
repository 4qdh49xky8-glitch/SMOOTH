import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const LOG_LEVELS = ["silent", "error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Logger {
  readonly level: LogLevel;
  error(msg: string): void;
  warn(msg: string): void;
  info(msg: string): void;
  debug(msg: string): void;
  /** Logger préfixé par un périmètre : [AGENT], [SITE:example]… */
  child(scope: string): Logger;
}

export interface LoggerOptions {
  /** Défaut : variable LOG_LEVEL, sinon DEBUG=1 → debug, sinon info. */
  level?: LogLevel;
  /** Fichier de log (texte brut, horodatage ISO complet, sans couleurs). */
  file?: string;
  color?: boolean;
  scope?: string;
  /** Sortie alternative (tests) : remplace la console. */
  sink?: (level: Exclude<LogLevel, "silent">, line: string) => void;
}

export const parseLogLevel = (s: string | undefined): LogLevel | undefined => {
  const v = s?.toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(v ?? "") ? (v as LogLevel) : undefined;
};

const RANK: Record<LogLevel, number> = { silent: -1, error: 0, warn: 1, info: 2, debug: 3 };
const TAG = { error: "ERROR", warn: "WARN ", info: "INFO ", debug: "DEBUG" } as const;
const COLOR = { error: "\x1b[31m", warn: "\x1b[33m", info: "\x1b[0m", debug: "\x1b[2m" } as const;

/** Priorité : option --log-level > variable LOG_LEVEL > niveau du profil > info. */
export function pickLevel(flag: string | undefined, env: string | undefined, fromConfig?: LogLevel): LogLevel {
  return parseLogLevel(flag) ?? parseLogLevel(env) ?? fromConfig ?? "info";
}

export function resolveLevel(explicit?: LogLevel): LogLevel {
  return explicit ?? parseLogLevel(process.env.LOG_LEVEL) ?? (process.env.DEBUG === "1" ? "debug" : "info");
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = resolveLevel(opts.level);
  const color = opts.color ?? Boolean(process.stdout.isTTY);
  let fileReady = false;

  const emit = (lvl: Exclude<LogLevel, "silent">, scope: string | undefined, msg: string): void => {
    if (RANK[lvl] > RANK[level]) return;
    const tag = scope ? `[${scope}] ` : "";
    if (opts.file) {
      if (!fileReady) {
        mkdirSync(dirname(opts.file), { recursive: true });
        fileReady = true;
      }
      appendFileSync(opts.file, `${new Date().toISOString()} ${TAG[lvl]} ${tag}${msg}\n`);
    }
    const time = new Date().toISOString().slice(11, 23);
    const plain = `${time} ${TAG[lvl]} ${tag}${msg}`;
    if (opts.sink) return opts.sink(lvl, plain);
    const line = color ? `${COLOR[lvl]}${plain}\x1b[0m` : plain;
    (lvl === "error" || lvl === "warn" ? console.error : console.log)(line);
  };

  const make = (scope: string | undefined): Logger => ({
    level,
    error: (m) => emit("error", scope, m),
    warn: (m) => emit("warn", scope, m),
    info: (m) => emit("info", scope, m),
    debug: (m) => emit("debug", scope, m),
    child: (s) => make(scope ? `${scope}:${s}` : s),
  });
  return make(opts.scope);
}

/** Logger muet (tests, simulation silencieuse). */
export const silentLogger: Logger = createLogger({ level: "silent" });
