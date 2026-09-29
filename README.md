# ticket-cart-agent

Plateforme Node.js/TypeScript qui **met au panier** des billets dès l'ouverture d'une vente, selon vos critères
(quantité, budget, catégories, places côte à côte, préférence de placement). Un seul cœur, des adaptateurs
indépendants par billetterie. **Le paiement reste toujours manuel** : le bot s'arrête au panier, vous notifie,
et laisse le navigateur ouvert pour que vous vérifiiez et payiez vous-même.

## Limites volontaires (non négociables dans le code)

- Ne contourne ni CAPTCHA, ni file d'attente virtuelle, ni anti-bot, ni limite d'achat, ni authentification.
  Aucun mode furtif. Face à un blocage, le bot **cède la main** (notification + attente) ou **s'arrête**
  (`PURCHASE_LIMIT`) et ne touche plus à la page.
- `behavior.autoPayment: true` est refusé par la validation ; aucune méthode d'adaptateur ne paie ; les URLs de
  paiement sont bloquées pendant que le bot tourne.
- Chaque adaptateur doit déclarer **sur quoi repose son autorisation** (API officielle, CGU l'autorisant, ou démo
  locale), relue depuis moins de 180 jours ; sinon le cœur refuse de le lancer.
- Cadence d'interrogation plafonnée (≥ 200 ms) et respect de `Retry-After`/429.
- **À vous de vérifier** que les conditions d'utilisation du site autorisent ce type d'outil. Beaucoup de
  billetteries interdisent l'automatisation et certaines législations encadrent les bots d'achat. **Aucun
  adaptateur de site réel n'est fourni** : il n'en existe qu'après vérification, site par site.

## Commandes

| Commande | Rôle |
|----------|------|
| `npm run sites` | liste les adaptateurs, leur base d'autorisation et l'état de leur contrat |
| `npm run test:adapters` | vérifie automatiquement que **chaque** adaptateur respecte le contrat (`ADAPTER=<id>` pour un seul) |
| `npm run validate -- config/event.json` | valide une configuration **sans contacter aucun site** (`-- concert` pour un profil, `-- --all` pour tous) |
| `npm run profiles` | liste les profils de `config/events/` et leur validité |
| `npm run simulate` | rejoue le vrai cœur contre un faux site, sans réseau ni navigateur (`-- --all`, `-- --scenario queue`) |
| `npm run platforms` | catalogue des plateformes et statut calculé à partir des preuves (`-- --json`, `-- --check`, `-- --hosts`, `-- --markdown`) |
| `npm run platform verify [nom]` | pièces de preuve exactes à consigner et informations manquantes (aussi `history`, `template`, `check`, `add`) ; aucun accès réseau |
| `npm run doctor` | diagnostic local : Node, Chromium, configs, adaptateurs, preuves et expirations, variables d'environnement, permissions |
| `npm run new-site -- mon-site "Mon Site" --platform <id>` | adaptateur utilisable si la plateforme a un verdict compatible ; sinon squelette marqué `NOT_VERIFIED` ; refus si `NOT_ALLOWED` |
| `npm run login` | connexion manuelle dans la fenêtre du navigateur (session conservée) |
| `npm run check` | valide la config, la conformité et mesure l'horloge du site |
| `npm start` | attend l'ouverture, met au panier, notifie, s'arrête avant le paiement (`-- --profile concert`) |
| `npm run stats` | agrégats de la télémétrie locale (médiane, p95, taux de réussite, raisons d'échec) |
| `npm test` | toute la suite de tests, dont le stress test (hors ligne ; un vrai Chromium local pour les contrôles navigateur) |
| `npm run test:stress` | le stress test seul : 18 scénarios de décision, Claude, concurrence, performance, navigateur réel |
| `npm run demo` | E2E : site factice local + vrai Chromium |

Options communes : `--config <fichier>` ou `--profile <nom>`, `--log-level error|warn|info|debug`, `--log-file`,
`--json` (sites, validate, stats), `--trace` (requêtes lentes), `--exit-when-done`.

## Architecture

```
Core Agent ──▶ Configuration (profil) ──▶ SiteAdapter ──▶ Navigateur / API officielle
   │                                          │
   │  horloge · déclenchement précis          ├─ fetchSale      disponibilité + offres (léger)
   │  filtre + stratégie de classement        ├─ selectOffer / selectSeats
   │  états standardisés (10)                 ├─ addToCart      ──▶ ARRÊT avant paiement
   │  cession de la main / arrêt              └─ detectBlocker  file · CAPTCHA · anti-bot · limite
   └─ télémétrie locale · logs · notification
```

```
src/
  index.ts                 Aiguillage des commandes
  cli/                     sites · validate · simulate · stats · live (run/login/check)
  agent/                   Agent.ts (cœur) · states.ts (10 états) · matcher.ts (filtre + stratégie) · claude.ts (secours)
  config/                  schema.ts · load.ts (profils, extends, migration V1) · validate.ts
  sites/                   SiteAdapter.ts (contrat) · BaseSiteAdapter.ts · compliance.ts · contract.ts · registry.ts (auto-découverte)
                           ExampleSite.ts (seul adaptateur : démo locale, limité à localhost)
  simulation/              scenario.ts · SimulationAdapter.ts · run.ts   (hors src/sites : jamais sélectionnable en réel)
  telemetry/               Telemetry.ts (métriques locales, assainissement, agrégats)
  browser/                 launch.ts (Chromium indépendant + CDP) · cdp.ts · guards.ts (garde-fou paiement)
  selectors/  notifications/  utils/
config/events/             Profils : _base, concert, festival, sport, spectacle
simulations/               Scénarios : nominal, contention, queue, captcha, blocked, login-required, manual-seats, …
docs/                      Guides détaillés (ci-dessous)
```

**Choix du canal** : le cœur ne connaît aucun site. Selon ce que les adaptateurs déclarent et ce que les **preuves officielles**
du catalogue (`platforms/catalog.json`) autorisent, il choisit **API officielle → navigateur → intervention humaine** (rappels,
aucun contact avec le site). Une plateforme non vérifiée n'est jamais automatisée. Voir [docs/PLATFORMS.md](docs/PLATFORMS.md).

**Ajouter un site = déposer un fichier dans `src/sites/`** : découverte automatique, aucun changement du cœur, du
registre, de la config ni des commandes.

## Documentation

| Document | Contenu |
|----------|---------|
| [docs/PLATFORMS.md](docs/PLATFORMS.md) | **catalogue et preuves** : statuts, format et refus des preuves (expiration 180 jours), historique, commandes, interface API, choix du canal API → navigateur → humain |
| [docs/ADDING_A_SITE.md](docs/ADDING_A_SITE.md) | créer un adaptateur : autorisation d'abord, squelette, méthodes, états, offres, sélecteurs, tests, checklist |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | profils et héritage, référence des champs, stratégie de sélection, recettes par type d'événement |
| [docs/STATES_AND_TELEMETRY.md](docs/STATES_AND_TELEMETRY.md) | les 10 états, raisons d'échec, télémétrie locale et vie privée, niveaux de logs |
| [docs/SIMULATION.md](docs/SIMULATION.md) | mode simulation, scénarios fournis, écrire un scénario |
| [docs/STRESS_TESTS.md](docs/STRESS_TESTS.md) | les 18 scénarios de stress, défauts trouvés et corrigés, audit concurrence/boucles/attentes, isolation des instances |

## Démarrage rapide

```bash
npm install
npx playwright install chromium     # ou CHROMIUM_PATH vers un Chrome/Chromium existant
cp .env.example .env
cp config/event.example.json config/event.json

npm run sites                       # adaptateurs disponibles
npm run validate -- --all           # profils valides ?
npm run simulate -- --all           # 33 scénarios (dont 21 de stress) contre le vrai cœur, sans réseau
npm test                            # suite complète
npm run demo                        # bout en bout avec Chromium et le site factice
```

Avec un adaptateur autorisé : `npm run login` (une fois) → `npm run validate -- <profil>` → `npm start -- --profile <profil>`
quelques minutes avant l'ouverture. Quand le panier est obtenu : bannière, bip, notification système (et
`NOTIFY_WEBHOOK_URL` si défini), puis le bot s'arrête ; Chromium reste ouvert sur le panier, vous payez vous-même.
Blocage (file, CAPTCHA, connexion) : notification « Action requise », le bot cesse toute action et reprend quand
c'est réglé. Gardez `browser.headless: false` pour un vrai événement (sinon la cession de la main est impossible).

