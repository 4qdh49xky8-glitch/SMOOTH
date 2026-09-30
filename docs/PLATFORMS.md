# Plateformes : catalogue, preuves officielles et choix du canal

> **État de l'étude : aucune preuve n'a été consignée. Les 24 plateformes sont `NOT_VERIFIED`.**
> Les sources officielles (CGU, pages développeurs) n'étaient pas joignables depuis l'environnement de développement
> (politique réseau bloquant ces domaines). Cette restriction n'a **pas** été contournée, et aucun résumé de moteur de
> recherche n'est traité comme une preuve. Conséquence : le cœur n'automatise **aucune** plateforme réelle ; il bascule
> sur le canal humain (rappels, aucun contact avec le site).

## Principe

- `platforms/catalog.json` ne contient que des **données statiques** (nom, régions, types d'événements, domaines
  officiels, pistes non vérifiées). Il ne contient **aucune autorisation**.
- L'autorisation ne vient que de fichiers de **preuve** : `platforms/evidence/<plateforme>-<date>[-<sujet>].json`.
- Le **statut est calculé** à chaque lancement à partir des preuves valides. On ne le saisit jamais à la main.
- Une preuve vaut **180 jours** (jour 180 valide, jour 181 expiré), puis la plateforme repasse `EXPIRED`.

## Statuts (autorisation explicite par canal) — modèle FIGÉ

La table ci-dessous est verrouillée par `AUTHORIZATION_MODEL` (objet gelé) et `tests/authModelFrozen.test.ts` : à ne changer que pour une raison majeure.

**L'absence de preuve pour un canal signifie « non autorisé ».**

| Statut | Signification | Canaux automatisés autorisés |
|--------|---------------|------------------------------|
| `NOT_VERIFIED` | aucune preuve valide | aucun (humain) |
| `API_ONLY` | preuve `api` | `official-api` ; le navigateur est **interdit** |
| `BROWSER_ONLY` | preuve `browser` | `browser` ; l'API est **interdite** |
| `API_AND_BROWSER` | preuves `api` + `browser` (ou `both`) | `official-api`, `browser` |
| `HUMAN_ONLY` | preuve `human` : seule l'intervention humaine est possible | aucun (rappels, achat manuel) |
| `EXPIRED` | la preuve d'autorisation a plus de 180 jours | aucun |
| `NOT_ALLOWED` | preuve `prohibited` : la source interdit l'automatisation | aucun |

## Format d'une preuve

```json
{
  "platform": "eventim",
  "checkedAt": "2026-09-29",
  "topic": "automation",
  "source": { "url": "https://www.eventim.fr/...", "title": "Titre exact de la page" },
  "channel": "browser",
  "authorization": "Phrase indiquant ce que la source autorise ou interdit",
  "excerpt": "Passage recopié tel quel depuis la page officielle (≥ 30 caractères)",
  "note": "facultatif"
}
```

