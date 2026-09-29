# Ajouter un site de billetterie

Objectif : **déposer un seul fichier** dans `src/sites/` (+ ses sélecteurs et ses tests). Ni le cœur
(`src/agent/`), ni le registre, ni le schéma de config ne changent.

## 0. Avant tout code : l'autorisation (bloquant)

Ne créez un adaptateur que si l'une de ces conditions est vraie, et documentez-la dans `meta.compliance` :

| `policy`             | Quand l'utiliser                                                                 |
|----------------------|-----------------------------------------------------------------------------------|
| `official-api`       | Le site propose une API / un programme d'intégration officiel (à privilégier).    |
| `permitted-by-terms` | Les CGU / règles d'achat autorisent expressément l'outil décrit (mise au panier assistée, compte personnel, paiement manuel). |
| `demo`               | Serveur local de démonstration uniquement (refusé hors `localhost`).              |

Si les CGU interdisent l'automatisation, **on n'écrit pas l'adaptateur**. Renseignez `termsUrl` (https) et
`reviewedAt` (AAAA-MM-JJ) : le cœur refuse de démarrer sans déclaration valide et **expire après 180 jours**
(relire les CGU, puis mettre la date à jour). Ce contrôle est un garde-fou de processus, pas un avis juridique.

## 1. Créer `src/sites/MonSite.ts`

```ts
import { BaseSiteAdapter } from "./BaseSiteAdapter.js";
import type { AdapterContext, AdapterMeta, CartSummary, Offer, SaleSnapshot } from "./SiteAdapter.js";

export default class MonSite extends BaseSiteAdapter {          // export PAR DÉFAUT : c'est ce que découvre le registre
  readonly meta: AdapterMeta = {
    id: "monsite",
    displayName: "Mon Site",
    compliance: { policy: "official-api", termsUrl: "https://…", reviewedAt: "2026-10-01" },
    capabilities: { officialApi: true, preciseServerTime: false, lightweightAvailability: true,
                    reportsSeatAdjacency: false, seatSelection: "manual" },
  };
  protected async isLoggedIn(ctx: AdapterContext) { /* la session du compte existant est-elle active ? */ }
  async fetchSale(ctx: AdapterContext): Promise<SaleSnapshot> { /* léger : API/HTTP, pas de rendu */ }
  async selectOffer(ctx, offer: Offer, quantity: number) { /* ouvrir l'offre, régler la quantité */ }
  async addToCart(ctx) { /* cliquer « Ajouter au panier », attendre confirmation OU OfferUnavailableError */ }
  async readCart(ctx): Promise<CartSummary> { /* lire le panier */ }
}
```

Ce que `BaseSiteAdapter` fournit déjà : connexion **manuelle** par défaut (`NotLoggedInError` → le cœur cède la main),
`prepare` (charge la page événement), `detectBlocker` (file d'attente, CAPTCHA, anti-bot, limite d'achat),
motifs de paiement par défaut. Surchargez seulement ce qui diffère.

## 2. Correspondance avec les besoins

| Besoin                        | Où                                                                                   |
|-------------------------------|---------------------------------------------------------------------------------------|
| Ouverture de la page événement| `resolveEventUrl` + `prepare`                                                         |
| Authentification manuelle     | `isLoggedIn` (+ `npm run login`) ; jamais de contournement                            |
| Disponibilité, offres, prix, catégories, quantité | `fetchSale` → `SaleSnapshot { open, offers[] }`                    |
| Places côte à côte            | `Offer.seatsTogether` (`true/false/"unknown"`) ; helper `seatsAreContiguous`          |
| Sélection de places           | `selectSeats?` optionnel ; `BlockerError("human-step")` si l'humain choisit sur un plan |
| Ajout au panier               | `addToCart` (+ `OfferUnavailableError` si vendu)                                      |
| File / CAPTCHA / blocage / limite | `detectBlocker` ou `BlockerError` ; kinds : `queue`, `captcha`, `anti-bot`, `login-required`, `human-step`, `purchase-limit` |
| État renvoyé au cœur          | `SaleSnapshot`, `Blocker`, erreurs typées → `RunResult { status, blocker, timeline }` |

## 3. Comportement du cœur face aux états (identique pour tous les sites)

- `queue` / `captcha` / `anti-bot` : le bot **cesse toute action**, notifie, attend la disparition (détection auto) ou Entrée.
- `login-required` / `human-step` : le bot cède la main jusqu'à Entrée.
- `purchase-limit` : **arrêt définitif** du run (`status: "blocked"`), aucune insistance, aucun autre essai.
- Aucun état ne déclenche de contournement, de nouveau compte ou de paiement.

## 4. Sélecteurs et tests

- `src/selectors/monsite.ts` : `SelectorSpec` (nom, description, candidats du plus stable au plus fragile).
- `tests/monsite.test.ts` + `tests/fixtures/monsite/*.html` : pages **enregistrées**, aucune vente réelle.
- Le contrat commun (`tests/adapters.contract.test.ts`) s'applique **automatiquement** à votre adaptateur :
  méthodes présentes, `paymentUrlPatterns` actif, conformité valide.
- Vérifiez : `npm run check -- --list-sites`, `npm test`.

## 5. Mise en service

```bash
npm run check -- --list-sites                 # l'adaptateur est-il découvert ?
npm run login                                 # connexion manuelle (profil conservé)
npm run check                                 # config + conformité + horloge
# Répétition sur une page/événement NON tendu, puis seulement le jour J :
npm start
```
