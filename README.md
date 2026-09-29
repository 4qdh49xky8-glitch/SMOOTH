# ticket-cart-agent

Agent Node.js/TypeScript qui **met au panier** des billets dès l'ouverture d'une vente, selon vos critères
(quantité, budget, catégories, places côte à côte). **Le paiement reste toujours manuel** : le bot s'arrête
au panier, vous notifie, et laisse le navigateur ouvert pour que vous vérifiiez et payiez vous-même.

## Limites volontaires (non négociables dans le code)

- Ne contourne ni CAPTCHA, ni file d'attente virtuelle, ni anti-bot, ni limite d'achat. Aucun mode furtif
  (pas de `AutomationControlled`, pas de fingerprint spoofing). Face à un blocage, le bot **cède la main**
  (notification + attente) et ne touche plus à la page.
- `autoPayment: true` est refusé par la validation de config ; aucune méthode d'adaptateur ne paie ;
  les URLs de paiement sont bloquées pendant que le bot tourne (`browser/guards.ts`).
- Cadence d'interrogation plafonnée (≥ 200 ms, défaut 400 ms + gigue) et respect de `Retry-After`/429.
- **À vous de vérifier** que les conditions d'utilisation du site autorisent ce type d'outil. Beaucoup de
  billetteries interdisent l'automatisation et certaines législations encadrent les bots d'achat : n'écrivez
  un adaptateur que pour un site qui l'autorise, avec votre propre compte et votre propre moyen de paiement.

## Architecture générique

Un seul cœur, des adaptateurs indépendants :

```
Core Agent ──▶ Event Configuration ──▶ SiteAdapter ──▶ Navigateur / API officielle
   │                                        │
   │   horloge · déclenchement précis       ├─ fetchSale      disponibilité + offres (léger)
   │   matching déterministe des offres     ├─ selectOffer / selectSeats
   │   gestion des blocages (cession/arrêt) ├─ addToCart      ──▶ ARRÊT avant paiement
   └─ notification · mesure de latence      └─ detectBlocker  file · CAPTCHA · anti-bot · limite
```

```
src/
  index.ts                 CLI : run | login | check | --list-sites
  config/  schema.ts load.ts       Config générique (event/sale/tickets/behavior), migration de l'ancien format
  sites/   SiteAdapter.ts          Contrat (meta, capacités, conformité, méthodes)
           BaseSiteAdapter.ts      Comportements par défaut sûrs (connexion manuelle, blocages, paiement)
           compliance.ts           Refus d'un adaptateur sans base d'autorisation valide et récente
           registry.ts             Découverte AUTOMATIQUE de src/sites/*.ts (aucun enregistrement manuel)
           ExampleSite.ts          Seul adaptateur fourni (démo locale, limité à localhost)
  browser/ launch.ts cdp.ts guards.ts   Chromium indépendant + CDP, blocage réseau, garde-fou paiement
  agent/   Agent.ts matcher.ts claude.ts
  selectors/ resolver.ts blockers.ts example.ts
  notifications/ notify.ts
  utils/   clock.ts scheduler.ts timing.ts logger.ts errors.ts prompt.ts
docs/ADDING_A_SITE.md      Guide pas à pas + checklist d'autorisation
demo/ scripts/ tests/      Site factice, E2E, tests (cœur avec faux adaptateur, contrat d'adaptateur, config…)
```

**Ajouter un site = déposer `src/sites/MonSite.ts`** (export par défaut) : ni le cœur ni le registre ne changent.
Aucun adaptateur de site réel n'est fourni volontairement : il n'en existe qu'après vérification que le site
l'autorise (voir `docs/ADDING_A_SITE.md`).

### Configuration générique

```json
{
  "site": "example",
  "event": { "name": "Nom de l'événement", "date": "2026-12-01", "url": "http://127.0.0.1:4173/event" },
  "sale": { "startTime": "2026-10-01T10:00:00+02:00" },
  "tickets": { "quantity": 2, "maxPricePerTicket": 150, "categories": [], "seatsTogether": true },
  "behavior": { "autoAddToCart": true, "autoPayment": false }
}
```
`categories: []` = toutes les catégories ; sinon l'ordre est la préférence. `siteOptions` transmet des réglages
propres à l'adaptateur. L'ancien format plat (V1) est migré automatiquement. `autoPayment: true` est refusé.

### États bloquants (identiques pour tous les sites)

| État | Réaction du cœur |
|------|------------------|
| `queue`, `captcha`, `anti-bot` | Le bot cesse toute action, notifie ; reprise à la disparition (détection) ou Entrée |
| `login-required`, `human-step` (plan de salle…) | Cession de la main jusqu'à Entrée |
| `purchase-limit` | **Arrêt définitif** (`status: "blocked"`), jamais contourné |

Flux : `T − preArm` login (manuel) + chargement → recalage d'horloge → attente précise → **GO** à `sale.startTime`
→ `fetchSale` → `rankOffers` (côte à côte → ordre des catégories → prix) → `selectOffer` (`selectSeats`) → `addToCart`
→ `readCart` → notification → arrêt (navigateur ouvert pour le paiement manuel).

## Installation

```bash
npm install
npx playwright install chromium     # ou renseignez CHROMIUM_PATH vers un Chrome/Chromium existant
cp .env.example .env                # puis éditez si besoin
cp config/event.example.json config/event.json
```

## Lancer le bot

