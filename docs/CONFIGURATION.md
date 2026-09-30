# Configuration, profils et stratégie de sélection

> **Profil de vente générique** (YAML/JSON : `event`, `sale` + `timezone`, `tickets`, `budget`, `selection`, `behavior`) : voir [SALE.md](SALE.md) — traduit en cette configuration standard ; toutes les commandes l'acceptent (`--config sale.yaml`).

## Profils

Un profil = un fichier JSON dans `config/events/`. Vous en gardez autant que d'événements :

```
config/events/
  _base.json       réglages communs (timing, navigateur, notifications…) — hérité, jamais lancé seul
  concert.json     quantité 2, catégories 1>2>3, côte à côte d'abord
  festival.json    quantité 4, toutes catégories, moins cher d'abord
  sport.json       tribunes, section évitée/exclue, rang avant
  spectacle.json   côte à côte STRICT, meilleur prix dans le budget, orchestre au centre
```

Les fichiers commençant par `_` sont des bases : ils ne sont pas listés comme profils. Un profil en hérite avec
`"extends": "_base.json"` (chemin relatif au fichier ; fusion profonde : les objets sont fusionnés, les tableaux
et valeurs de l'enfant remplacent ceux du parent ; profondeur max 5).

```bash
npm run profiles                                 # liste + validité
npm run validate -- concert                      # un profil par son nom
npm run validate -- config/event.json            # ou un chemin
npm run validate -- --all                        # tous les profils
npm start -- --profile concert                   # lancer avec un profil (ou --config <fichier>)
npm run simulate -- --profile spectacle          # simuler avec sa stratégie
```

Sans option, `npm start` lit `config/event.json`. Un ancien fichier plat (V1 : `event` en texte, `saleTime`,
`quantity`…) est migré automatiquement.

## Référence des champs

| Champ | Défaut | Rôle |
|-------|--------|------|
| `site` | requis | plateforme : `meta.platform` (ou `meta.id`) d'un adaptateur de `src/sites/`, ou entrée de `platforms/catalog.json` |
| `channel` | `auto` | `auto` : API officielle → navigateur → intervention humaine, selon les adaptateurs et les preuves du catalogue ; `official-api` / `browser` / `human` pour restreindre. Un canal forcé ne peut jamais être plus permissif que l'autorisation : la configuration **restreint** seulement, forcer un canal non autorisé est une erreur ([SECURITY.md](SECURITY.md)) |
| `siteOptions` | `{}` | réglages libres propres à l'adaptateur (validés par `validateOptions`) |
| `event.name` | requis | nom de l'événement |
| `event.date` | — | date de l'événement `AAAA-MM-JJ` (contrôle de cohérence) |
| `event.id`, `event.venue` | — | identifiant chez la plateforme et lieu (informatifs ; l'id est transmis à l'adaptateur) |
| `event.url` | — | page de l'événement (requise sauf si l'adaptateur a une URL par défaut) |
| `sale.startTime` | requis | ouverture de la vente, ISO 8601 **avec fuseau** (`2026-10-01T10:00:00+02:00`) |
| `tickets.quantity` | requis | nombre de billets (1–10) |
| `tickets.maxPricePerTicket` | requis | budget par billet — **contrainte dure**, jamais dépassé |
| `tickets.categories` | `[]` | catégories acceptées, **l'ordre = préférence** ; `[]` = toutes |
| `tickets.seatsTogether` | `true` | préférer les places côte à côte |
| `tickets.seatsTogetherStrict` | `false` | refuser toute offre dont la contiguïté n'est pas **confirmée** |
| `strategy.placement.preferRows` / `avoidRows` | `[]` | rangées préférées / à éviter : étiquettes exactes (`A`, `12`) ou intervalles (`1-5`) |
| `strategy.*` | voir ci-dessous | classement des offres retenues |
| `behavior.autoAddToCart` | `true` | `false` : sélectionne l'offre puis vous laisse ajouter au panier |
| `behavior.autoPayment` | `false` | **doit rester `false`** : `true` est refusé par la validation |
| `timing.preArmSeconds` | 90 | préparation (connexion, chargement) avant l'ouverture |
| `timing.pollIntervalMs` | 400 (min 200) | intervalle minimal entre deux interrogations (limitation volontaire) |
| `timing.pollJitterMs` | 50 | gigue ajoutée à l'intervalle |
| `timing.soldOutPollIntervalMs` | 1000 (min 200) | intervalle quand la vente est ouverte mais **complète** (`SOLD_OUT`) : pas de surveillance agressive inutile |
| `timing.maxWaitAfterSaleSeconds` | 900 | durée de surveillance après l'ouverture |
| `timing.actionTimeoutMs` | 4000 | délai max d'une action navigateur |
| `cart.maxAttempts` | 5 | nombre max d'offres tentées |
| `cart.unavailableCooldownMs` | 3000 | une offre signalée vendue n'est pas retentée avant ce délai (liste périmée) |
| `browser.headless` | `false` | `true` interdit la cession de la main (avertissement/erreur selon le site) |
| `browser.userDataDir` | `.profile/<profil>` | profil Chromium persistant (votre session) : **un navigateur par profil**, jamais partagé |
| `browser.debugPort` | `0` | port CDP ; `0` = automatique (retrouvé dans le profil). Un port fixe déjà pris par un autre profil est refusé |
| `browser.blockHeavyResources` | `true` | images/polices/vidéos bloquées pendant la course, rétablis ensuite |
| `claude.enabled` | `false` | assistant de réparation de sélecteurs (secours) ; nécessite `ANTHROPIC_API_KEY` |
| `notifications.desktop/sound` | `true` | notification système / bip |
| `telemetry.enabled`, `dir` | `true`, `runs` | télémétrie locale ([STATES_AND_TELEMETRY.md](STATES_AND_TELEMETRY.md)) |
| `logging.level`, `file` | `info`, — | niveau et fichier de logs |

