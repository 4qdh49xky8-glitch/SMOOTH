# READY FOR SALE — vente générique

Mode générique pour une mise en vente quelconque (concert, festival, sport, spectacle…), sur n'importe quelle plateforme
**officiellement autorisée**. Aucun artiste, lieu, plateforme ni événement n'est codé en dur : tout est configuration.

```
vente ouverte → disponibilité → offres → filtrage selon vos critères → sélection automatique → ajout au panier
              → vérification du panier → arrêt à CART_SUCCESS → PAIEMENT MANUEL par vous
```

Le cœur ne change pas : le profil de vente est **traduit** en configuration standard. Le modèle d'autorisation est inchangé (figé) :
sans preuve officielle valide, **aucun lancement automatique**.

## 1. Le profil de vente (`config/sale.yaml` ou `.json`)

Modèle : [`config/sale.example.yaml`](../config/sale.example.yaml) (il vise l'adaptateur de test `example`, TEST_ONLY · NOT_A_REAL_PLATFORM).

| Section | Champs | Notes |
|---------|--------|-------|
| `event` | `platform`, `eventUrl`, `eventId`, `name`, `venue`, `date` | `platform` et `name` requis. Les chaînes vides sont ignorées. `eventId` est transmis à l'adaptateur (`siteOptions.eventId`). |
| `sale` | `startTime`, `timezone` | Heure **locale** + fuseau IANA (`Europe/Paris`), ou ISO avec décalage. L'heure d'été est calculée ; une heure qui n'existe pas (saut d'heure) ou qui existe deux fois (retour d'heure) est **refusée**. Un décalage explicite (`+02:00`) doit correspondre au fuseau ; `Z` est un instant, sans contrôle. |
| `tickets` | `quantity` (1–10), `seatsTogether`, `strictTogether` | `strictTogether` : refuser toute offre dont la contiguïté n'est pas **confirmée** (exige `seatsTogether`). |
| `budget` | `maxPrice` | Prix **maximum par billet**, contrainte dure. `null` ou absent : **refusé** (il n'existe pas de budget illimité). |
| `selection` | `strategy`, `categories`, `preferredSections`, `avoidedSections`, `preferredRows`, `avoidedRows` (+ `priorityCategories`, `excludedSections`, `rowPreference`, `priority`, `priceOrder`) | Voir ci-dessous. |
| `behavior` | `autoAddToCart`, `autoPayment` | `autoPayment` doit rester `false` (refusé sinon). |
| `channel` | `auto` \| `official-api` \| `browser` \| `human` | Facultatif. **Restreint** seulement : ne donne jamais une permission. |
| `advanced` | `timing`, `browser`, `cart`, `claude`, `notifications`, `telemetry`, `logging`, `siteOptions` | Facultatif, validé par le schéma standard. |

Les clés inconnues sont **refusées** (faute de frappe = erreur, pas un réglage ignoré).

### Décision de sélection (déterministe, dans le cœur)

1. **Filtre (contraintes dures)** : quantité disponible ≥ `quantity` ; prix ≤ `maxPrice` ; catégorie acceptée (`categories`, vide = toutes) ;
   section non exclue ; côte à côte **confirmé** si `strictTogether`.
2. **Classement** selon `strategy` (mêmes entrées → même choix, quel que soit l'ordre d'arrivée des offres) :

| `strategy` | Ordre des critères (le 1er l'emporte) |
|------------|----------------------------------------|
| `priority` (défaut) | places ensemble → catégorie (dans l'ordre de `categories`) → placement → prix le plus bas |
| `cheapest` | places ensemble → prix le plus bas → catégorie → placement |
| `best-seats` | places ensemble → placement → catégorie → **meilleur** prix dans le budget |
| `category-first` | catégorie → places ensemble → placement → prix le plus bas |
| `fewest-orphans` | places ensemble → quantité qui colle (évite les places orphelines) → catégorie → prix |
| `custom` | votre `priority` (liste de `seatsTogether`, `category`, `placement`, `price`, `fit`) et `priceOrder` |

   *Placement* = sections préférées avant neutres avant évitées, puis rangées préférées avant neutres avant évitées, puis `rowPreference`
   (`front`/`back`). Une rangée est une étiquette exacte (`"A"`, `"12"`) ou un intervalle numérique (`"1-5"`) — jamais une sous-chaîne
   (`"1"` ne correspond pas à `"10"`).
3. **L'adaptateur ne décide pas** : il fournit les données (`getOffers`) et peut seulement **exclure** une offre (`matchOffer`, veto).

## 2. `npm run sale:check -- --config config/sale.yaml`

Contrôle **local** (aucune requête vers la plateforme, aucun verrou créé) → `READY` ou `NOT_READY` avec la raison exacte, code de sortie 0 / 1
(`--json` pour un rapport exploitable). Il vérifie : configuration ; date/heure ; fuseau ; adaptateur ; **statut d'autorisation** ; canal
(et secrets API présents) ; **expiration de la preuve** (elle doit couvrir la fenêtre de la vente) ; **allowedHosts** (URL de l'événement et hôtes
de l'adaptateur ∈ domaines officiels) ; **verrou** (lu, jamais pris) ; critères de sélection ; budget ; quantité (limite d'achat de la plateforme).

```
READY — canal browser, statut BROWSER_ONLY
NOT_READY
  ✗ Autorisation : aucune automatisation autorisée pour « p » : statut NOT_VERIFIED — aucune preuve officielle d'automatisation. Lancement automatique REFUSÉ (mode humain possible : sale:wait --human)
```

`READY` exige un canal **automatisé** explicitement autorisé par des preuves officielles valides. Sans preuve (`NOT_VERIFIED`), `HUMAN_ONLY`,
`NOT_ALLOWED`, `EXPIRED` : `NOT_READY`, pas de lancement automatique, jamais de preuve inventée ni de canal forcé.

## 3. `npm run sale:wait -- --config config/sale.yaml`

1. Évalue comme `sale:check` (NOT_READY → arrêt, aucun contact).
2. **Attend localement** jusqu'à la remise (ouverture − préparation `timing.preArmSeconds` − 60 s de démarrage anticipé du navigateur),
   en **réévaluant toutes les 30 s** (`--recheck-seconds`) la configuration, les preuves (expiration) et les verrous : si quelque chose change
   (preuve expirée ou retirée, verrou pris, configuration invalide), arrêt **avant tout contact**. Aucune requête n'est envoyée pendant l'attente.
3. Dernière évaluation, puis `run` : verrous (événement + profil), garde réseau, préparation, déclenchement précis, détection déterministe,
   sélection, ajout au panier, relecture du panier, **arrêt à `CART_SUCCESS`**. Le navigateur reste ouvert sur le panier : **vous payez vous-même**.
4. Face à une file d'attente, un CAPTCHA, un contrôle anti-bot, une connexion : le bot cède la main (jamais de contournement) ; une limite d'achat
   arrête le run ; si l'autorisation expire pendant l'attente humaine, arrêt sans requête (`AUTHORIZATION_EXPIRED`).

`--human` : **rappels seulement** (aucun automatisme, aucune requête vers la plateforme), utilisable même sans preuve.

## 4. Autorisation : rappel

Avant tout accès réseau : statut de la plateforme (preuves officielles valides) → canal API/navigateur autorisé → `allowedHosts` → expiration →
verrou. Rien de tout cela n'est modifiable par le profil, un drapeau, une variable d'environnement ou l'adaptateur. Voir
[SECURITY.md](SECURITY.md) et [PLATFORMS.md](PLATFORMS.md). Une plateforme réelle exige d'abord une preuve officielle (aucune n'est fournie).
