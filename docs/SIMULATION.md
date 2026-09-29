# Mode simulation

La simulation exécute le **vrai Core Agent** (horloge, déclenchement, classement, stratégie, états, cession de la
main, télémétrie) contre un **faux site** piloté par un scénario. Elle n'ouvre **aucune connexion réseau**, ne
lance **aucun navigateur** et n'émet **aucune notification système**. Rien ne peut donc toucher un vrai site ni
déclencher un paiement.

```bash
npm run simulate                                   # scénario « nominal » avec le profil « concert »
npm run simulate -- --scenario queue               # un scénario précis
npm run simulate -- --profile spectacle --scenario contention
npm run simulate -- --all                          # tous les scénarios (12 de base + 21 de stress) avec vérification des résultats attendus
npm run simulate -- --scenario queue --log-level debug
```

La configuration utilisée est **la vôtre** (quantité, budget, catégories, stratégie) : seuls l'URL, l'heure de
vente (maintenant + `--start-in` ms, 700 par défaut), les délais et les notifications sont adaptés. Vous pouvez
donc vérifier ce que votre stratégie choisirait face à des offres données, et comment le bot réagit aux blocages.
Chaque run écrit sa télémétrie (`mode: "simulation"`). `--all` sort avec le code 1 si un scénario ne donne pas le
résultat attendu.

Garanties (testées) : aucun appel `fetch` pendant les scénarios ; pendant une cession de la main, l'adaptateur
simulé n'est plus appelé ; `PURCHASE_LIMIT` provoque un arrêt sans nouvel essai ; l'adaptateur de simulation
n'est pas dans `src/sites/` et ne peut pas être choisi dans une configuration réelle.

## Scénarios fournis (`simulations/`)

| Scénario | Ce qu'il exerce | Résultat attendu |
|----------|-----------------|------------------|
| `nominal` | meilleure offre selon la stratégie | `CART_SUCCESS`, 1 tentative |
| `contention` | offre vendue à l'ajout | repli sur l'offre suivante, 2 tentatives |
| `queue` | file d'attente pendant la sélection | `QUEUE` puis `CART_SUCCESS`, 1 cession de main |
| `captcha` | CAPTCHA à l'ajout | `CAPTCHA` puis `CART_SUCCESS` |
| `blocked` | contrôle anti-bot | `BLOCKED` puis `CART_SUCCESS` |
| `login-required` | session expirée avant l'ouverture | `LOGIN_REQUIRED` puis `CART_SUCCESS` |
| `manual-seats` | choix de places confié à l'humain | `MANUAL_SELECTION` puis `CART_SUCCESS` |
| `purchase-limit` | limite d'achat | `PURCHASE_LIMIT`, arrêt, 0 cession, 1 tentative |
| `sold-out` | vente ouverte mais complète | `SOLD_OUT` / `NO_MATCHING_OFFER` |
| `rate-limited` | 429 répétés | le bot respecte le délai puis réussit |
| `clock-skew` | serveur avec 1,5 s d'avance | l'horloge est recalée, `CART_SUCCESS` |
| `adapter-error` | erreur technique | `ERROR` / `ADAPTER_ERROR`, sans exception |

Les résultats attendus des scénarios livrés sont écrits pour le profil `concert` (catégories 1 à 3, budget 150 €,
quantité 2) : ils ne sont vérifiés (`expect`, code de sortie) qu'avec ce profil, qui est le profil par défaut de
`simulate`. Avec un autre profil, le résultat est affiché sans vérification : c'est le moyen d'observer ce que
*votre* stratégie ferait.

## Écrire un scénario

Un fichier JSON dans `simulations/` (validé au chargement) :

```jsonc
{
  "name": "mon-scenario",
  "saleOpensAfterMs": 300,            // ouverture, en ms après sale.startTime (heure serveur simulée)
  "serverClockSkewMs": 0,             // décalage de l'horloge du faux serveur
  "latencyMs": { "fetchSale": 5, "selectOffer": 20, "addToCart": 40 },   // latence par étape
  "humanResolveMs": 150,              // temps que met « l'humain » à traiter un blocage
  "maxWaitMs": 3000,                  // durée de surveillance
  "soldOut": false,                   // le faux site affiche « complet »
  "config": { "tickets": { "quantity": 4, "maxPricePerTicket": 120 } },   // surcharge de la configuration : scénario autonome, vérifiable avec n'importe quel profil
  "purchaseLimit": 2, "declareLimit": true,   // limite d'achat du faux site ; connue d'avance (true) ou révélée à la sélection (false)
  "blockWindows": [{ "state": "QUEUE", "fromMs": 0, "untilMs": 1300 }],   // file / CAPTCHA / anti-bot affichés (ms après l'ouverture)
  "cart": { "itemCount": 2 },         // ce que le faux site met réellement au panier (ajout partiel)
  "humanAvailable": true,             // false : personne pour traiter les blocages (headless)
  "leakCanaries": false,              // true : les messages d'erreur du faux site contiennent des secrets factices (test d'assainissement)
  "offers": [
    { "id": "o1", "category": "Catégorie 2", "price": 139, "available": 2,
      "section": "B", "row": "7", "seats": ["5", "6"],
      "appearsAtMs": 0,               // apparition retardée après l'ouverture (optionnel)
      "soldAtMs": 900 }               // vendue à ce moment (optionnel)
  ],
  "failures": [                       // à la nᵉ exécution de l'étape, lever l'erreur
    { "step": "selectOffer", "nth": 1, "error": "QUEUE" }
  ],
  "expect": { "finalState": "CART_SUCCESS", "attempts": 1, "humanHandoffs": 1, "statesInclude": ["QUEUE"] }
}
```

- `failures[].step` : `login`, `fetchSale`, `selectOffer`, `selectSeats`, `addToCart`, `readCart`.
- `failures[].error` : `OFFER_UNAVAILABLE`, `RATE_LIMITED`, `QUEUE`, `CAPTCHA`, `BLOCKED`, `LOGIN_REQUIRED`,
  `MANUAL_SELECTION`, `PURCHASE_LIMIT`, `ERROR`.
- `expect` (optionnel) : `finalState` (requis dans `expect`), `status`, `failureReason`, `attempts`,
  `humanHandoffs`, `offerId`, `statesInclude` ; vérifié par `--all` et par la suite de tests.

Les scénarios de `simulations/stress/` portent leur propre `config` et leurs propres attentes : ils se vérifient avec
n'importe quel profil. Voir [STRESS_TESTS.md](STRESS_TESTS.md).

Ajoutez un scénario chaque fois qu'un cas réel vous surprend : il devient un test de non-régression du cœur.

## Ce que la simulation ne remplace pas

Elle valide la **logique du cœur** (décisions, états, reprises, mesures), pas le comportement d'un site réel :
sélecteurs, structure des pages, formats d'API. Pour un adaptateur, complétez avec des tests sur pages
enregistrées ([ADDING_A_SITE.md](ADDING_A_SITE.md#9-tester-sans-jamais-toucher-une-vente-réelle)) et un essai
supervisé, jamais sur une vente réelle sans vous.
