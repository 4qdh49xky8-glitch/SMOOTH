import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * AUDIT réseau : les commandes hors ligne ne font AUCUNE requête. Chaque commande tourne dans son propre processus, avec le
 * préchargement `tests/setup/noNetwork.ts` (NET_AUDIT=1) qui compte toute tentative de connexion (externe, locale) et tout appel
 * à `fetch`, et qui fait échouer toute connexion externe.
 */
const COMMANDS: string[][] = [
  ["doctor"], ["doctor", "--json"], ["platforms"], ["platforms", "--json"], ["platforms", "--check"], ["platforms", "--hosts"], ["platforms", "--markdown"],
  ["platform", "verify"], ["platform", "verify", "eventim"], ["platform", "history", "eventim"], ["platform", "template", "eventim"], ["platform", "check"],
  ["validate", "--all"], ["validate", "concert"], ["sites"], ["profiles"], ["stats"], ["simulate", "--scenario", "nominal"], ["simulate", "--scenario", "captcha"],
  ["sale", "check", "--config", "config/sale.example.yaml"], ["sale", "check", "--config", "config/sale.example.yaml", "--json"], ["sale", "check", "--config", "config/sale.example.yaml", "--human"],
  ["help"],
];
const audit = (args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, ["--import", "tsx", "--import", "./tests/setup/noNetwork.ts", "src/index.ts", ...args], {
    encoding: "utf8", env: { ...process.env, NET_AUDIT: "1", CHROMIUM_PATH: process.env.CHROMIUM_PATH ?? "", ...env }, timeout: 120_000,
  });

for (const args of COMMANDS) {
  test(`hors ligne : « ${args.join(" ")} » → zéro connexion (externe ou locale), zéro fetch`, () => {
    const r = audit(args);
    const m = /NET_AUDIT external=(\d+) loopback=(\d+) fetch=(\d+)/.exec(r.stderr);
    assert.ok(m, `compteur absent :\n${r.stderr}`);
    assert.deepEqual([m[1], m[2], m[3]], ["0", "0", "0"], r.stderr);
    assert.ok(r.status === 0 || args[0] === "help" || args[0] === "doctor" || args[0] === "sale", `code de sortie ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.ok(!/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|Tentative de connexion réseau externe/.test(r.stdout + r.stderr));
  });
}

test("le garde-fou lui-même fonctionne : une connexion externe fait échouer le processus et est comptée (sinon les zéros ci-dessus ne prouveraient rien)", () => {
  const dir = mkdtempSync(join(tmpdir(), "net-"));
  const script = join(dir, "probe.mjs");
  writeFileSync(script, `import net from "node:net";\ntry { net.connect(443, "example.org"); } catch (e) { console.log("BLOQUÉ: " + e.message); }\nawait fetch("http://127.0.0.1:9/").catch(() => {});\n`);
  const r = spawnSync(process.execPath, ["--import", "./tests/setup/noNetwork.ts", script], { encoding: "utf8", env: { ...process.env, NET_AUDIT: "1" } });
  assert.match(r.stdout, /BLOQUÉ: Tentative de connexion réseau externe/);
  assert.match(r.stderr, /NET_AUDIT external=1 loopback=\d+ fetch=1/);
});

test("`npm test` s'exécute avec le garde-fou réseau préchargé", () => {
  const pkg = JSON.parse(require_fs().readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  assert.match(pkg.scripts.test!, /--import \.\/tests\/setup\/noNetwork\.ts/);
});
function require_fs(): typeof import("node:fs") {
  return process.getBuiltinModule("node:fs");
}
