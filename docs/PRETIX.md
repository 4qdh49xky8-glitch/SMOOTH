# pretix — banc de test API-first sur une instance CONTRÔLÉE

> **AUTHORIZED_SCOPE = CONTROLLED_PRETIX_INSTANCE_ONLY**
>
> Cette intégration est autorisée uniquement pour les événements/organisateurs pretix que l'utilisateur est autorisé à administrer ou pour lesquels il dispose explicitement des credentials et permissions nécessaires. Elle ne constitue pas une autorisation d'automatiser l'achat sur les événements de tiers.

## État d'activation (à lire d'abord)

| Élément | État |
|---|---|
| Adaptateur `src/sites/pretix/PretixAdapter.ts` | écrit et testé sur fixtures locales ; **volontairement hors de la découverte automatique** (`src/sites/pretix/` n'est pas `src/sites/*.ts`) |
| Fichiers de preuve `platforms/evidence/pretix-*.json` | **NON enregistrés** (voir ci-dessous) |
| Entrée `pretix` dans `platforms/catalog.json` | **NON ajoutée** |
| Statut réel de la plateforme `pretix` | **NOT_VERIFIED** (absente du catalogue) → `sale:instant` refuse, aucune requête |
| Tests | catalogue **de test** (plateforme `pretix`, hôte `pretix.eu`, preuve FICTIVE de test) : aucune preuve réelle n'est simulée dans le dépôt |

L'enregistrement des preuves et de l'entrée de catalogue est une décision de sécurité qui attend la confirmation explicite de l'utilisateur ; tant qu'elle n'a pas eu lieu, l'adaptateur reste inactif dans le produit réel. Pour l'activer : enregistrer les preuves (`npm run platform template pretix` → `npm run platform add <fichier>`, avec les extraits que l'utilisateur a lus lui-même sur `docs.pretix.eu`), ajouter l'entrée `pretix` (`officialHosts: ["pretix.eu"]`), puis déplacer/ré-exporter l'adaptateur dans `src/sites/Pretix.ts`.

## Documentation officielle utilisée (fournie et vérifiée par l'utilisateur)

| Page | Titre | Ce qui en est retenu |
|---|---|---|
| `https://docs.pretix.eu/dev/api/index.html` | REST API | l'API REST peut être utilisée « by third-party programs » |
| `https://docs.pretix.eu/dev/api/fundamentals.html` | Basic concepts | authentification obligatoire ; jetons recommandés côté serveur ; permissions par équipe (« Can view orders », « Can change orders ») |
| `https://docs.pretix.eu/dev/api/resources/orders.html` | Orders | états `n` pending, `p` paid, `e` expired, `c` canceled ; `"simulate": true` = essai à blanc sans création |
| `https://docs.pretix.eu/dev/api/ratelimit.html` | Rate limiting | **aucun extrait fourni → NOT_ESTABLISHED** : seul le comportement générique du cœur (`429` + `Retry-After` respecté) est appliqué |

## Ce que fait l'adaptateur

- **Hôte fixe** `pretix.eu` (aucun hôte configurable, aucun joker). Organisateur et événement viennent de `event.url` = `https://pretix.eu/<organisateur>/<événement>/`.
- **Authentification** : variable d'environnement `PRETIX_API_TOKEN` (clé d'API d'une équipe), jamais ailleurs ; envoyée en `Authorization: Token …` (forme de l'en-tête : NOT_ESTABLISHED par les extraits fournis, à valider).
- **Lecture** : événement, items, catégories, quotas, disponibilité d'un quota. Prix convertis en centimes entiers ; `max_per_order` de pretix appliqué tel quel (jamais de commandes multiples) ; `min_per_order` en veto.
- **Sélection** : moteur du cœur inchangé (budget, catégories, quantité, stratégie). `seatsTogether` n'est pas supporté (toujours « unknown »).
- **Mode `simulate` (défaut)** : la sélection envoie `"simulate": true` ; résultat interne `PRETIX_SIMULATION_SUCCESS`, **jamais** un `CART_SUCCESS` ; le run s'arrête explicitement (aucune commande créée, aucun e-mail).
- **Mode `create`** (opt-in : `siteOptions.pretix.orderMode: "create"` dans `advanced`) : une commande **en attente** (`n`) est créée, avec une clé d'idempotence, puis relue et vérifiée (code, positions, quantité, prix en centimes, total, statut `n`, expiration). Seulement alors : `CART_SUCCESS / PAYMENT_REQUIRED / PAYMENT_MANUAL`. `PRETIX_ORDER_EMAIL` (adresse de contact de la commande) est requise.
- **Jamais de seconde commande** : un échec au résultat incertain (coupure) arrête le run ; il n'y a aucun nouvel envoi. Un `429` sur une écriture : attente du `Retry-After`, **un** nouvel essai (même clé), puis arrêt.
- **Paiement** : aucun chemin ni champ de paiement, aucune marque « payé », aucune transition de commande (`mark_*`, `payments`, `confirm`…) ; refusé avant l'envoi. Le paiement reste 100 % manuel.

## Limites connues et points NOT_ESTABLISHED

- **`payment_provider`** : la création d'une commande pretix peut exiger ce champ. Le client HTTP du cœur (gelé) refuse tout champ dont le nom contient « payment » ; l'adaptateur **n'envoie donc pas** ce champ. Si une instance le réclame, la création échouera (400 → « commande refusée ») : c'est à décider avec l'utilisateur (modification du cœur gelé, hors périmètre). **Non vérifié.**
- **Forme exacte** des réponses (items, quotas, disponibilité, commande) et **en-tête d'idempotence** (`X-Idempotency-Key`) : reproduits à partir de la connaissance du projet, non des extraits fournis → à valider sur une instance de test réelle avant tout usage.
- Fixtures : en mémoire (faux `fetch`), donc aucune requête réseau ; les durées mesurées sont celles de la fixture, pas celles de pretix.

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `PRETIX_API_TOKEN` | clé d'API de l'équipe (secret, jamais versionné) |
| `PRETIX_ORDER_EMAIL` | adresse de contact de la commande (mode `create`) |

## Lancer les tests (aucune requête réelle)

```bash
node --import tsx --import ./tests/setup/noNetwork.ts --test tests/pretix.test.ts
npm test
```
