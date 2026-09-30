# Contrat d'adaptateur

Un adaptateur est l'**implémentation technique** d'un canal (navigateur ou API officielle) pour UNE plateforme. Il ne décide ni de
l'autorisation, ni de son canal, ni du paiement. Ce document est la référence du contrat ; le code est dans
`src/sites/SiteAdapter.ts`, `BaseSiteAdapter.ts`, `src/api/ApiClient.ts`, `BaseApiAdapter.ts`, et il est vérifié par
`checkAdapterContract` (`npm run sites`, `npm run test:adapters`) et par les suites de fixtures (`docs/FIXTURES.md`).

> **Fixture ≠ plateforme.** `ExampleSite` est `TEST_ONLY · NOT_A_REAL_PLATFORM` : un outil de développement (policy `demo`, limité à
> localhost, hors catalogue). Il n'est ni une preuve d'architecture réelle, ni une autorisation. Aucun adaptateur réel n'existe
> tant qu'une preuve officielle valide n'existe pas (`docs/PLATFORMS.md`).

## Déclarations explicites (lecture seule)

| Membre | Rôle |
|--------|------|
| `authorization` | `{ platform, channel, policy, evidenceRequired, requiresStatus }` : ce que l'adaptateur **exige**. `requiresStatus` se déduit du modèle figé (navigateur → `BROWSER_ONLY`, `API_AND_BROWSER` ; API → `API_ONLY`, `API_AND_BROWSER`). Seule une preuve peut le satisfaire. |
| `channel` | `"official-api"` ou `"browser"`. |
| `capabilities` | Ce que la plateforme expose : `officialApi`, `preciseServerTime`, `lightweightAvailability`, `reportsSeatAdjacency`, `seatSelection`, `maxTicketsPerOrder?`. |
| `allowedHosts(config)` | Hôtes que l'adaptateur contactera. **Tous** doivent appartenir aux domaines officiels du catalogue (le cœur et le contrat le vérifient). Navigateur : l'hôte de la page d'événement par défaut. API : les hôtes du `ApiClient` (`client`). |
| `meta.testOnly` | Réservé aux fixtures (`policy: "demo"`), hôtes locaux uniquement. |

Ces membres dérivent de `meta` (`authorizationOf(meta)`) : les déclarer autrement est une erreur de contrat
(`AUTHORIZATION_DECL`, `CHANNEL_DECL`, `CAPABILITIES_DECL`, `ALLOWED_HOSTS`).

## Les sept capacités

| Capacité | Contrat |
|----------|---------|
| `getEvent(ctx)` | L'événement visé : `{ url, name? }`. Local par défaut. |
| `getAvailability(ctx)` | `{ open, soldOut }`. Lecture **légère** ; peut lever `RateLimitedError` (jamais contournée). |
| `getOffers(ctx)` | Offres normalisées : `id`, `category`, `pricePerTicket`, `currency`, `available`, `seatsTogether` (`true` / `false` / `"unknown"` — jamais inventé), `section?`, `row?`, `seats?`, `url?`. |
| `matchOffer(offer, criteria)` | **Veto seulement** : exclure une offre que la plateforme sait inachetable. Le budget, la quantité, les catégories et la stratégie restent décidés par le cœur ; un « oui » n'ajoute jamais une offre écartée. |
| `selectOffer(ctx, offer, qty)` | Ouvre l'offre, règle la quantité. `OfferUnavailableError` si vendue ; `BlockerError` si blocage. |
| `addToCart(ctx)` | Ajoute au panier (**jamais un paiement**). `OfferUnavailableError` si vendu entre-temps ; `BlockerError(PURCHASE_LIMIT)` si limite d'achat. |
| `getCartState(ctx)` | Panier relu **fidèlement** depuis la plateforme (le cœur vérifie quantité et budget). Le bot s'arrête là. |

Implémentation : soit `fetchSale()` (lecture unique disponibilité + offres), soit `getAvailability()` + `getOffers()` ; soit
`getCartState()`, soit `readCart()`. `BaseSiteAdapter` dérive l'une de l'autre ; n'en implémenter aucune lève une erreur explicite et
le contrat la signale (`CAPABILITY_UNIMPLEMENTED`). `BaseApiAdapter` : `authenticate`, `listOffers`, `holdOffer`, `reserve`,
`readReservation` (+ `queueStatus?`), les sept capacités en sont dérivées.

## États

Les **10 états du contrat** : `AVAILABLE`, `SOLD_OUT`, `QUEUE`, `CAPTCHA`, `LOGIN_REQUIRED`, `MANUAL_SELECTION`, `PURCHASE_LIMIT`,
`BLOCKED`, `CART_SUCCESS`, `ERROR` (`ADAPTER_STATES`). Deux états sont produits **par le cœur seul** : `MANUAL_INTERVENTION`,
`AUTHORIZATION_EXPIRED`.

Un adaptateur ne remonte que des états **bloquants** (`detectBlocker` ou `BlockerError`) ; le cœur en déduit `AVAILABLE`,
`SOLD_OUT`, `CART_SUCCESS`, `ERROR`. Face à `QUEUE`, `CAPTCHA`, `BLOCKED`, `LOGIN_REQUIRED`, `MANUAL_SELECTION` : cession de la main à
l'humain. `PURCHASE_LIMIT` : arrêt définitif. **Jamais de contournement.**

## `ApiClient` (canal API)

`new ApiClient({ allowedHosts, baseUrl, auth: { envVar }, … })` — `allowedHosts` obligatoire (l'hôte de `baseUrl` doit y figurer) ; https ;
préfixe de chemin verrouillé ; aucune redirection suivie ; secret lu dans la variable d'environnement **nommée** (jamais une valeur) ;
cadence ≥ 200 ms sérialisée ; `Retry-After` respecté (429 → `RateLimitedError`, jamais réessayé par le client) ; timeout ; `AbortSignal` ;
erreurs nettoyées ; chemins de paiement et corps bancaires refusés. L'adaptateur expose son client (`client`) pour que ses hôtes soient
vérifiés contre le catalogue.

## Interdits (vérifiés par le contrat et des tests)

CAPTCHA (résolution), anti-bot, file d'attente, limite de débit, limite d'achat, authentification (contournement) ; création de comptes,
multiplication de sessions ; cookies/session/en-têtes modifiés, usurpation d'empreinte, proxys, scripts injectés ; méthodes de paiement
(`pay*`, `checkout*`, `purchase*`, …) ; données bancaires ; requête hors de `allowedHosts()`.

## Responsabilités

| Qui | Fait | Ne fait pas |
|-----|------|-------------|
| Preuves + catalogue | autorisent (ou non) un canal | — |
| Cœur | choisit le canal, vérifie autorisation/hôtes/verrous, décide (filtre + stratégie), s'arrête au panier | contacter une plateforme non autorisée |
| Adaptateur | parle à la plateforme via le canal autorisé, détecte les blocages | s'autoriser, choisir son canal, payer, contourner |
| Configuration d'événement | paramètres (quantité, budget, catégories) ; restreint le canal | accorder une permission |