```bash
npm run login      # 1 fois : connectez-vous à la main dans la fenêtre (session conservée dans .profile)
npm run check      # valide config + conformité de l'adaptateur + décalage d'horloge / RTT
npm run check -- --list-sites   # adaptateurs découverts
npm start          # attend l'ouverture, met au panier, notifie, s'arrête
npm start -- --trace   # + journal des requêtes lentes (DNS/connect/TTFB)
```

Lancez `npm start` **quelques minutes avant** l'ouverture (il se prépare à `saleTime − preArmSeconds`).
Quand le panier est obtenu : bannière + bip + notification OS (+ `NOTIFY_WEBHOOK_URL`). Le bot s'arrête,
Chromium reste ouvert sur le panier : vérifiez et payez vous-même. Blocage (file/CAPTCHA) : notification
« Action requise » ; traitez-le à la main, le bot reprend seul (ou Entrée dans le terminal).
Le mode `headless` ne permet pas ce passage de main : gardez `headless: false` pour un vrai événement.

## Tester avec le site de démonstration

```bash
npm test                 # tests unitaires
npm run demo             # E2E headless : site local + vrai Chromium, contention simulée
npm run demo -- --headed # même chose avec fenêtre visible
# Mode manuel :
npm run demo:server -- 30 --contention      # vente dans 30 s ; affiche le saleTime à copier
#   puis dans la config : "eventUrl": "http://127.0.0.1:4173/event", saleTime = valeur affichée
npm run demo:server -- 30 --queue=8         # + salle d'attente factice 8 s → teste le passage de main humain
```

Identifiants du site démo : `demo@example.com` / `demo`.
Résultat mesuré sur le site démo : panier obtenu à **T + ~350 ms**, dont ~150 ms perdus sur l'offre n°1
volontairement « vendue » (repli automatique vers l'offre n°2).

## Mesurer et réduire la latence

Chaque run écrit `runs/run-*.json` et affiche la chronologie relative à l'heure officielle :
`triggered → sale-detected → offer-ranked → offer-selected → added-to-cart → cart-verified`.

Déjà dans la V1 :
- **Pas de LLM sur le chemin chaud** : matching pur, sélecteurs déterministes ; Claude n'intervient qu'en échec.
- **Horloge** : décalage serveur estimé façon NTP (échantillon au plus petit RTT) ; déclenchement à quelques ms.
  Sans heure serveur précise, repli sur l'en-tête `Date` (±500 ms) : prévoyez alors de l'avance.
- **Préchauffage** : login, page chargée, connexion HTTP/TLS ouverte avant l'ouverture.
- **Détection sans rendu** : `fetchSale` = requête HTTP (`context.request`, cookies partagés).
- **Deep link** vers l'offre (pas de passage par la liste), locators combinés `.or()` (1 aller-retour),
  attentes **événementielles** (`waitFor`, `Promise.any` succès/erreur), aucun `sleep` sur le chemin chaud
  (seule attente : la cadence de polling, volontaire).
- **CDP** : images/polices/analytics bloqués dans le navigateur, focus émulé, timers non bridés.
- `--trace` : décomposition DNS/connexion/TTFB des requêtes > 200 ms.

Pistes : machine proche du serveur, Ethernet plutôt que Wi-Fi, ajout au panier par l'API du site quand elle est
documentée et autorisée, `pollIntervalMs` réduit seulement si le site l'autorise, machine sans autre charge.

## Écrire un adaptateur pour un nouveau site

Voir **[docs/ADDING_A_SITE.md](docs/ADDING_A_SITE.md)** : autorisation d'abord (API officielle prioritaire, CGU relues),
puis un fichier, des sélecteurs, des tests sur pages enregistrées. Le contrat commun est testé automatiquement.

## Gérer les changements de structure d'un site

1. **Sélecteurs en couches** dans `SelectorSpec.candidates` : `data-testid`/rôle/aria d'abord, texte ensuite,
   classes CSS en dernier ; tous essayés d'un coup.
2. **Isolation** : toute la connaissance du site vit dans l'adaptateur + son fichier de sélecteurs.
3. **Auto-réparation** (`claude.enabled: true` + `ANTHROPIC_API_KEY`) : si un sélecteur casse, Claude reçoit un
   résumé des éléments interactifs et désigne l'élément voulu ; le code valide (visible, unique, pas un
   paiement, attribut stable) et mémorise le sélecteur dans `.cache/healed-selectors.json` → le run suivant
   redevient déterministe. Claude ne clique jamais lui-même, limité à `maxCallsPerRun` appels.
4. **Répétition générale** : `npm run check` et un essai sur un événement peu tendu avant le jour J, avec `--trace`.
5. **Contrats** : un test Playwright par adaptateur sur des pages HTML enregistrées (fixtures) pour détecter la dérive.

## De la V1 à la V2

- Plusieurs adaptateurs réels, fixtures/tests par site, sondes de santé.
- Événements réseau (SSE/WebSocket, `Network` CDP) au lieu du polling quand le site pousse l'ouverture.
- Claude pour lire des plans de salle/offres non structurées (vision), avec validation stricte côté code.
- Rappel avant expiration du panier, reprise après crash (état persistant).
- Notifications mobiles natives (ntfy/Pushover), agrégation de latence sur plusieurs répétitions.
- Mode « rejeu » (HAR) pour régler la latence sans toucher au vrai site.
