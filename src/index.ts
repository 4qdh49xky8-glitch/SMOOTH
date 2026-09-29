import "dotenv/config";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Agent } from "./agent/Agent.js";
import { ClaudeAssistant } from "./agent/claude.js";
import { installPaymentGuard } from "./browser/guards.js";
import { traceSlowRequests, tuneNetwork } from "./browser/cdp.js";
import { openBrowser } from "./browser/launch.js";
import { loadConfig } from "./config/load.js";
import { SelectorResolver } from "./selectors/resolver.js";
import { getAdapter } from "./sites/registry.js";
import type { AdapterContext } from "./sites/SiteAdapter.js";
import { Clock } from "./utils/clock.js";
import { createLogger } from "./utils/logger.js";
import { waitForEnter } from "./utils/prompt.js";

const USAGE = `Usage : tsx src/index.ts <commande> [--config config/event.json] [--trace] [--exit-when-done]
  run     Lance l'agent (attend l'ouverture, met au panier, s'arrête)
  login   Ouvre le navigateur sur le site pour vous connecter à la main (profil conservé)
  check   Valide la config et mesure le décalage d'horloge avec le site`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string", default: "config/event.json" },
      trace: { type: "boolean", default: false },
      "exit-when-done": { type: "boolean", default: false },
    },
  });
  const command = positionals[0];
  if (!command || !["run", "login", "check"].includes(command)) {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }

  const log = createLogger();
  const config = loadConfig(values.config!);
  const adapter = getAdapter(config.site);
  const session = await openBrowser(config, log);
  const ctx: AdapterContext = {
    config,
    context: session.context,
    page: session.page,
    log,
    env: process.env,
    selectors: new SelectorResolver(adapter.id),
  };

  if (command === "login") {
    await session.page.goto(adapter.resolveEventUrl(config));
    log.info("Connectez-vous dans la fenêtre. Le profil (cookies) est conservé pour les prochains runs.");
    await waitForEnter("Appuyez sur Entrée quand vous êtes connecté.").promise;
    await session.detach();
    return;
  }

  if (command === "check") {
    const { estimateOffset } = await import("./utils/clock.js");
    log.info(`Configuration valide. Ouverture : ${config.saleTime} (dans ${((Date.parse(config.saleTime) - Date.now()) / 60000).toFixed(1)} min)`);
    if (adapter.getServerTime) {
      const est = await estimateOffset(() => adapter.getServerTime!(ctx));
      log.info(`Décalage d'horloge serveur : ${est.offsetMs.toFixed(1)} ms, RTT min ${est.rttMs.toFixed(1)} ms`);
    } else {
      log.info("Cet adaptateur n'expose pas d'heure serveur précise (repli sur l'en-tête Date, ±500 ms).");
    }
    await session.detach();
    return;
  }

  // run
  const releaseGuard = await installPaymentGuard(session.context, adapter.paymentUrlPatterns, log, () => undefined);
  const tuning = await tuneNetwork(session.context, session.page, config.browser, log);
  if (values.trace) traceSlowRequests(session.page, log);

  const agent = new Agent({
    config,
    adapter,
    ctx,
    claude: new ClaudeAssistant(config.claude, log),
    log,
    clock: new Clock(),
    onFinish: async () => {
      await releaseGuard(); // le paiement manuel redevient possible
      await tuning.release(); // images/polices de nouveau chargées
    },
  });

  try {
    const result = await agent.run();
    if (result.status === "in-cart" || result.status === "ready-not-added") {
      log.info("Le navigateur reste ouvert : vérifiez le panier et payez vous-même. Le bot s'arrête ici.");
    }
    if (values["exit-when-done"]) await session.shutdown();
    else await session.detach();
  } catch (err) {
    log.error((err as Error).message);
    await session.detach();
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
