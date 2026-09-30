import { pathToFileURL } from "node:url";
import { startFixtureSite, type FixtureSite, type FixtureState } from "../testkit/fixtureSite.js";

/**
 * Site de démonstration local (TEST_ONLY · NOT_A_REAL_PLATFORM) : le serveur de fixtures (testkit/fixtureSite.ts) avec le scénario
 * « nominal » ; pour les scénarios (file, CAPTCHA, limite d'achat…) voir docs/FIXTURES.md.
 */
export interface DemoOptions {
  port?: number;
  /** Epoch ms d'ouverture de la vente. */
  openAt: number;
  /** Simule une salle d'attente sur les PAGES pendant N ms après l'ouverture (test du passage de main). */
  queueMs?: number;
  /** La 1re tentative d'ajout au panier échoue (« déjà vendu ») : teste le repli sur l'offre suivante. */
  contention?: boolean;
}

export type DemoServer = FixtureSite & { state: FixtureState };

export function startDemoServer(opts: DemoOptions): Promise<DemoServer> {
  return startFixtureSite({ port: opts.port, openAt: opts.openAt, queueMs: opts.queueMs, contention: opts.contention });
}

// Lancement manuel : npm run demo:server -- [secondes avant ouverture] [--queue=8] [--contention]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const secs = Number(args.find((a) => /^\d+$/.test(a)) ?? 30);
  const queue = Number(args.find((a) => a.startsWith("--queue="))?.split("=")[1] ?? 0);
  const openAt = Math.ceil((Date.now() + secs * 1000) / 1000) * 1000;
  startDemoServer({ port: 4173, openAt, queueMs: queue * 1000, contention: args.includes("--contention") }).then((s) => {
    console.log(`Site démo : ${s.url}/event  (identifiants demo@example.com / demo)`);
    console.log(`Ouverture de la vente : ${new Date(openAt).toISOString()}  → saleTime à mettre dans la config : ${new Date(openAt).toISOString()}`);
  });
}