## Stratégie de sélection

Deux étages, tous deux **déterministes** (aucun LLM) :

1. **Filtre — `tickets` (contraintes dures)** : quantité disponible ≥ `quantity` ; prix ≤ `maxPricePerTicket` ;
   catégorie acceptée (si la liste n'est pas vide) ; section non exclue (`strategy.placement.excludeSections`) ;
   côte à côte confirmé si `seatsTogether` **et** `seatsTogetherStrict`.
2. **Classement — `strategy`** : parmi les offres retenues, ordre selon `strategy.priority`.

```jsonc
"strategy": {
  "priority": ["seatsTogether", "category", "placement", "price"],   // le 1er critère l'emporte
  "priceOrder": "cheapest",                  // "cheapest" | "most-expensive" (meilleur prix dans le budget)
  "priorityCategories": ["Tribune Nord"],    // tentées avant les autres catégories acceptées
  "placement": {
    "preferSections": ["Fosse", "Orchestre centre"],   // préférées (sous-chaîne, sans casse ni accents)
    "avoidSections": ["Vue limitée"],                  // reléguées en fin de classement
    "excludeSections": ["Visiteurs"],                  // écartées d'office
    "rowPreference": "front"                           // "front" | "back" | "any"
  }
}
```

Critères de `priority` (un critère **absent de la liste est ignoré** ; pas de doublon) :

| Critère | Clé de tri (plus petit = meilleur) |
|---------|------------------------------------|
| `seatsTogether` | confirmé côte à côte < inconnu < séparé (ignoré si `tickets.seatsTogether=false`) |
| `category` | `priorityCategories` (dans l'ordre), puis `tickets.categories` (dans l'ordre) |
| `placement` | section préférée < neutre < évitée ; puis rang croissant (`front`) ou décroissant (`back`) |
| `price` | `cheapest` : prix croissant ; `most-expensive` : prix décroissant |
| `fit` | quantité disponible la plus proche de `quantity` (évite de laisser des places orphelines) |

Départage final : prix croissant, puis `id` (résultat stable). Les clés de chaque offre s'affichent au niveau
`DEBUG` (`--log-level debug`).

### Recettes par type d'événement

| Type | Idée | Réglages |
|------|------|----------|
| **Concert** | places ensemble, catégorie préférée, pas cher | `priority: [seatsTogether, category, price]`, `categories: [Cat 1, Cat 2, Cat 3]` |
| **Festival** | quantité, prix, peu importe la catégorie | `categories: []`, `seatsTogether: false`, `priority: [price, fit]` |
| **Sport** | tribune d'abord, rang avant, éviter les vues limitées | `priority: [category, seatsTogether, placement, price]`, `avoidSections`, `rowPreference: front` |
| **Théâtre / spectacle** | jamais séparés, meilleur siège dans le budget | `seatsTogetherStrict: true`, `priceOrder: most-expensive`, `preferSections: [Orchestre centre]` |
| **Culturel (musée, visite)** | créneau et quantité | `categories: []`, `priority: [price]` ; l'adaptateur expose créneau/horaire comme catégorie |

## Plusieurs instances

Deux profils sur des **événements différents** peuvent tourner en même temps : navigateur, profil, cookies, logs
(`[profil#PID:…]`) et télémétrie sont séparés (connectez-vous une fois par profil : `npm run login -- --profile <nom>`).
Deux instances sur le **même événement** sont refusées par un verrou (`.locks/`) : ce serait multiplier les sessions et
les paniers. `logging.file` accepte `{profile}` et `{pid}` pour un fichier de log par instance.

## Ce que `validate` contrôle

`npm run validate` ne contacte aucun site. Il vérifie : le schéma ; l'existence de l'adaptateur ; sa
conformité (autorisation valide et récente, démo limitée à `localhost`) et son contrat ; `siteOptions` ;
`sale.startTime` dans le passé ; `event.date` passée ou antérieure à l'ouverture ; catégories en double ;
`priorityCategories` absentes de `tickets.categories` ; sections à la fois préférées et évitées ;
`seatsTogetherStrict` sur un site qui ne renseigne pas l'adjacence (**aucune offre ne serait retenue**) ;
quantité supérieure à la limite d'achat déclarée par l'adaptateur (`maxTicketsPerOrder`, erreur : le bot refuserait de
démarrer) ; profils qui partagent un même `userDataDir` (avertissement avec `--all`) ; `headless` avec choix de places manuel (erreur) ou avec un vrai site (avertissement) ; cadence < 400 ms sur un
vrai site ; `claude.enabled` sans clé d'API. Code de sortie 1 s'il y a au moins une erreur.
