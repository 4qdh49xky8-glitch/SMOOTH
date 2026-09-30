# Sécurité, autorisation et modèle de confiance

Ce document décrit ce que le code **garantit**, comment, et où s'arrêtent ces garanties. Chaque règle ci-dessous est verrouillée
par des tests (`tests/authMatrix`, `trustBoundaries`, `networkPaths`, `auditEvidence`, `auditApiClient`, `lockAndResume`,
`auditSecrets`, `browserRules`, `auditNetwork`).

## 1. Modèle d'autorisation (par canal, explicite)

L'autorisation d'automatiser une plateforme vient **uniquement** de preuves officielles datées (`platforms/evidence/*.json`).
Le statut est **calculé**, jamais saisi. **L'absence de preuve pour un canal signifie « non autorisé ».**

| Statut | Cause | API officielle | Navigateur | Humain (rappels) |
|--------|-------|:-:|:-:|:-:|
| `NOT_VERIFIED` | aucune preuve | non | non | oui |
| `API_ONLY` | preuve `api` | **oui** | non | oui |
| `BROWSER_ONLY` | preuve `browser` | non | **oui** | oui |
| `API_AND_BROWSER` | preuves `api` + `browser` (ou `both`) | **oui** | **oui** | oui |
| `HUMAN_ONLY` | preuve `human` : seule l'intervention humaine est possible | non | non | oui |
| `NOT_ALLOWED` | preuve `prohibited` : la source interdit l'automatisation | non | non | oui |
| `EXPIRED` | preuves de plus de 180 jours | non | non | oui |

« Humain » = rappels et préparation : aucun navigateur piloté, aucune requête vers la plateforme.

**Combinaison de plusieurs preuves** : `prohibited` et `human` sont des *vetos* (aucune autre preuve ne les lève, seule
l'expiration) ; deux preuves de la *même page* qui se contredisent → le plus restrictif ; des preuves de *pages différentes*
s'additionnent canal par canal (conditions de l'API → `api`, CGU du site → `browser`).

**Une configuration ne peut que restreindre.** `channel` (auto / official-api / browser / human) choisit *parmi* les canaux
autorisés ; forcer un canal non autorisé est une **erreur explicite**, jamais un repli silencieux. Aucun drapeau CLI, variable
d'environnement, `siteOptions`, clé de configuration, `--force` ou déclaration d'adaptateur (`meta.compliance`) n'augmente les
permissions (vérifié pour chaque statut × canal × commande).

## 2. Preuves

Refusées (le fichier n'autorise alors rien et est signalé) : URL non HTTPS ; identifiants dans l'URL ; fragment (`#…`) ;
paramètres de requête (sauf `allowedQueryParams` déclarés dans le catalogue) ; lien de redirection/suivi (`/redirect`, `/out`,
`/go`, `/r`, `/l`, `/click`…) ; hôte qui n'est pas exactement un domaine officiel de la plateforme ou un de ses sous-domaines
(sosies, sous-domaines d'un tiers, `@`, `\`, point final, encodage, punycode) ; date absente, inexistante (30 février), future ;
plus de 180 jours à l'ajout ; plateforme, sujet, canal ou valeur inconnus ; champ inconnu ; extrait < 30 caractères.
Jour 180 valide, jour 181 expiré (jours calendaires UTC). L'historique est conservé (aucune suppression).

**Rien n'est téléchargé ni fabriqué** : aucun code ne récupère une page pour en faire une preuve ; `platform template` produit un
modèle volontairement invalide ; `platform add` copie un fichier fourni après validation. Une preuve doit correspondre à une
source officielle réellement consultée *par vous* : le code ne peut contrôler que l'hôte de l'URL, pas son contenu.

## 3. Chaîne de garde avant tout réseau

```
preuves valides et non expirées  →  canal autorisé  →  URL de l'événement + hôtes de l'adaptateur ∈ domaines officiels  →  verrous  →  adaptateur  →  réseau
```

- `resolveChannel` : choisit API → navigateur → humain selon les preuves et les adaptateurs installés.
- `assertAuthorized` + `assertNetworkAllowed` (`src/platforms/authorize.ts`) : rejoués par `run/login/check` (`live.ts`) **et** par
  `Agent.run` ; l'URL de l'événement (https obligatoire hors démo) et chaque hôte déclaré par l'adaptateur (`networkHosts()`) doivent
  appartenir aux domaines officiels du catalogue. Une URL de configuration vers un autre domaine est refusée avant la moindre requête.
- `ApiClient` : `allowedHosts` obligatoire, hôte et préfixe de `baseUrl` verrouillés, https, aucune redirection suivie, secret lu
  dans une variable d'environnement nommée, cadence ≥ 200 ms sérialisée, `Retry-After` respecté, timeout, `AbortSignal`, erreurs
  nettoyées (ni URL complète, ni secret, ni `cause`), chemins de paiement et corps bancaires refusés.
- Navigateur : un seul garde (`installNetworkGuards`) installé **avant toute navigation** : annule les URL de paiement et toute
  *navigation de page* (même par redirection) vers un hôte hors domaines autorisés. Les sous-ressources suivent le fonctionnement
  normal du site. Rien n'est réécrit.
- Inventaire (`tests/networkPaths`) : seuls `ApiClient`, `launch.ts` (CDP, boucle locale), `notify.ts` (webhook **choisi par
  l'utilisateur**, texte assaini), `clock.ts` (en-tête `Date` de l'URL déjà validée) et les adaptateurs (`goto`) touchent le
  réseau ; toute nouvelle entrée casse le test.

## 4. Verrous et reprise

- Un seul bot par **événement** et par **profil de navigateur**, pour `run`, `login` et `check`. Aucune option ne l'autorise.
  Deux événements différents, ou deux profils sur deux événements, fonctionnent indépendamment. Le verrou ne crée aucune concurrence.
- Verrou orphelin (processus mort) récupéré ; PID réutilisé (heure de démarrage du processus différente, Linux) récupéré ;
  verrou de plus de 24 h périmé ; `verify()` détecte un verrou supprimé ou repris.
- **Après toute intervention humaine** (connexion, file, CAPTCHA, plan de salle) : 1) autorisation relue localement, 2) canal et
  hôtes toujours autorisés, 3) verrou toujours détenu, 4) état cohérent — puis reprise. Autorisation perdue → état
  `AUTHORIZATION_EXPIRED`, **aucune requête de plus**. Verrou perdu → arrêt (`LOCK_LOST`).
