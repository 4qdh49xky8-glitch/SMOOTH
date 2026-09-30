# Fixtures : tester un futur adaptateur en local

> **TEST_ONLY · NOT_A_REAL_PLATFORM.** Le kit (`testkit/`) est 100 % local (127.0.0.1, `fetch` simulé). Il n'atteste rien sur une
> plateforme réelle : il sert à écrire et à valider un adaptateur **avant** tout contact réel, et à ne jamais contacter un site réel
> pour tester un sélecteur quand une fixture suffit.

## Contenu

| Fichier | Rôle |
|---------|------|
| `testkit/scenarios.ts` | les 10 scénarios, le jeu d'offres canonique (prix, catégories, quantités, sièges adjacents ou non), les attentes d'adjacence |
| `testkit/fixtureSite.ts` | faux site local paramétrable : `startFixtureSite({ scenario, skin?, … })`. Consigne `state.requests` (méthode + chemin), compte `paymentHits` |
| `testkit/browserAdapterSuite.ts` | `defineBrowserAdapterSuite(...)` : la suite de conformité d'un adaptateur navigateur (vrai Chromium local) |
| `testkit/apiAdapterSuite.ts` | `defineApiAdapterSuite(...)` : la même chose pour un adaptateur API, avec un faux `fetch` par scénario |
| `testkit/fakeApi.ts` | exemple de fixture d'API (`fakeApi`, `FakeApiAdapter`) |

## Scénarios

`nominal` (plusieurs offres, prix, catégorie, quantité, sièges adjacents) · `not-open` · `sold-out` · `queue` · `captcha` · `blocked` ·
`login-required` · `purchase-limit` · `contention` (offre vendue entre-temps) · `cart-mismatch` (le site ajoute moins de billets).

Ce que la suite vérifie pour chacun : offres normalisées (prix, catégorie, quantité, adjacence **ou `"unknown"`**), `SOLD_OUT`, `QUEUE` /
`CAPTCHA` / `BLOCKED` détectés **sans aucune action** sur le site, `NotLoggedInError` sans connexion automatique, arrêt à la limite d'achat
(une seule tentative), `OfferUnavailableError` sur contention, panier relaté fidèlement, **zéro requête de paiement**, garde réseau
(paiement + hôtes) installé comme en production, contrat d'adaptateur sans erreur.

## Utiliser le kit pour un nouvel adaptateur

```ts
// tests/mon-site.fixtures.test.ts
import { defineBrowserAdapterSuite } from "../testkit/browserAdapterSuite.js";
import { startFixtureSite } from "../testkit/fixtureSite.js";
import MonSite from "../src/sites/MonSite.js";

defineBrowserAdapterSuite({
  label: "MonSite",
  makeAdapter: () => new MonSite(),
  configFor: (url) => /* BotConfig : event.url = `${url}/…`, quantité 2, budget 150 */,
  // Balisage de LA plateforme, reconstitué à partir de pages que VOUS avez enregistrées vous-même (aucun contact automatique) :
  serve: (scenario) => startFixtureSite({ scenario, skin: { event: …, offer: …, cart: …, queue: …, captcha: … } }),
  login: async (page, url) => { /* équivalent de `npm run login` sur le faux site */ },
});
```

- **Balisage** : la `skin` remplace le HTML de chaque page (`event`, `offer`, `cart`, `queue`, `captcha`, `blocked`, `purchaseLimit`, `contention`,
  `login`, `account`, `payment`) ; la logique des scénarios (file, limite, contention…) reste celle du kit.
- **API** : fournissez, par scénario, un faux `fetch` bâti sur des réponses **enregistrées** de l'API officielle documentée
  (`defineApiAdapterSuite({ fixtures: { nominal: () => …, queue: () => …, … } })`).
- L'adaptateur ne doit viser que ses `allowedHosts()` ; en fixture, uniquement des hôtes locaux (le garde réseau du navigateur le vérifie).

## Commandes

```bash
npm run test:fixtures     # kit + contrat d'adaptateur (Chromium local requis : CHROMIUM_PATH)
npm test                  # toute la suite, dont les suites de conformité appliquées aux fixtures TEST_ONLY
npm run demo              # site de démonstration local (le même faux site, scénario nominal) + vrai Chromium
```

## Limites

- Les suites prouvent la **conformité au contrat** sur des pages que vous fournissez ; elles ne prouvent pas que la plateforme réelle se
  comporte ainsi. Un changement de balisage réel n'est détecté que si la fixture est mise à jour.
- Une fixture n'est pas une autorisation : elle ne remplace jamais la preuve officielle (`docs/PLATFORMS.md`).