Sujets (`topic`) : `automation` (bloquant, porte `channel` : `api` · `browser` · `both` · `human` = seule l'intervention humaine · `prohibited` = automatisation interdite), puis `api`, `queue`,
`limits`, `cart` (complémentaires, portent `value`). Un fichier par preuve ; les champs inconnus sont refusés.

**Refus automatique** : URL non HTTPS, avec identifiants, fragment, paramètres de requête (sauf `allowedQueryParams` du catalogue) ou ressemblant à une redirection ; date absente, inexistante, future ou de plus de 180 jours ; extrait absent ou < 30
caractères ; autorisation < 10 caractères ; domaine différent des `officialHosts` de la plateforme (ou sous-domaine
d'un de ceux-ci) ; plateforme inconnue ; sujet/canal/valeur invalide. Un fichier refusé n'autorise rien ; il est
signalé par `platform check`, `platforms` et `doctor`.

## Commandes (aucune ne contacte un site)

| Commande | Rôle |
|----------|------|
| `npm run platforms` | tableau des plateformes et de leur statut (`-- --json` export, `-- --markdown`, `-- --hosts` domaines à autoriser, `-- --check` cohérence adaptateurs ↔ verdicts) |
| `npm run platform verify [plateforme]` | pièces exactes à consigner et informations manquantes (bloquantes ou non) |
| `npm run platform history <plateforme>` | historique : date, URL, source, canal autorisé, date d'expiration, note |
| `npm run platform template <plateforme> [--topic t]` | modèle de preuve (volontairement invalide tant qu'il n'est pas rempli) |
| `npm run platform check` | valide tous les fichiers de `platforms/evidence/` |
| `npm run platform add <fichier>` | valide puis dépose une preuve (refuse les doublons et les preuves trop anciennes) |
| `npm run doctor` | diagnostic local : Node, Chromium, configs, adaptateurs, preuves, expirations, variables d'environnement, permissions, état du catalogue |
| `npm run new-site -- <id> "<Nom>" --platform <p> [--channel api\|browser] [--dry-run]` | génère l'adaptateur (voir ci-dessous) |

### Export `--json` (schemaVersion 2)

`statuses`, `platforms[]` (`id`, `name`, `regions`, `eventTypes`, `officialHosts`, `status`, `allowedChannels`,
`expiresAt`, `expiresInDays`, `facts`, `history`, `missing`, `conflicts`, `adapters`, `unverifiedClues`) et
`rejectedEvidence[]`.

## Choix du canal : API officielle → navigateur → humain

`resolveChannel` (`src/agent/channels.ts`) ne retient un canal que si (1) un adaptateur le déclare, (2) le statut de la
plateforme l'autorise **avec preuve valide**, (3) ses prérequis sont là (variables d'environnement de `meta.requires.env`).
Sinon : canal humain. `channel` dans la config peut **restreindre** (`official-api`, `browser`, `human`) mais jamais
élargir ; forcer un canal indisponible est une erreur explicite, pas un repli silencieux.

Défense en profondeur : `assertAuthorized` est rejoué dans `run` (avant d'ouvrir un navigateur) et dans `Agent.run`.
Les tests (`tests/runSafety.test.ts`) vérifient qu'une plateforme `NOT_VERIFIED`, `EXPIRED` ou `NOT_ALLOWED` ne peut pas
être lancée par `run`, ni par un canal forcé.

## Créer un adaptateur (`new-site`)

- Plateforme **dont le statut inclut le canal demandé** (`API_ONLY`, `BROWSER_ONLY`, `API_AND_BROWSER`) → adaptateur utilisable.
- Plateforme `NOT_VERIFIED` / `EXPIRED` → **squelette explicitement marqué `@skeleton-status NOT_VERIFIED`** : il échoue au
  contrat et n'est jamais lancé.
- Plateforme `NOT_ALLOWED` ou `HUMAN_ONLY`, ou canal non autorisé → **refus, aucun fichier** (choix délibéré : pas de code pour ce qui n'est pas autorisé).

## Interface pour les futurs adaptateurs API (aucune API réelle implémentée)

- `src/api/ApiClient.ts` : HTTPS uniquement, hôte et préfixe de chemin verrouillés, secret lu dans une variable
  d'environnement (jamais dans le code), cadence ≥ 200 ms sérialisée, redirections refusées, `Retry-After` respecté,
  erreurs mappées vers `BlockerError` / `RateLimitedError`.
- `src/api/BaseApiAdapter.ts` : aucune opération de paiement ; `pollState` lit la file avant l'état de vente et renvoie le
  blocage s'il y en a un.
- `createApiContext` : un contexte qui refuse tout accès navigateur.
- Contrat (`src/sites/contract.ts`) : un adaptateur `official-api` doit avoir `policy: "official-api"`, déclarer
  `requires.env`, et ne contenir aucune méthode de paiement.

## Fournir des preuves

1. Autorisez les domaines listés par `npm run platforms -- --hosts` dans la politique réseau, **ou** collez vous-même les passages.
2. `npm run platform template <plateforme>` → remplir : URL officielle, date de lecture, extrait recopié, canal.
3. `npm run platform add <fichier>` → `npm run platform verify <plateforme>` → `npm run doctor`.
4. Relire avant les 180 jours (`doctor` avertit à 30 jours).

Le tableau de toutes les plateformes se régénère avec `npm run platforms -- --markdown`. Ordre alphabétique, aucun classement.

## Security model / Trust boundaries

Voir [SECURITY.md](SECURITY.md). En bref : catalogue = métadonnées · preuves = seule source d'autorisation · garde du cœur =
application (avant tout réseau, à chaque reprise, périodiquement) · adaptateur = implémentation technique · configuration =
restriction uniquement · Claude = interprétation optionnelle · paiement = toujours manuel.

## État de la recherche de sources officielles (2026-09-30)

Aucune preuve n'a pu être consignée : l'environnement de développement bloque les domaines officiels (proxy de sortie). Essais :
`curl` sur `dev.helloasso.com`, `developer.ticketmaster.com`, `www.eventim.fr`, `www.helloasso.com`, `www.weezevent.com`,
`www.eventbrite.com`, `www.ticketswap.com` → « CONNECT tunnel failed, response 403 » ; l'outil de lecture web → `EGRESS_BLOCKED`
pour `dev.helloasso.com`, `developer.ticketmaster.com`, `www.eventbrite.com`, `www.weezevent.com`. Ni contournement, ni résumé de
moteur de recherche, ni déduction : les 24 plateformes restent `NOT_VERIFIED` et **aucun adaptateur réel n'existe**.

## Faits événementiels fournis par l'utilisateur (NON une preuve d'autorisation)

Le schéma de preuves (`platforms/evidence/`) ne prévoit aucun sujet pour des **faits événementiels** (il ne couvre que l'automatisation
et les sujets `api`, `queue`, `limits`, `cart`) : ils ne sont donc **pas** consignés comme preuve. Ils sont documentés ici, à titre
d'information pour renseigner `config/sale.yaml`. **Aucune autorisation d'automatisation n'en découle** ; le statut des plateformes,
le catalogue et les adaptateurs sont inchangés (toutes `NOT_VERIFIED`, aucun adaptateur réel).

### SDM — Stade de France (contenu de la page fourni par l'utilisateur, non relu par le projet)

| Information | Valeur fournie | Source |
|---|---|---|
| Événement | SDM | `https://www.stadefrance.com/fr/billetterie/sdm` (page consultée par l'utilisateur ; contenu recopié par lui) |
| Date de l'événement | samedi 29 mai 2027 | idem |
| Mise en vente générale | jeudi 1er octobre, 12h00 | idem |
| Mention de la page | « BILLETTERIE OFFICIELLE » ; la billetterie du Stade de France est indiquée comme officielle et garantie | idem |
| Automatisation (bots, API, Playwright…) | **Aucune phrase l'autorisant dans le contenu fourni** → aucune preuve d'automatisation, statut inchangé | idem |

Non présents dans le contenu fourni, donc **inconnus** (rien n'est déduit) : année et fuseau horaire de la mise en vente, limite de billets
par commande, conditions d'achat, identifiant de l'événement, plateforme technique de vente (le Stade de France n'est pas dans
`platforms/catalog.json`). Une mise en vente « vendue sur une plateforme » n'est pas une autorisation d'automatiser.

## pretix (instance contrôlée)

Banc de test API-first : voir [PRETIX.md](PRETIX.md). **Inactif** dans le produit réel tant que les preuves et l'entrée de catalogue ne sont pas enregistrées (statut réel : NOT_VERIFIED). Ne constitue pas une autorisation d'automatiser l'achat sur les événements de tiers.
