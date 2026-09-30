/**
 * Préchargé par `npm test` (--import) : toute connexion réseau NON locale (hors boucle locale / sockets Unix) fait ÉCHOUER
 * le test qui l'a tentée, et est comptée. Les tests doivent donc rester exécutables sans réseau.
 */
import dns from "node:dns";
import net from "node:net";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "0.0.0.0", "::", "[::1]"]);

export const externalAttempts: string[] = [];
let loopbackAttempts = 0;
let fetchCalls = 0;
const g = globalThis as { __externalNetAttempts?: string[] };
g.__externalNetAttempts = externalAttempts;

const realFetch = globalThis.fetch;
globalThis.fetch = ((...a: Parameters<typeof fetch>) => {
  fetchCalls++;
  return realFetch(...a);
}) as typeof fetch;

const isLocal = (host: unknown): boolean => typeof host !== "string" || host === "" || LOOPBACK.has(host.toLowerCase());
const block = (target: string): never => {
  externalAttempts.push(target);
  throw new Error(`Tentative de connexion réseau externe interdite pendant les tests : ${target}`);
};

const connect = net.Socket.prototype.connect as (...a: unknown[]) => net.Socket;
net.Socket.prototype.connect = function patched(this: net.Socket, ...args: unknown[]): net.Socket {
  const a = args[0];
  if (a && typeof a === "object" && !("path" in (a as object))) {
    const o = a as { host?: string; port?: number };
    if (!isLocal(o.host)) block(`${o.host}:${o.port}`);
    loopbackAttempts++;
  } else if (typeof a === "number" && !isLocal(typeof args[1] === "string" ? args[1] : undefined)) {
    block(`${String(args[1])}:${a}`);
  }
  return connect.apply(this, args);
} as typeof net.Socket.prototype.connect;

const lookup = dns.lookup as (...a: unknown[]) => unknown;
(dns as { lookup: unknown }).lookup = (host: string, ...rest: unknown[]): unknown => {
  if (!isLocal(host)) block(`dns:${host}`);
  return lookup(host, ...rest);
};

/** NET_AUDIT=1 : compte toutes les tentatives réseau du processus et l'affiche à la sortie (vérification « zéro requête » des commandes hors ligne). */
if (process.env.NET_AUDIT === "1") {
  process.on("exit", () => process.stderr.write(`NET_AUDIT external=${externalAttempts.length} loopback=${loopbackAttempts} fetch=${fetchCalls}\n`));
}
