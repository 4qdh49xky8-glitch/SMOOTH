# États, télémétrie locale et logs

## États standardisés

Dix états, identiques pour tous les sites (`src/agent/states.ts`). Les adaptateurs remontent uniquement les états
bloquants ; le cœur produit les autres.

| État | Produit par | Signification | Réaction du cœur |
|------|-------------|---------------|------------------|
| `AVAILABLE` | cœur | des offres achetables sont visibles | classe et tente les offres |
| `SOLD_OUT` | cœur | vente ouverte, plus rien d'achetable (ou `soldOut` déclaré par le site) | continue la surveillance (un restock est possible) jusqu'au délai |
| `QUEUE` | adaptateur | file d'attente virtuelle | cesse toute action, notifie ; reprise quand elle disparaît ou sur Entrée |
| `CAPTCHA` | adaptateur | CAPTCHA affiché | idem — résolu par l'humain uniquement |
| `BLOCKED` | adaptateur | contrôle anti-bot / accès refusé | idem — jamais contourné |
| `LOGIN_REQUIRED` | adaptateur | connexion manuelle requise ou session expirée | cession de la main jusqu'à Entrée |
| `MANUAL_SELECTION` | adaptateur / cœur | étape confiée à l'humain (plan de salle, ajout manuel si `autoAddToCart=false`) | cession de la main puis poursuite |
| `PURCHASE_LIMIT` | adaptateur | limite d'achat atteinte | **arrêt définitif**, aucune insistance |
| `CART_SUCCESS` | cœur | billets au panier | notifie, s'arrête **avant le paiement** |
| `ERROR` | cœur | erreur technique ou délai dépassé | s'arrête, raison normalisée dans la télémétrie |

Reprise après un blocage : `QUEUE`, `CAPTCHA`, `BLOCKED` se détectent sur la page (le bot vérifie que le blocage a
disparu deux fois de suite) ; `LOGIN_REQUIRED` et `MANUAL_SELECTION` attendent votre confirmation (Entrée dans le
terminal). En `headless`, la cession est impossible : `ERROR` / `HUMAN_REQUIRED_HEADLESS`.

### Résultat d'un run

`agent.run()` retourne toujours un résultat (il ne lève que si l'adaptateur est refusé avant toute action) :

| `status` | `finalState` typique | `failureReason` possible |
|----------|---------------------|--------------------------|
| `in-cart` | `CART_SUCCESS` | — |
| `ready-not-added` (`autoAddToCart=false`) | `MANUAL_SELECTION` | — |
| `sale-timeout` | `SOLD_OUT`, `AVAILABLE`, `ERROR` | `NO_MATCHING_OFFER`, `MAX_ATTEMPTS`, `SALE_NOT_OPEN_TIMEOUT` |
| `cart-mismatch` | `ERROR` | `CART_MISMATCH` (quantité/prix non conformes), `CART_UNVERIFIED` (panier illisible) |
| `blocked` | `PURCHASE_LIMIT` (ou l'état bloquant) | `PURCHASE_LIMIT` |
| `error` | `ERROR` | `ADAPTER_ERROR`, `SELECTOR_NOT_FOUND`, `RATE_LIMITED`, `HUMAN_REQUIRED_HEADLESS` |

Raisons d'échec normalisées (`FailureReason`) : `SALE_NOT_OPEN_TIMEOUT`, `NO_MATCHING_OFFER`, `MAX_ATTEMPTS`,
`OFFER_UNAVAILABLE`, `CART_MISMATCH`, `CART_UNVERIFIED`, `PURCHASE_LIMIT`, `QUEUE`, `CAPTCHA`, `LOGIN_REQUIRED`, `MANUAL_SELECTION`, `BLOCKED`,
`HUMAN_REQUIRED_HEADLESS`, `SELECTOR_NOT_FOUND`, `RATE_LIMITED`, `ADAPTER_ERROR`. Le code de sortie de
`npm start` est 0 pour `in-cart` ou `ready-not-added`, 1 sinon.

**Panier non conforme** : si le site n'a ajouté qu'une partie des billets ou si le prix dépasse le budget, le panier
n'est **jamais** déclaré réussi (`cart-mismatch`, état `ERROR`). Le bot alerte (« PANIER À VÉRIFIER »), n'ajoute rien
d'autre (pas d'empilement de paniers) et laisse la main à l'humain. La notification « PANIER OBTENU » part **dès
l'ajout**, avant la vérification ; la vérification la confirme ou la corrige.

**Avant toute sélection**, à chaque lecture de disponibilité, le bot lit aussi l'état de la page (en parallèle, sans
latence ajoutée, borné à 250 ms) : file d'attente, CAPTCHA, anti-bot ou connexion affichés ⇒ cession de la main sans
aucune action sur le site.

