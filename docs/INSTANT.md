# INSTANT-ON-SALE

Mode générique pour les ventes où l'automatisation est **explicitement autorisée par la plateforme** : tout est préparé **avant** l'ouverture
afin que, dès qu'une offre devient réellement disponible, le chemin le plus court soit parcouru :

```
AVAILABILITY → OFFERS → MATCH → SELECT → ADD TO CART → VERIFY CART → CART_SUCCESS   (puis arrêt : paiement MANUEL)
```

C'est une couche **au-dessus du cœur gelé** (`InstantSaleRunner`, `SaleMonitor`, `CompiledSelectionCriteria`). Aucun fichier du cœur n'est
modifié (autorisation, sélection, `sale:check`, `sale:wait`, verrous, garde-fous réseau, blocages, paiement) : `tests/frozen-core.sha256.json`
en garde les empreintes, le test `instantCommand` échoue si l'une change.

## Commande

```bash
npm run sale:instant -- --config configs/events/example.yaml       # profil de vente générique (docs/SALE.md)
```

Pas de `--force`, pas de mode humain, pas d'option de contournement (toute option inconnue est refusée).

1. **Avant-vente = `sale:wait` inchangé** : configuration, **autorisation complète** (statut, canal, preuve et son expiration, `allowedHosts`,
   secrets, verrou), prise des **mêmes verrous que `run`** (événement + profil) conservés et renouvelés pendant l'attente, réévaluation
   locale périodique, évaluation complète juste avant le premier contact. `NOT_VERIFIED`, `EXPIRED`, `NOT_ALLOWED`, `HUMAN_ONLY` : refus de
   démarrer, aucun contact.
2. **Préparation** (`InstantSaleRunner`, après la remise) : canal → autorisation → conformité → hôtes → verrous → **Chromium** (un navigateur par
   profil) → garde réseau → **session** → **page de l'événement** → abonnement à la source officielle de disponibilité *si l'adaptateur en expose une*.
   La préparation du cœur (connexion + page de l'événement) a lieu à `timing.preArmSeconds` avant T0 : augmentez-le pour avoir plus d'avance.
3. **T0** : la surveillance autorisée démarre immédiatement ; dès qu'une offre exploitable apparaît, le cœur décide (filtre + stratégie
   déterministes), sélectionne, ajoute au panier, **relit et vérifie** le panier (quantité, prix, budget).
4. **CART_SUCCESS** : surveillance arrêtée, verrous libérés, garde de paiement levé, **navigateur laissé ouvert**, session utilisable.
   Affichage : `CART_SUCCESS` / `Payment remains manual.`

## Architecture

| Élément | Rôle |
|---------|------|
| `src/instant/runner.ts` — `runInstantSale` | prépare, enveloppe le cœur (`Agent`, inchangé), compte, mesure, affiche le tableau de bord. Mêmes garde-fous que `run`, dans le même ordre (verrouillé par test). |
| `src/instant/monitor.ts` — `SaleMonitor` | `start() stop() poll() onAvailability() getMetrics()`. Cadence **jamais plus rapide** que l'autorisée (plancher 200 ms) ; **Retry-After respecté** (aucune lecture avant l'échéance) ; disponibilité d'abord, offres lues seulement si la vente est ouverte et non complète ; état bloquant lu en parallèle ; **flux officiel** prioritaire si l'adaptateur l'expose (`subscribeAvailability`), sinon lecture de l'adaptateur (navigateur ou API) — jamais un point d'accès non documenté. |
| `src/instant/monitor.ts` — `instrument` | décorateur de l'adaptateur : compte chaque appel du contrat (`getAvailability`, `getOffers`, `matchOffer`, `selectOffer`, `addToCart`, `getCartState`) et horodate. N'ajoute ni ne retire aucune permission. |
| `src/instant/compile.ts` — `CompiledSelectionCriteria` | critères figés et normalisés **avant T0** (immuable) + filtres durs en entiers. `rank` ≡ `rankOffers` du cœur (test d'équivalence sur 800 tirages). La **décision reste celle du cœur**. |
| `src/instant/timeline.ts`, `report.ts` | horodatages `T_PREPARE_START … T_CART_SUCCESS`, durées, tableau de bord. |
| `InstantClaude` | Claude n'intervient que si la configuration l'autorise **et** que l'adaptateur signale un sélecteur introuvable ; le diagnostic est refusé. Compteur `claudeCallsInCriticalPath` (0 en nominal). |

## Mesures

`T_PREPARE_START`, `T_BROWSER_READY`, `T_EVENT_READY`, `T_SALE_START`, `T_FIRST_POLL`, `T_AVAILABILITY_DETECTED`, `T_OFFER_SELECTED`, `T_CART_REQUEST`,
`T_CART_SUCCESS` → `sale_open_to_availability`, `availability_to_selection`, `selection_to_cart_request`, `cart_request_to_cart_success`,
`total_sale_open_to_cart` (+ préparation du navigateur et de la page). `T_CART_SUCCESS` n'existe que si le cœur a **validé** le panier.

Tableau de bord final : `STATUS` (`CART_SUCCESS` / `SOLD_OUT` / `QUEUE` / `CAPTCHA` / `BLOCKED` / `PURCHASE_LIMIT` / `AUTHORIZATION_EXPIRED` /
`CART_MISMATCH` / `ERROR`), `TIMING`, `PERFORMANCE` (appels Claude, opérations réseau, relances, offres examinées), `SECURITY` (autorisation,
canal, verrou, `payment = MANUAL`).

> `network_requests` = opérations d'adaptateur susceptibles d'émettre une requête (lectures, sélection, ajout, relecture) ; les tests sur fixture
> affichent le nombre de requêtes réellement vues côté serveur. Les durées mesurées sur fixture **ne disent rien de la vitesse d'un achat réel**.

## Ce qui n'est jamais fait

CAPTCHA, file d'attente, anti-bot, limite de débit, limite d'achat, authentification : cession de la main ou arrêt (comportement du cœur),
**aucun contournement** ; pas de changement d'IP, pas de comptes ni de sessions multiples, pas d'accélération après une limite de débit ;
un seul contrôleur par événement + profil (mêmes verrous que `sale:wait`, `run`, `login`, `check`) ; paiement **jamais** automatisé.

## Journaux

Minimaux pendant la vente : `[T-…] SALE_READY`, `[T0] SALE_OPEN`, `[T+…] AVAILABILITY`, `[T+…] CART_REQUEST`, `[T+…] CART_SUCCESS`. Jamais de cookies,
jeton, `Authorization`, secret, donnée bancaire, URL à identifiants (assainissement du cœur).

## Tests

`tests/instant.test.ts` (14 scénarios sur adaptateur scripté, décomptes d'appels, horodatages, Retry-After, flux officiel, critères compilés,
Claude, rapport), `tests/instantCommand.test.ts` (chaîne `sale:instant`, exclusion mutuelle, refus, cœur gelé, ordre des garde-fous),
`tests/instantBrowser.test.ts` (vrai Chromium local + faux site : préparation avant T0, rapport de latence, file, CAPTCHA, complet, limite).
