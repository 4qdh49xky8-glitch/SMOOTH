import { runInstantSale, type InstantSaleDeps } from "../instant/runner.js";
import { saleWaitCommand, type SaleWaitArgs, type SaleWaitDeps } from "./sale.js";

/**
 * `npm run sale:instant -- --config <fichier>` — INSTANT-ON-SALE (docs/INSTANT.md).
 *
 * Réutilise INTÉGRALEMENT `sale:wait` (inchangé) pour toute la phase d'avant-vente : évaluation complète (autorisation, canal, preuve et
 * son expiration, hôtes, secrets, verrou, configuration), prise des MÊMES verrous que `run`, attente locale réévaluée (aucune requête),
 * dernière évaluation juste avant le premier contact. La remise au lancement appelle alors `InstantSaleRunner` (au lieu de `run`), qui
 * reprend les verrous déjà détenus. Aucune option `--force` n'existe ; le mode humain n'est pas disponible ici (rien à automatiser).
 */
export async function saleInstantCommand(a: SaleWaitArgs, d: { wait?: SaleWaitDeps; runner?: InstantSaleDeps; live?: InstantSaleDeps } = {}): Promise<number> {
  const print = d.wait?.print ?? ((l: string) => console.log(l));
  if (a.human) {
    print("SALE INSTANT : le mode humain n'a rien à automatiser — utilisez `sale:wait --human` (rappels seulement). Refusé.");
    return 1;
  }
  return saleWaitCommand(a, {
    ...d.wait,
    live: d.wait?.live ?? d.live,
    run: async (lo, ld) => {
      const r = await runInstantSale({ target: lo.target ?? a.target ?? "", exitWhenDone: a.exitWhenDone, logLevel: a.logLevel, logFile: a.logFile }, { ...(d.runner ?? {}), ...(ld ?? {}), print });
      return r.code;
    },
  });
}
