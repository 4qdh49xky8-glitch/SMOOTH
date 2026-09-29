import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { BotConfig } from "../config/schema.js";
import type { Logger } from "../utils/logger.js";

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
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

/**
 * Chromium est lancé comme processus INDÉPENDANT avec un port de debug (CDP), puis Playwright s'y
 * connecte. Avantages : (1) le navigateur survit au bot → vous payez à la main dans la même
 * fenêtre, même session ; (2) profil persistant = votre login est conservé ; (3) accès CDP direct.
 * Aucune option d'invisibilité/anti-détection n'est utilisée volontairement.
 */
export async function openBrowser(config: BotConfig, log: Logger): Promise<BrowserSession> {
  const { headless, userDataDir, debugPort, executablePath } = config.browser;
  let child: ChildProcess | undefined;

  if (await cdpReady(debugPort)) {
    log.info(`Chromium déjà lancé sur le port ${debugPort} : réutilisation.`);
  } else {
    const dir = resolve(userDataDir);
    mkdirSync(dir, { recursive: true });
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
    log.info(`Lancement de Chromium (${exe})`);
    child = spawn(exe, args, { detached: true, stdio: "ignore" });
    child.unref();
    child.on("error", (e) => log.error(`Chromium : ${e.message}`));
    for (let i = 0; i < 200 && !(await cdpReady(debugPort)); i++) await new Promise((r) => setTimeout(r, 50));
    if (!(await cdpReady(debugPort))) throw new Error("Chromium n'a pas ouvert le port de debug à temps.");
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const existing = context.pages().find((p) => p.url() === "about:blank" || p.url().startsWith("chrome://newtab"));
  const page = existing ?? (await context.newPage());
  page.setDefaultTimeout(config.timing.actionTimeoutMs);

  return {
    browser,
    context,
    page,
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
