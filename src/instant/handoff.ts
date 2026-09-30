import type { Timeline } from "./timeline.js";

/**
 * Passage de main CART_SUCCESS → utilisateur (couche au-dessus du cœur gelé).
 * Ne fait AUCUNE navigation, n'ouvre AUCUN onglet, n'appelle PAS Claude, ne lit AUCUN champ de paiement et ne paie JAMAIS :
 * il ramène au premier plan la page déjà ouverte, affiche l'état et mesure les deux durées demandées.
 * Le panier a déjà été revérifié par le cœur (`result.cart`) : aucune requête supplémentaire n'est émise ici.
 */
export interface HandoffPage {
  bringToFront?: () => Promise<unknown>;
}

export const HANDOFF_BANNER = ["CART_SUCCESS", "PAYMENT_REQUIRED", "PAYMENT_MANUAL"] as const;

export interface HandoffResult {
  cartSuccessToUiReadyMs: number | null;
  uiReadyToUserControlMs: number | null;
}

export async function handOffToUser(
  page: HandoffPage | undefined,
  timeline: Timeline,
  print: (line: string) => void,
): Promise<HandoffResult> {
  // UI prête : page existante au premier plan (promesse résolue ou page sans cette méthode).
  await page?.bringToFront?.().catch(() => undefined);
  timeline.mark("T_UI_READY");
  // Contrôle utilisateur disponible : la bannière est affichée et le bot ne pilote plus rien.
  for (const line of HANDOFF_BANNER) print(line);
  print("Le navigateur reste ouvert : finalisez le paiement vous-même (3-D Secure inclus). Le bot ne touche à aucune donnée bancaire.");
  timeline.mark("T_USER_CONTROL");
  return {
    cartSuccessToUiReadyMs: timeline.between("T_CART_SUCCESS", "T_UI_READY"),
    uiReadyToUserControlMs: timeline.between("T_UI_READY", "T_USER_CONTROL"),
  };
}