- **Pendant une longue surveillance** : évaluation locale à chaque lecture + relecture des fichiers de preuve toutes les 30 s
  (`authCheckIntervalMs`), sans contacter la plateforme ; et juste avant toute tentative d'achat.

États : `AVAILABLE`, `SOLD_OUT`, `QUEUE`, `CAPTCHA`, `LOGIN_REQUIRED`, `MANUAL_SELECTION`, `MANUAL_INTERVENTION`, `PURCHASE_LIMIT`,
`BLOCKED`, `AUTHORIZATION_EXPIRED`, `CART_SUCCESS`, `ERROR`.

## 5. Ce que le bot ne fait jamais

CAPTCHA (résolution), anti-bot (contournement), file d'attente virtuelle (contournement), limite de débit (le `Retry-After`/429
est respecté), limite d'achat (arrêt définitif, `maxTicketsPerOrder` vérifié avant tout appel), authentification (connexion
manuelle ou secret officiel en variable d'environnement), création de comptes, multiplication de sessions (verrous), modification
de cookies/session/en-têtes, usurpation d'empreinte ou d'agent utilisateur, proxys, scripts injectés, réécriture de réponses,
blocage de scripts d'analyse ou de protection (seuls images/polices/vidéos sont évitées pendant la course), émulation de
focus/appareil. **Paiement : jamais automatisé** — les URL de paiement sont bloquées pendant le run, `ApiClient` refuse chemins et
corps de paiement, aucun champ bancaire n'est lu, rempli ni mémorisé ; le run s'arrête au panier (`CART_SUCCESS`).
Face à CAPTCHA, file, blocage ou connexion : notification « Action requise », le bot cesse d'agir, l'humain traite.

## 6. Secrets et journaux

Secrets uniquement par **noms** de variables d'environnement (`meta.requires.env`, `auth.envVar`). `redact()` (journaux,
notifications, télémétrie, prompts Claude) masque : valeurs exactes des variables secrètes, jetons, `Authorization`/`Cookie`
(toutes les paires), URL à identifiants ou paramètres, e-mails, IBAN, cartes, CVV. La télémétrie est locale (`runs/`).

## 7. Claude

Hors du chemin nominal (`détection → décision → sélection → panier` est déterministe). Appelé seulement pour réparer un sélecteur
ou établir un diagnostic. Il reçoit un résumé assaini (sans valeurs de champs, cookies, jetons, bancaire, variables
d'environnement) ; sa réponse est un index d'élément validé par le code (jamais un élément de paiement, ni sans attribut stable,
quota d'appels) ; le module n'importe ni l'autorisation, ni le catalogue, ni les garde-fous ; point d'accès **fixe**
(`api.anthropic.com`, `ANTHROPIC_BASE_URL` ignoré).

## 8. Limites connues

- Le contenu d'une preuve n'est pas vérifiable par le code (seul l'hôte l'est) ; une URL de redirection ouverte sur le domaine
  officiel qui n'est pas reconnue comme telle passerait ; l'exactitude des extraits relève de la personne qui consulte la source.
- Les adaptateurs sont du code de confiance du dépôt : le contrat balaie leur source (heuristique non exhaustive) et le garde
  réseau limite leurs navigations, pas leurs sous-ressources.
- Le garde de navigation compare des noms d'hôte, pas des IP ; une plateforme qui utilise un domaine d'authentification tiers
  (SSO) exige d'ajouter ce domaine à `officialHosts` *après* l'avoir vérifié dans une source officielle.
- Le webhook `NOTIFY_WEBHOOK_URL` est choisi par l'utilisateur : il reçoit des textes assainis, pas de secrets connus, mais reste
  un envoi sortant hors plateforme.
- Reprise : l'« état » vérifié après une main humaine est l'état interne ; le blocage résiduel éventuel est relu à la lecture suivante.
- Détection de PID réutilisé : Linux (`/proc`) ; ailleurs, seule la péremption à 24 h s'applique.
- Les durées de la télémétrie en mode `simulation` mesurent un faux site : jamais une vitesse d'achat réelle.