## Télémétrie locale

Un fichier JSON par run dans `runs/` (`telemetry.dir`) : `run-<date>-<live|simulation>-<id>.json`.
**Tout reste sur votre machine** : rien n'est envoyé, il n'y a aucun service de collecte.

| Métrique | Définition |
|----------|------------|
| `timeToAvailabilityMs` | ouverture officielle → première disponibilité détectée (`AVAILABLE`) |
| `timeToSelectionMs` | disponibilité détectée → dernière offre sélectionnée avec succès |
| `timeToCartMs` | ouverture officielle → dernier ajout au panier |
| `attempts` | nombre d'offres tentées (la tentative réussie comprise) |
| `humanHandoffs` | nombre de cessions de la main |
| `polls`, `pollLatencyMs.{avg,p95}` | nombre et latence des lectures de disponibilité |
| `triggerOvershootMs` | dépassement de l'heure cible au déclenchement |
| `clockOffsetMs`, `clockRttMs` | décalage d'horloge estimé et RTT minimal |
| `failureReason` | raison normalisée de l'échec (liste ci-dessus) |
| `states[]`, `attemptsDetail[]`, `timeline[]` | transitions d'états, détail par tentative, jalons horodatés (ms relatives à l'ouverture) |

`T = 0` est toujours l'heure officielle d'ouverture (`sale.startTime`), ce qui rend les runs comparables.

### Ce qui est collecté — et ce qui ne l'est pas

Collecté : identifiant de l'adaptateur, nom du profil, états, durées, compteurs, **catégorie et prix** des offres
tentées, quantité/total/devise du panier, raison d'échec normalisée.

Jamais collecté : identifiants, mots de passe, cookies, e-mail ou nom du compte, URLs, contenu des pages,
numéros de siège ou de commande, adresse IP, texte libre non assaini. Les rares textes libres (détail d'un état
`ERROR`) passent par `sanitize()` : URLs → `<url>`, e-mails → `<email>`, suites de 6 chiffres ou plus → `<num>`,
tronqués. Un test vérifie qu'un fichier enregistré ne contient ni `http`, ni `@`. Désactivation :
`"telemetry": { "enabled": false }`. Suppression : effacez `runs/`.

### Agrégats

```bash
npm run stats                    # médiane / p95 de chaque délai, taux de réussite, états finaux, raisons d'échec
npm run stats -- --mode live     # seulement les vrais runs (ou --mode simulation)
npm run stats -- --json          # sortie JSON
```

## Logs

Quatre niveaux, chacun incluant les plus graves : `ERROR` < `WARN` < `INFO` < `DEBUG` (et `silent`).

| Niveau | Contenu |
|--------|---------|
| `ERROR` | échec qui arrête le run ou l'action |
| `WARN` | situation dégradée : offre vendue, passage de main humaine, cadence limitée, avertissement |
| `INFO` | déroulé normal : horloge, GO, changements d'état, tentatives, bilan |
| `DEBUG` | clés de classement des offres, chronologie détaillée, réglages réseau |

Réglage, par priorité décroissante : `--log-level debug` → variable `LOG_LEVEL` → `logging.level` du profil → `info`.
Fichier : `--log-file runs/bot.log` ou `logging.file` (texte brut, horodatage ISO complet, sans couleurs).

Format : `HH:MM:SS.mmm NIVEAU [périmètre] message`, p. ex. `20:15:02.351 INFO  [agent] État → QUEUE (…)`.
Les périmètres (`agent`, `browser`, `site:<id>`, `guard`, `cdp`, `net`, `sim`) permettent de filtrer avec `grep`.
Les logs ne contiennent ni mot de passe, ni cookie, ni paramètre d'URL (le garde-fou de paiement n'écrit que
l'hôte et le chemin). Le diagnostic optionnel de Claude (`WARN`, si `claude.enabled`) résume le contenu d'une page :
relisez les logs avant de les partager.
