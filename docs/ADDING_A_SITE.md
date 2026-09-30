# Créer un adaptateur pour une nouvelle billetterie

Objectif : ajouter un site en **déposant un fichier** dans `src/sites/`. Le cœur (`src/agent/`), le registre,
le schéma de configuration et les commandes ne changent pas. Tout ce qui est propre à un site vit dans
l'adaptateur et dans son fichier de sélecteurs.

```
config profil ─▶ Core Agent ─▶ SiteAdapter (votre fichier) ─▶ navigateur / API officielle
                    │
                    ├─ horloge, déclenchement, classement des offres, stratégie
                    ├─ états standardisés, cession de la main, arrêt sur limite d'achat
                    └─ télémétrie, logs, notification, arrêt AVANT le paiement
```

Sommaire : [0. Autorisation](#0-avant-tout-code--lautorisation-bloquant) · [1. Squelette](#1-générer-le-squelette) ·
[2. Métadonnées](#2-métadonnées-et-capacités) · [3. Méthodes](#3-implémenter-les-méthodes) ·
[4. États](#4-signaler-les-états-au-cœur) · [5. Offres](#5-normaliser-les-offres) ·
[6. Sélecteurs](#6-sélecteurs-et-résilience) · [7. Paiement](#7-garde-fou-de-paiement) ·
[8. Latence](#8-optimiser-ce-qui-est-autorisé) · [9. Tests](#9-tester-sans-jamais-toucher-une-vente-réelle) ·
[10. Checklist](#10-checklist-avant-mise-en-service) · [11. Pièges](#11-pièges-fréquents)

---

## 0. Avant tout code : l'autorisation (bloquant)

**La décision se consigne d'abord sous forme de preuve** : un fichier `platforms/evidence/<plateforme>-<date>.json`
(URL HTTPS sur un domaine officiel de la plateforme, date de lecture, extrait cité, canal autorisé ; voir
[PLATFORMS.md](PLATFORMS.md)). Le statut (`NOT_VERIFIED`, `API_ONLY`, `BROWSER_ONLY`, `API_AND_BROWSER`,
`HUMAN_ONLY`, `EXPIRED`, `NOT_ALLOWED`) est **calculé** ; la preuve expire après 180 jours. Le cœur **refuse** tout adaptateur dont la
plateforme n'est pas vérifiée pour son canal. `npm run platform verify <plateforme>` liste les pièces manquantes ;
`npm run platforms -- --check` refuse qu'un adaptateur existe pour une plateforme non vérifiée.

Répondez d'abord à ces questions **en lisant les documents du site** (CGU, règles d'achat, conditions
générales de vente, page développeur/partenaires) :

| Question | Si la réponse est… |
|----------|--------------------|
| Le site propose-t-il une **API officielle** ou un programme d'intégration ? | Utilisez-la : `policy: "official-api"`, `officialApi: true`. C'est toujours la voie à privilégier. |
| Les CGU **autorisent-elles expressément** un outil qui pré-remplit/ajoute au panier pour votre compte personnel ? | `policy: "permitted-by-terms"`. Notez la clause dans `compliance.notes`. |
| Les CGU **interdisent-elles** l'automatisation, les robots, les scripts d'achat ? | **Arrêtez-vous.** N'écrivez pas l'adaptateur. |
| Silence ou ambiguïté des CGU ? | Traitez comme « non autorisé » : demandez une confirmation écrite au site (support, contact partenaires). |
| Quelles **limites d'achat** (billets par personne/commande) ? | Notez-les ; la plateforme ne les contourne jamais. |
| Le site utilise-t-il une **file d'attente virtuelle**, un CAPTCHA, un anti-bot ? | Normal : vous ne les contournerez pas. Prévoyez la cession de la main (§4). |

Si l'automatisation est interdite, il reste des voies légitimes : alertes officielles de mise en vente,
application officielle du site, préparation manuelle (compte connecté, moyen de paiement enregistré, page
ouverte) puis achat à la main, liste d'attente ou revente officielle du site.

Cette décision est **enregistrée dans le code** (`meta.compliance`, §2) et **appliquée par le cœur** : sans
déclaration valide et relue depuis moins de 180 jours, le cœur refuse de démarrer l'adaptateur.
Ce garde-fou force une décision explicite site par site ; ce n'est pas un avis juridique.

**Un adaptateur par canal.** Pour une plateforme qui autorise à la fois l'API et l'interface, écrivez deux adaptateurs
(`MonSiteApi.ts` avec `channel: "official-api"`, `MonSiteWeb.ts` avec `channel: "browser"`) ayant le même `platform`. Le cœur
choisit seul : API officielle si elle est autorisée et si ses prérequis sont là, sinon navigateur si l'interface est
explicitement autorisée, sinon intervention humaine (rappels, aucun contact avec le site).

## 1. Générer le squelette

```bash
npm run new-site -- mon-site "Mon Site"
```

Crée `src/sites/MonSite.ts`, `src/selectors/mon-site.ts` et `tests/mon-site.test.ts`. Avec
`--platform <id du catalogue> [--channel api|browser]` :

- statut compatible → adaptateur utilisable (`meta.platform` / `meta.channel` renseignés) ;
- `NOT_VERIFIED` / `EXPIRED` → **squelette marqué `@skeleton-status NOT_VERIFIED`**, non conforme, jamais lancé ;
- `NOT_ALLOWED` / `HUMAN_ONLY`, ou canal non autorisé par les preuves → refus, aucun fichier.

Sans `--platform`, le squelette est non conforme : les champs `TODO(COMPLIANCE)` doivent être renseignés, sinon
`npm run test:adapters` échoue et le cœur refuse de le lancer. Vérifiez qu'il est bien découvert :

```bash
npm run sites        # une ligne par adaptateur, avec l'état du contrat (✓ OK / ✗ KO)
```

Règles de découverte : le fichier est `src/sites/<Nom>.ts`, il **exporte par défaut une classe** à constructeur
sans argument, et son `meta.id` est unique (`[a-z0-9-]+`). Les noms `SiteAdapter`, `BaseSiteAdapter`, `registry`,
`compliance` et `contract` sont réservés à l'infrastructure.

**Procédure complète d'ajout d'une plateforme** (ordre obligatoire) :

1. `npm run platform verify <id>` : pièces exactes à consigner. 2. Lire **vous-même** la source officielle ; `npm run platform template <id>`,
   remplir (URL de la page lue, date, extrait recopié, canal), `npm run platform add <fichier>`. 3. `npm run platforms` : le statut
   doit inclure le canal voulu (sinon stop : canal humain). 4. `npm run new-site -- <id> "<Nom>" --platform <id> --channel api|browser`.
5. Implémenter le minimum (découverte, disponibilité, offres, prix, catégorie, quantité, sélection, panier) ; **jamais** de paiement.
6. Déclarer les hôtes : pour l'API, `new ApiClient({ allowedHosts, baseUrl, … })` et exposer `client` (le cœur vérifie que ces hôtes sont
   dans `officialHosts`) ; pour le navigateur, `networkHosts()` si l'adaptateur contacte d'autres hôtes que la page d'événement.
7. Fixtures locales (faux serveur / HTML) : sold-out, file, CAPTCHA, login, prix, quantité, sièges ensemble, panier incohérent,
   autorisation, hôtes. 8. `npm run test:adapters`, `npm test`, `npm run doctor`. 9. Seulement ensuite, éventuellement, un essai réel minimal
   — jamais sur une vente réelle sans vous — qui s'arrête à `CART_SUCCESS`.

**Responsabilités de l'adaptateur** : implémentation technique d'un canal, détection des blocages (jamais leur contournement),
déclaration honnête de `meta` (canal, prérequis, limites d'achat). Il ne décide **pas** de l'autorisation (preuves), ne choisit pas
son canal (cœur), ne paie pas.

## 2. Métadonnées et capacités

```ts
readonly meta: AdapterMeta = {
  id: "mon-site",
  displayName: "Mon Site",
  platform: "mon-site",                 // entrée du catalogue (défaut : id). Une plateforme peut avoir un adaptateur par canal.
  channel: "official-api",              // "official-api" | "browser" (défaut : déduit de capabilities.officialApi)
  requires: { env: ["MONSITE_API_KEY"] }, // variables d'environnement nécessaires (noms seulement, jamais de valeur) ; absentes → canal suivant
  compliance: {
    policy: "official-api",                       // "official-api" | "permitted-by-terms" | "demo"
    termsUrl: "https://…/conditions",             // https obligatoire : la page qui fonde la décision
    reviewedAt: "2026-10-01",                     // AAAA-MM-JJ, expire après 180 jours
    notes: "Art. 4.2 : l'ajout au panier assisté est permis pour un compte personnel. Limite : 4 billets.",
  },
  capabilities: {
    officialApi: true,              // API officielle plutôt que pilotage de pages
    preciseServerTime: false,       // true ⇒ implémenter getServerTime()
    lightweightAvailability: true,  // fetchSale() sans rendu de page
    reportsSeatAdjacency: false,    // le site dit-il si des places sont côte à côte ?
    seatSelection: "manual",        // "none" | "automatic" (⇒ selectSeats()) | "manual" (l'humain choisit)
    maxTicketsPerOrder: 4,          // (optionnel) limite d'achat officielle : le cœur refuse de démarrer au-delà, sans rien tenter
  },
};
```

`maxTicketsPerOrder` est la limite d'achat du site quand elle est connue à l'avance : si `tickets.quantity` la dépasse, le
cœur s'arrête **avant tout appel** (`PURCHASE_LIMIT`) et `validate` le signale ; le bot ne cherche jamais à la contourner
(ni par plusieurs commandes, ni par plusieurs comptes).

Les capacités servent à `npm run validate` (avertit d'une stratégie incompatible, p. ex.
`seatsTogetherStrict` sur un site qui ne renseigne pas l'adjacence) et au contrat (cohérence
déclaration ↔ méthodes). `policy: "demo"` est limité à `localhost` : il ne peut jamais viser un vrai site.

## 3. Implémenter les méthodes

Étendez `BaseSiteAdapter` : elle fournit déjà une connexion **manuelle** par défaut, `prepare`,
`detectBlocker` (file d'attente, CAPTCHA, anti-bot, limite d'achat par détection de texte/éléments) et des
motifs de paiement par défaut.

| Méthode | Rôle | Doit… |
|---------|------|-------|
| `resolveEventUrl(config)` | URL de la page événement | par défaut `config.event.url` (obligatoire) |
| `isLoggedIn(ctx)` *(abstraite)* | La session du compte existant est-elle active ? | lire seulement ; pas de saisie d'identifiants par défaut |
| `ensureLoggedIn(ctx)` | Authentification | par défaut : `NotLoggedInError` ⇒ le cœur cède la main (`npm run login`) |
| `prepare(ctx)` | Pré-chauffage avant l'ouverture | charger la page, ouvrir les connexions ; pas d'action d'achat |
| `getServerTime?(ctx)` | Heure serveur (epoch ms) | seulement si le site l'expose ; sinon repli sur l'en-tête `Date` (±500 ms) |
| `fetchSale(ctx)` *(abstraite)* | Disponibilité + offres | **léger** (API/HTTP), retourner `{ open, offers, soldOut? }` ; `RateLimitedError` sur 429 |
| `selectOffer(ctx, offer, qty)` *(abstraite)* | Ouvrir l'offre, régler la quantité | `OfferUnavailableError` si vendue ; `BlockerError` si file/CAPTCHA |
| `selectSeats?(ctx, offer, qty)` | Choix des places | automatique, ou `BlockerError({state:"MANUAL_SELECTION"})` pour laisser l'humain choisir |
| `addToCart(ctx)` *(abstraite)* | Ajout au panier | attendre la confirmation **ou** l'erreur (course d'événements), jamais de `sleep` |
| `readCart(ctx)` *(abstraite)* | Lire le panier | quantité, prix unitaires, total, expiration si affichée |
| `detectBlocker(ctx)` | État bloquant courant | lecture seule, **rapide** (appelée à chaque lecture de disponibilité, bornée à 250 ms) ; surchargez pour les marqueurs propres au site (éléments balisés plutôt que texte) |
| `validateOptions?(opts)` | Valide `siteOptions` | retourne des messages d'erreur (vide = OK) ; appelé par `npm run validate` |

Squelette d'un `fetchSale` par API officielle :

```ts
async fetchSale(ctx: AdapterContext): Promise<SaleSnapshot> {
  const res = await ctx.context.request.get(`${API}/events/${id}/offers`);   // cookies du navigateur partagés
  if (res.status() === 429) throw new RateLimitedError(Number(res.headers()["retry-after"] ?? 2) * 1000);
  if (!res.ok()) throw new Error(`API offres : HTTP ${res.status()}`);
  const body = (await res.json()) as ApiOffers;
  return {
    open: body.onSale,
    soldOut: body.status === "SOLD_OUT",
    offers: body.items.map((o): Offer => ({
      id: o.id, category: o.categoryName, pricePerTicket: o.price.amount, currency: o.price.currency,
      available: o.remaining, seatsTogether: o.adjacent ?? "unknown", section: o.section, row: o.row,
    })),
  };
}
```

`ExampleSite.ts` est une implémentation complète de référence (API légère + deep link + course
succès/erreur).

## 4. Signaler les états au cœur

Vous remontez seulement des états **bloquants** ; le cœur produit `AVAILABLE`, `SOLD_OUT`, `CART_SUCCESS`
et `ERROR` (voir [STATES_AND_TELEMETRY.md](STATES_AND_TELEMETRY.md)).

| Situation | Comment la signaler | Réaction du cœur |
|-----------|--------------------|------------------|
| File d'attente virtuelle | `detectBlocker` → `{state:"QUEUE"}` ou `throw new BlockerError({state:"QUEUE", …})` | cesse toute action, notifie, reprend à la disparition ou sur Entrée |
| CAPTCHA | `CAPTCHA` | idem |
| Contrôle anti-bot / accès refusé | `BLOCKED` | idem |
| Session absente/expirée | `throw new NotLoggedInError()` (ou `LOGIN_REQUIRED`) | cession de la main jusqu'à Entrée |
| Plan de salle à choisir | `throw new BlockerError({state:"MANUAL_SELECTION", …})` dans `selectSeats` | cession de la main, puis le cœur **continue** (l'humain a fait l'étape) |
| Limite d'achat atteinte | `PURCHASE_LIMIT` | **arrêt définitif**, aucune insistance, aucun autre essai |
| Offre vendue entre-temps | `throw new OfferUnavailableError()` | tente l'offre suivante (`cart.maxAttempts`) |
| Le site demande de ralentir | `throw new RateLimitedError(ms)` | attend puis continue |

Interdit dans un adaptateur, sans exception : résoudre/contourner un CAPTCHA, contourner ou « doubler » une file
d'attente, masquer l'automatisation (user-agent, empreinte, `webdriver`…), tourner des proxys, créer ou
multiplier des comptes, dépasser une limite d'achat, cliquer un bouton de paiement, manipuler des données
bancaires. Le contrat scanne le code source à la recherche de ces motifs (heuristique, non exhaustive) — la
règle reste une règle de conception, pas seulement un test.

## 5. Normaliser les offres

`fetchSale` retourne des `Offer` dans un format unique ; le moteur de classement ne connaît rien d'autre :

| Champ | Sens |
|-------|------|
| `id` | identifiant stable de l'offre (sert à la sélection) |
| `category` | libellé de catégorie tel qu'affiché (comparaison insensible à la casse/accents, égalité exacte) |
| `pricePerTicket`, `currency` | prix **unitaire** (frais inclus si le site les affiche) |
| `available` | nombre de billets **achetables ensemble** dans cette offre |
| `seatsTogether` | `true` / `false` / `"unknown"` — n'inventez pas : `"unknown"` si le site ne le dit pas. Helper : `seatsAreContiguous(seats, qty)` |
| `section`, `row`, `seats` | alimentent le critère `placement` de la stratégie |
| `url` | lien direct vers l'offre si le site en fournit un (évite de passer par la liste) |

La **stratégie** (prix maximum, catégories, côte à côte, placement, ordre de priorité) est appliquée par le
cœur à partir de la configuration : l'adaptateur ne classe jamais les offres.

## 6. Sélecteurs et résilience

Dans `src/selectors/<id>.ts`, décrivez chaque élément par un `SelectorSpec` : `name`, `description` (en langage
naturel), `candidates` **du plus stable au plus fragile** (`data-testid`, rôle/aria, texte, classes CSS en
dernier). Le résolveur les combine (`.or()`) : un seul aller-retour navigateur.

Si un site change et qu'un sélecteur casse, avec `claude.enabled: true` Claude reçoit un résumé des éléments
interactifs et **désigne** l'élément décrit ; le code valide (visible, unique, pas un paiement, attribut stable)
et mémorise dans `.cache/healed-selectors.json`. Écrivez de bonnes `description` : c'est ce que Claude lit.
Claude n'intervient qu'en cas d'échec (jamais sur le chemin nominal) et ne clique jamais lui-même.

## 7. Garde-fou de paiement

Tant que le bot tourne, toute navigation vers une URL de paiement est annulée puis, à la fin, le garde-fou est
levé pour que **vous** payiez à la main. `BaseSiteAdapter` fournit `/payment`, `/paiement`, `/checkout/pay`,
`/pay`. Si le site utilise un autre chemin, surchargez :

```ts
override readonly paymentUrlPatterns = [/\/mon-tunnel-de-paiement(\/|\?|#|$)/i];
```

Le contrat vérifie que les motifs ne portent pas de drapeau `g`/`y` (test à état), ne bloquent ni `/`, ni
`/event`, ni `/cart`, ni `/panier`, et ressemblent à une URL de paiement.

## 8. Optimiser ce qui est autorisé

Autorisé : démarrer plus vite (préchauffage dans `prepare`, connexions ouvertes), détecter la disponibilité par
un appel léger plutôt qu'un rendu, deep links, sélecteurs robustes, locators combinés, attentes
événementielles, moins d'appels à Claude, mesure précise. Mesurez avec `--trace` et la télémétrie
(`npm run stats`). Interdit : augmenter la cadence au-delà de ce que le site tolère (`timing.pollIntervalMs`),
paralléliser des sessions/comptes, ou toute technique de contournement (§4).

## 9. Tester sans jamais toucher une vente réelle

Trois niveaux, tous hors ligne :

1. **Contrat (automatique)** : `npm run test:adapters` (ou `ADAPTER=mon-site npm run test:adapters`). Vérifie
   méthodes, capacités cohérentes, autorisation valide et récente, garde-fou de paiement, scan du code source.
2. **Tests d'adaptateur sur pages enregistrées** : `tests/mon-site.test.ts` + `tests/fixtures/mon-site/…` (HTML/JSON
   réellement enregistrés). Testez : `fetchSale` normalise prix/catégorie/quantité/adjacence ; `detectBlocker`
   reconnaît file, CAPTCHA, limite d'achat sur les pages enregistrées ; `paymentUrlPatterns`. Modèle :
   `tests/exampleSite.test.ts` (API sans navigateur via `request.newContext()`).
3. **Simulation du cœur** : `npm run simulate` rejoue le vrai cœur contre un faux site, avec votre profil de
   configuration (voir [SIMULATION.md](SIMULATION.md)). Utile pour vérifier votre stratégie et les réactions
   aux blocages avant le jour J.

Puis : `npm run validate -- config/events/mon-profil.json` (cohérence config ↔ capacités ↔ conformité), un essai
sur un événement peu tendu **en votre présence**, et jamais sur une vente réelle sans vous.

## 10. Checklist avant mise en service

- [ ] CGU/API lues ; décision consignée dans `meta.compliance` (`termsUrl`, `reviewedAt`, `notes`) ; automatisation permise.
- [ ] Aucune méthode ne contourne CAPTCHA, file, anti-bot, limite d'achat, authentification ; aucun paiement.
- [ ] `fetchSale` léger, `RateLimitedError` géré, cadence conforme à ce que le site tolère.
- [ ] `seatsTogether` fidèle (`"unknown"` si le site ne renseigne pas) ; `capabilities` exactes.
- [ ] `detectBlocker` reconnaît file/CAPTCHA/blocage/limite sur des pages enregistrées.
- [ ] `paymentUrlPatterns` couvre le tunnel de paiement du site.
- [ ] `npm run sites` → ✓ OK ; `npm run test:adapters` vert ; tests sur fixtures verts.
- [ ] `npm run validate` sans erreur sur le profil visé ; `npm run simulate -- --all` conforme.
- [ ] Rappel : `reviewedAt` expire après 180 jours — replanifiez la relecture des CGU.

## 11. Pièges fréquents

- **Oubli de l'export par défaut** : le registre refuse le fichier (`doit exporter par défaut une classe`).
- **`meta.id` en double ou avec majuscules/espaces** : refusé (`[a-z0-9-]+`, unique).
- **Motif de paiement avec drapeau `g`** : `test()` devient à état, le garde-fou laisse passer une fois sur deux.
- **Motif de paiement trop large** (`/pay/` matche `/payment-methods-info`) : bloquerait des pages légitimes.
- **`seatsTogether: true` par défaut** « parce que ça arrive souvent » : faux positifs, l'utilisateur paie des places séparées.
- **`sleep` sur le chemin chaud** : attendez un élément ou un événement, pas une durée.
- **Clic sur un bouton dont le libellé contient « Payer/Commander »** : refusé par le scan du code et par le garde-fou.
- **`detectBlocker` trop bavard** : il s'exécute avant chaque sélection ; une FAQ qui mentionne « file d'attente » ou une
  bannière « limite de 4 billets par commande » ne doivent pas déclencher de cession de main. Les motifs par défaut
  n'agissent que sur des pages courtes / des limites *atteintes* ; testez le vôtre sur des pages enregistrées.
- **Chaîne de gabarit dans un script de page** : une apostrophe mal échappée dans un script évalué dans la page fait
  échouer tout le script, et l'erreur est avalée (aucune détection). Utilisez `String.raw` (voir `selectors/blockers.ts`).
- **Headless** : impossible de céder la main ; `validate` refuse `headless` avec `seatSelection: "manual"`.
