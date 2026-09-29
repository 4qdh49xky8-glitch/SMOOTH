# Stress test du moteur de décision et audit

Tout ce document porte sur le faux site et la simulation : **aucun vrai site n'a été contacté**, aucun adaptateur
réel n'existe.

```bash
npm run test:stress            # les 48 tests du stress test (scénarios, Claude, concurrence, performance, navigateur réel)
npm test                       # toute la suite (134 tests)
npm run simulate -- --all      # 33 scénarios : 12 de base + 21 de stress, chacun avec son résultat attendu
npm run simulate -- --scenario stress/08-queue-window --log-level debug   # un scénario, journal complet
```

Chaque scénario vérifie **six choses** (`tests/stress/harness.ts`, `expectRun`) : l'état final, l'offre choisie, la
raison d'échec, le nombre de tentatives, la télémétrie (fichier cohérent, sans URL ni e-mail) et l'absence de données
sensibles dans les logs, les notifications et la télémétrie. Pour ce dernier point, le faux site **laisse fuiter**
des secrets factices dans ses messages d'erreur (URL à jeton, identifiant de session, e-mail, numéro de carte, mot de
passe) et le test échoue si l'un d'eux réapparaît quelque part.

## Les 18 scénarios

| # | Situation | Fichier / test | Résultat vérifié |
|---|-----------|----------------|------------------|
| 1 | 2 côte à côte à 90 € vs 2 séparés à 70 €, `seatsTogether=true` | `stress/01-…` | offre côte à côte, `CART_SUCCESS`, 1 tentative |
| 2 | côte à côte à 160 €, séparés à 100 €, budget 120 € | `stress/02-…`, `02b-…` | 160 € jamais tentée ; non strict → séparés à 100 € ; **strict** → `AVAILABLE` / `NO_MATCHING_OFFER`, 0 tentative |
| 3 | catégorie A épuisée, B disponible | `stress/03-…` | B choisie, l'offre épuisée n'est même pas ouverte |
| 4 | plusieurs offres dans le budget, catégories C > A > B | `stress/04-…`, `04b-…` | ordre respecté même si B est moins chère ; `priorityCategories` prioritaire |
| 5 | offre vendue pendant la sélection | `stress/05-…` | 2 tentatives (`unavailable` puis `cart`), la vendue n'est pas retentée |
| 6 | quantité 4, offres de 2 seulement | `stress/06a-…`, `06b-…` | aucun ajout ; **ajout partiel** (2 sur 4) → `cart-mismatch` / `CART_MISMATCH`, alerte, aucun second ajout |
| 7 | limite du site 2, quantité 4 | `stress/07a-…`, `07b-…` | connue : arrêt **avant tout appel** ; révélée : 1 tentative, `PURCHASE_LIMIT`, aucune insistance ni cession de main |
| 8 | file d'attente alors que l'API liste des offres | `stress/08-…` | **0 action** de sélection pendant la file (l'adaptateur simulé enregistre toute violation) |
| 9 | CAPTCHA | `stress/09a-…`, `09b-…` | cession de main, 0 action pendant l'affichage ; sans humain (headless) → `ERROR` / `HUMAN_REQUIRED_HEADLESS`, 0 action |
| 10 | sélecteur inconnu | `tests/stress/claude.test.ts`, `browser.e2e.test.ts` | Claude ne reçoit que des boutons ; quota d'appels respecté ; 0 appel sur le chemin nominal |
| 11 | huit offres simultanées | `stress/11-…` | même choix pour 6 ordres de liste différents ; séquence `select → add → read` unique |
| 12 | deux instances simultanées | `tests/stress/concurrency.test.ts`, `browser.e2e.test.ts` | télémétries, logs, ports, profils, cookies et onglets séparés ; verrou par événement |
| 13 | événement sans catégorie | `stress/13-…` | `categories=[]` = toutes (même libellé vide ou exotique) |
| 14 | prix = maximum | `stress/14-…` + `units.test.ts` | accepté |
| 15 | maximum + 1 centime | `stress/15-…` + `units.test.ts` | refusé ; comparaison en centimes (`0,1 + 0,2` ≤ `0,30`) |
| 16 | aucun billet | `stress/16-…` | `SOLD_OUT`, lecture ralentie (≤ 8 lectures en 3 s), aucune sélection |
| 17 | connexion manuelle | `scenarios.test.ts` | le bot attend **1,8 s et plus** sans rien faire ; reprend seulement après confirmation humaine |
| 18 | panier obtenu | `stress/18-…`, `browser.e2e.test.ts` | dernière interaction = lecture du panier ; aucune activité résiduelle ; la page de paiement n'est **jamais demandée** (compteur serveur) |

## Ce que le stress test a trouvé (et corrigé)

Chaque défaut a d'abord été constaté par un test rouge, puis corrigé.

| Défaut | Gravité | Correction |
|--------|---------|------------|
| Panier **partiel** déclaré `CART_SUCCESS` (quantité ≠ demandée) | élevée | statut `cart-mismatch`, `ERROR` / `CART_MISMATCH` (ou `CART_UNVERIFIED` si illisible), alerte « à vérifier », aucun autre ajout |
| Limite d'achat **connue** non appliquée avant d'agir | élevée | `capabilities.maxTicketsPerOrder` : arrêt avant tout appel ; `validate` et le contrat la vérifient |
| **Secrets dans les logs** (URL à jeton, e-mail, carte, mot de passe) | élevée | `redact()` appliqué par construction dans le logger, les notifications et la télémétrie |
| Sélection tentée **avant** de constater une file d'attente / un CAPTCHA | élevée | lecture de l'état de la page **en parallèle** de chaque lecture de disponibilité ; aucune sélection tant qu'un blocage est affiché |
| **Claude** recevait valeurs de champs, texte de page, URL complète, liens à jeton, titre, menu de compte | élevée | deux filtres (page puis Node), voir ci-dessous |
| **Script de détection de blocages cassé** : apostrophe mal échappée → erreur avalée → *aucune détection* | élevée | script réécrit (`String.raw`), verrouillé par un test sur pages réelles ; motifs resserrés (pas de faux positif sur une FAQ ou une bannière d'information) |
| Deux instances **partageaient** navigateur, port et onglet | élevée | un navigateur par profil, port automatique, refus d'un port déjà pris par un autre profil |
| Verrou d'événement contournable depuis le même processus | moyenne | verrous détenus suivis en mémoire |
| Vente **complète** interrogée à pleine cadence | moyenne | `timing.soldOutPollIntervalMs` (1 s par défaut) |

## Audit : concurrence, courses, boucles, attentes

Corrigé et couvert par un test :

| # | Constat | Effet sur la vitesse / la fiabilité | Correctif |
|---|---------|-------------------------------------|-----------|
| P1 | La détection automatique de la cession de main dormait 500 ms et lisait la page **après** la reprise | lecture concurrente pendant la reprise | boucle annulable, attendue avant de reprendre |
| P2 | L'attente d'armement tournait en **attente active pendant 1 s** (`spinThresholdMs: 1000`) | 1 s de CPU inutile juste avant la phase critique | 50 ms |
| P3 | Les notifications étaient **attendues** (webhook jusqu'à 4 s) sur le chemin chaud | retard de la lecture du panier, de l'arrêt, de la reprise | non bloquantes, envoyées **dès l'ajout**, terminées avant de rendre la main |
| P4 | Une offre signalée vendue était retentée à chaque lecture d'une liste périmée | requêtes et temps perdus sur une offre morte | délai de grâce `cart.unavailableCooldownMs` (3 s) |
| P5 | Une lecture de page qui ne répond pas pouvait **geler** toute la surveillance | perte totale de réactivité | lecture d'état bornée à 250 ms |
| P6 | Panne réseau : martèlement à cadence fixe + une ligne de log par tentative | charge inutile sur le site, logs illisibles | attente exponentielle plafonnée à 5 s, logs espacés |
| P7 | Repli sur l'en-tête `Date` : 7 échantillons pour une précision d'une seconde | 6 requêtes inutiles | 3 échantillons |
| P8 | Le classement recalculait les clés à chaque comparaison | coût croissant avec le nombre d'offres | tri « décoré » : 2 000 offres en quelques ms |
| P9 | Comparaison de prix en virgule flottante | rejet ou acceptation erronés à la marge | comparaison en centimes |

Mesuré (tests) : lecture de disponibilité et lecture d'état **en parallèle** (2 × 80 ms → ~80 ms, pas 160) ;
lecture du panier moins de 100 ms après l'ajout même avec un webhook à 700 ms ; CPU < 120 ms pour 600 ms
d'attente ; cadence de 200 ms respectée (3 à 6 lectures par seconde) ; aucune activité 900 ms après l'arrêt.

Constaté, **non modifié** (recommandations) :

- **Partage de la préférence « côte à côte »** : avec `seatsTogether=true` **sans** `seatsTogetherStrict`, si aucune offre
  côte à côte n'est dans le budget, le bot prend des places **séparées** (scénario 2). C'est la définition d'une
  *préférence*. Si vous refusez d'être séparés, mettez `seatsTogetherStrict: true` (scénario 2b : rien n'est pris).
- **Noms de personnes dans le texte libre d'un bouton** : aucune expression régulière ne les détecte. Mitigation
  structurelle (contenu principal seulement, éléments d'identité écartés, titre jamais envoyé, champs de saisie jamais
  envoyés), pas de garantie absolue : gardez `claude.enabled: false` sauf besoin, et relisez les logs avant partage.
- **Claude sur le chemin d'échec** : une réparation ou un diagnostic peut prendre jusqu'à `claude.timeoutMs` (8 s). Ce
  n'est jamais le chemin nominal ; abaissez le délai (3 s) si vous préférez échouer vite.
- **`ExampleSite.addToCart`** : la course succès/erreur laisse le perdant attendre jusqu'à `actionTimeoutMs`
  (rejet géré, aucune fuite) ; un vrai adaptateur devrait borner les attentes de la même façon.
- **Détection textuelle FR/EN** de `detectCommonBlocker` : chaque adaptateur réel doit la surcharger avec les
  marqueurs propres à son site (éléments balisés plutôt que texte).
- **Deux profils, deux comptes, un même événement** : refusé (verrou). C'est voulu : ce serait multiplier les sessions
  et les paniers.

## Données envoyées à Claude (scénario 10)

Uniquement, pour les **boutons, liens et éléments `data-testid` visibles du contenu principal** : balise, libellé court,
`aria-label`, `data-testid`, `id`, chemin du lien — tous assainis. Jamais : valeurs de champs, `<input>` (hors boutons),
`<textarea>`, `<select>`, titre de la page, texte hors éléments interactifs, en-tête/navigation/pied de page, paramètres
d'URL, cookies, e-mails, cartes, longs nombres, jetons. Un diagnostic n'envoie que les titres de section et les alertes.
Quota : `claude.maxCallsPerRun`. Claude ne clique jamais : il désigne un élément, le code valide (visible, unique, pas un
paiement, attribut stable).

## Isolation de plusieurs instances (scénario 12)

- Un **navigateur par profil** de configuration : `browser.userDataDir` vide → `.profile/<nom du profil>` ; `debugPort: 0` →
  port choisi par Chromium, retrouvé dans `DevToolsActivePort` du profil. Deux bots ne partagent ni onglet, ni cookies,
  ni garde-fous réseau. Un `debugPort` fixe déjà pris par un autre profil est **refusé** plutôt que partagé.
- **Logs** : chaque ligne porte `[profil#PID:…]` ; `logging.file` accepte `{profile}` et `{pid}`.
- **Télémétrie** : un fichier par run, nom horodaté + suffixe aléatoire ; le champ `profile` identifie l'instance.
- **Un seul bot par événement** : verrou `.locks/<événement>.lock` (adaptateur + hôte + chemin, sans paramètres d'URL) ;
  un verrou orphelin (processus mort) est récupéré. Une seconde instance sur le même événement est refusée.
- Vous devez vous connecter une fois par profil (`npm run login -- --profile <nom>`).
