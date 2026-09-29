import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { BotConfig } from "../config/schema.js";
import type { Logger } from "../utils/logger.js";

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** Port CDP réellement utilisé et profil Chromium de CETTE instance. */
  port: number;
  userDataDir: string;
  /** Se déconnecte SANS fermer Chromium : la fenêtre reste ouverte pour reprise manuelle. */
  detach(): Promise<void>;
  /** Ferme aussi Chromium (démo/tests). */
  shutdown(): Promise<void>;
}

async function cdpReady(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

const ACTIVE_PORT_FILE = "DevToolsActivePort";

/** Chromium écrit son port de debug dans le profil : c'est la référence pour retrouver CE navigateur-là. */
function readActivePort(dir: string): number | null {
  try {
    const n = Number(readFileSync(join(dir, ACTIVE_PORT_FILE), "utf8").split("\n")[0]);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Profil Chromium par défaut d'une instance : un navigateur par profil de configuration, jamais partagé. */
export const defaultUserDataDir = (instance: string): string => join(".profile", instance.replace(/[^\w.-]/g, "_"));

/**
 * Chromium est lancé comme processus INDÉPENDANT avec un port de debug (CDP), puis Playwright s'y
 * connecte. Avantages : (1) le navigateur survit au bot → vous payez à la main dans la même fenêtre, même
 * session ; (2) profil persistant = votre login est conservé ; (3) accès CDP direct.
 *
 * Isolation des instances : chaque profil (`userDataDir`) a SON navigateur et son port (choisi automatiquement
 * et relu dans le profil). Deux bots ne partagent donc jamais ni onglet, ni cookies, ni garde-fous réseau.
 * Aucune option d'invisibilité/anti-détection n'est utilisée volontairement.
 */
export async function openBrowser(config: BotConfig, log: Logger, o: { userDataDir: string }): Promise<BrowserSession> {
  const { headless, debugPort, executablePath } = config.browser;
  const dir = resolve(o.userDataDir);
  mkdirSync(dir, { recursive: true });
  let child: ChildProcess | undefined;
  let port = 0;

  const known = readActivePort(dir);
  if (debugPort > 0 && known !== debugPort && (await cdpReady(debugPort))) {
    throw new Error(`Le port ${debugPort} est déjà utilisé par un autre navigateur (un autre profil). Utilisez debugPort: 0 (automatique) pour éviter tout partage.`);
  }
  const candidate = debugPort > 0 ? debugPort : known;
  if (candidate && (await cdpReady(candidate))) {
    port = candidate;
    log.info(`Chromium de ce profil déjà lancé (port ${port}) : réutilisation.`);
  } else {
    rmSync(join(dir, ACTIVE_PORT_FILE), { force: true }); // port périmé d'un navigateur fermé
    const args = [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${dir}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Le navigateur ne doit pas ralentir ses timers quand la fenêtre est en arrière-plan.
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--window-size=1366,900",
      ...(headless ? ["--headless=new"] : []),
      ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
      "about:blank",
    ];
    const exe = executablePath ?? chromium.executablePath();
    log.info(`Lancement de Chromium (${exe}) — profil ${o.userDataDir}`);
    child = spawn(exe, args, { detached: true, stdio: "ignore" });
    child.unref();
    child.on("error", (e) => log.error(`Chromium : ${e.message}`));
    for (let i = 0; i < 200 && !port; i++) {
      const p = debugPort > 0 ? debugPort : readActivePort(dir);
      if (p && (await cdpReady(p))) port = p;
      else await new Promise((r) => setTimeout(r, 50));
    }
    if (!port) throw new Error("Chromium n'a pas ouvert le port de debug à temps.");
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const existing = context.pages().find((p) => p.url() === "about:blank" || p.url().startsWith("chrome://newtab"));
  const page = existing ?? (await context.newPage());
  page.setDefaultTimeout(config.timing.actionTimeoutMs);

  return {
    browser,
    context,
    page,
    port,
    userDataDir: dir,
    detach: async () => {
      await browser.close().catch(() => undefined); // connectOverCDP : simple déconnexion
    },
    shutdown: async () => {
      await browser.close().catch(() => undefined);
      if (child?.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          /* déjà arrêté */
        }
      }
    },
  };
}
