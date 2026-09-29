export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

const c = { dim: "\x1b[2m", yellow: "\x1b[33m", red: "\x1b[31m", reset: "\x1b[0m" };

export function createLogger(debug = process.env.DEBUG === "1"): Logger {
  const stamp = (): string => new Date().toISOString().slice(11, 23);
  return {
    info: (m) => console.log(`${c.dim}${stamp()}${c.reset} ${m}`),
    warn: (m) => console.warn(`${c.dim}${stamp()}${c.reset} ${c.yellow}${m}${c.reset}`),
    error: (m) => console.error(`${c.dim}${stamp()}${c.reset} ${c.red}${m}${c.reset}`),
    debug: (m) => {
      if (debug) console.log(`${c.dim}${stamp()} ${m}${c.reset}`);
    },
  };
}