## Site de démonstration

```bash
npm run demo -- --headed                    # fenêtre visible
npm run demo:server -- 30 --contention      # vente dans 30 s ; affiche le saleTime à copier
npm run demo:server -- 30 --queue=8         # + salle d'attente factice → teste la cession de la main
```
Identifiants du site démo : `demo@example.com` / `demo` (`config/event.example.json` pointe vers lui).

## Mesurer et réduire la latence

Chaque run écrit un fichier de télémétrie locale ; `T = 0` est l'heure officielle d'ouverture :
`triggered → availability-detected → offer-selected → added-to-cart → cart-verified`.
Métriques : temps jusqu'à la disponibilité, à la sélection, au panier ; tentatives ; raison d'échec
(voir [docs/STATES_AND_TELEMETRY.md](docs/STATES_AND_TELEMETRY.md)). `npm run stats` les agrège.

Optimisations en place, toutes conformes aux règles ci-dessus :
- **Pas de LLM sur le chemin nominal** : classement pur, sélecteurs déterministes ; Claude n'intervient qu'en cas d'échec.
- **Horloge** calée façon NTP (échantillon au plus petit RTT) ; sans heure serveur précise, repli sur l'en-tête `Date` (±500 ms).
- **Préchauffage** avant l'ouverture : connexion, page chargée, connexion HTTP/TLS ouverte.
- **Détection sans rendu** (`fetchSale` léger), deep links, locators combinés, attentes événementielles, aucun `sleep` chaud.
- **CDP** : images/polices/analytics bloqués pendant la course, timers non bridés, `--trace` pour DNS/connexion/TTFB.

Pistes : machine proche du serveur, Ethernet, API officielle du site quand elle existe, cadence réduite seulement si
le site l'autorise.

## Gérer les changements de structure d'un site

Sélecteurs en couches (`data-testid` → rôle/aria → texte → classes) ; toute la connaissance du site isolée dans
l'adaptateur ; auto-réparation optionnelle par Claude (`claude.enabled`), validée par le code et mémorisée dans
`.cache/healed-selectors.json` ; tests sur pages enregistrées ; répétition sur un événement peu tendu avant le jour J.
Détails : [docs/ADDING_A_SITE.md](docs/ADDING_A_SITE.md#6-sélecteurs-et-résilience).

## Pistes pour la suite

- Adaptateurs réels, un par un, chacun après relecture de ses CGU et avec ses fixtures.
- Événements réseau (SSE/WebSocket) au lieu du polling quand un site pousse l'ouverture.
- Lecture assistée de plans de salle par Claude (vision), toujours validée par le code.
- Rappel avant expiration du panier, reprise après crash, notifications mobiles natives.
