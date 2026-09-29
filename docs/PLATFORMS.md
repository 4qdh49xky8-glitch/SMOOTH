# Plateformes de billetterie : étude, catalogue et choix du canal

> **Statut de l'étude (2026-09-29) : NON TERMINÉE — aucune plateforme n'est vérifiée.**
> L'environnement où le travail a été fait bloque par sa politique réseau **tous** les domaines officiels
> nécessaires (plateformes, portails développeur, textes de loi). Aucune page officielle n'a donc pu être lue.
> Plutôt que de remplir un tableau avec ce que je crois savoir, **chaque plateforme est marquée « NON VÉRIFIÉ »**
> et le système la traite comme non autorisée (canal humain seulement). Voir « Pour terminer l'étude ».

## Principe : UN cœur, UN adaptateur par plateforme (et par canal), UNE configuration par événement

```
configuration d'événement (site = plateforme)
        │
        ▼
  Core Agent ── ne connaît aucun site : lit seulement meta (canal, prérequis) + catalogue
        │
        ▼   résolution du canal (src/agent/channels.ts)
  API officielle ─▶ Navigateur (Playwright) ─▶ Intervention humaine
   (adaptateur          (adaptateur                (rappels seulement :
   `canal: official-api`) `canal: browser`)         aucun contact avec le site)
```

Un adaptateur n'est **retenu** que si toutes ces conditions sont vraies :

1. sa plateforme figure dans `platforms/catalog.json` et son **verdict**, déduit des seules **preuves officielles**
   consignées, autorise son canal ;
2. ses prérequis sont présents (`meta.requires.env` : clés d'API ; jamais de valeur dans le code) ;
3. il passe le contrat (`npm run test:adapters`) et le contrôle de conformité (CGU relues < 180 jours).

Sinon le cœur passe au canal suivant ; s'il n'y en a aucun, il bascule sur l'**intervention humaine**. Un canal forcé
(`"channel": "browser"`) ne peut jamais être plus permissif que ce qui est autorisé : s'il n'est pas disponible, c'est une erreur.
La décision est toujours explicable (`Canal retenu` / `Canal écarté` dans les logs, `npm run validate`).

| Verdict (déduit des preuves) | Signification | Canal(aux) automatisé(s) |
|---|---|---|
| `NON VÉRIFIÉ` | rien de fiable (aucune preuve, ou preuve de plus de 180 jours) | aucun → humain |
| `NON AUTORISÉ` | les conditions interdisent l'automatisation | aucun → humain |
| `manuel seulement` | conditions silencieuses (silence = non autorisé) ou API non ouverte à un utilisateur ordinaire | aucun → humain |
| `API-first` | API officielle transactionnelle ouverte **et** automatisation permise par API | API, puis navigateur si aussi permis |
| `adaptateur navigateur` | les conditions autorisent **explicitement** l'automatisation de l'interface | navigateur |

Le canal humain n'est pas de l'automatisation : rappels à T−10 min, T−2 min, T−30 s et à l'ouverture, avec le nom de
l'événement, votre quantité et votre budget. Il n'ouvre pas de navigateur et ne fait aucune requête vers le site.
Il est donc utilisable pour n'importe quelle plateforme, y compris celles qui interdisent l'automatisation.

## Ce qui a été fait, et ce qui ne l'a pas été

Fait (hors ligne, testé) : catalogue de 24 plateformes candidates (ordre alphabétique, **aucun classement**), schéma qui
**exige une preuve officielle datée** pour toute valeur autre que « inconnu » (URL https sur un domaine officiel,
date, passage cité), calcul du verdict, choix automatique du canal, canal humain, garde-fou du cœur, contrat.

Pas fait : la lecture des conditions d'utilisation, des documentations développeur, des règles sur les robots, des files
d'attente, des limites d'achat et des mécanismes de panier. **Aucun adaptateur réel n'est créé** ; il n'y en a qu'un
(démo locale).

## Tableau interne (généré par `npm run platforms -- --markdown`)

| Plateforme | Types d'événements | API officielle | Automatisation autorisée/documentée | File d'attente | Limites d'achat | Adaptateur techniquement envisageable | Source officielle | Date de vérification |
|---|---|---|---|---|---|---|---|---|
| AXS | concert, sport, spectacle | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | — | — |
| BilletReduc | spectacle, theatre | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | — | — |
| Billetweb | associatif, festival, spectacle, concert | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | — | — |
| Comédie-Française (billetterie propre) | theatre, spectacle | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | — | — |
| DICE | concert, festival | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | — | — |
| Digitick (See Tickets France) | concert, festival, spectacle, sport | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | — | — |
| Eventbrite | concert, festival, spectacle, associatif | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | — | — |
| Eventim | concert, sport, spectacle, theatre | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | — | — |
| FIFA (billetterie officielle) | grand-evenement, sport | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | — | — |
| Fnac Spectacles (France Billet) | concert, spectacle, theatre, sport, festival | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | — | — |
| HelloAsso | associatif, festival, spectacle | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | — | — |
| LA28 (billetterie officielle) | grand-evenement, sport | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | — | — |
| Opéra national de Paris (billetterie propre) | spectacle, theatre | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | — | — |
| Roland-Garros / FFT (billetterie officielle) | sport, grand-evenement | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | — | — |
| SeatGeek | sport, concert, spectacle | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | — | — |
| See Tickets (Eventim group) | concert, festival | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | — | — |
| Shotgun | concert, festival | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | — | — |
| StubHub (revente) | revente, concert, sport | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | — | — |
| Ticketmaster | concert, sport, spectacle, theatre, festival | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | — | — |
| TicketSwap (revente) | revente, concert, festival | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | — | — |
| UEFA (billetterie officielle) | sport, grand-evenement | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | — | — |
| Viagogo (revente) | revente, concert, sport | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | — | — |
| Weezevent | festival, associatif, concert, spectacle | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | — | — |
| Yurplan | festival, associatif, concert | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | NON VÉRIFIÉ | — | — |

Toutes les cases sont « NON VÉRIFIÉ » : c'est l'état réel. Le tableau ne peut contenir autre chose que des valeurs
adossées à une preuve (le schéma le refuse). Aucune plateforme n'est classée « meilleure » ou « pire ».

## Pistes NON vérifiées (résumés de recherche web, pages officielles non lues)

Ces éléments servent uniquement à savoir **quoi vérifier en premier** ; ils ne comptent pour aucune décision
(`clues` n'est jamais lu par le calcul du verdict). Ils viennent de résumés d'un moteur de recherche, pas des pages.

**AXS**
- <https://www.axs.com/about-terms-of-use_US_v1.html> — Le résumé indique une interdiction de moyens automatiques (robots, actualisations répétitives des pages de billetterie).
- <https://support.axs.com/hc/en-us/articles/200745935-What-s-a-Waiting-Room> — Le résumé indique une salle d'attente virtuelle sur les événements très demandés.

**Billetweb**
- <https://www.billetweb.fr/bo/api.php> — API documentée (spécification OpenAPI) ; le résumé évoque l'extraction de données de réservation, donc probablement côté organisateur.
- <https://www.billetweb.fr/fr-fr/conditions-generales-de-vente> — Conditions générales de vente.

**DICE**
- <https://support.dice.fm/article/255-united-kingdom-terms-of-use> — Le résumé indique une interdiction des logiciels/processus automatisés et scripts pour accéder aux services.
- <https://support.dice.fm/article/267-united-states-terms-of-use> — Idem (conditions États-Unis).

**Digitick (See Tickets France)**
- <https://www.digitick.com/content/terms-and-conditions> — Conditions générales de vente ; le résumé ne mentionne ni robots ni limites d'achat (peuvent être fixées par l'organisateur).

**Eventbrite**
- <https://www.eventbrite.com/platform/docs/orders> — Documentation officielle de l'API (commandes, participants, checkout intégrable) ; à établir : périmètre côté organisateur ou acheteur.
- <https://www.eventbrite.com/platform/docs/introduction> — Introduction à l'API.

**Eventim**
- <https://www.eventim.fr/help/terms/> — Le résumé indique que l'usage non autorisé de robots/automates peut faire l'objet de poursuites, et que le vendeur peut refuser une commande en cas de demande anormale.
- <https://www.eventim.fr/campaign/foire-aux-questions> — FAQ ; le résumé évoque des limites par commande fixées par événement (ex. 6 ou 8).

**Fnac Spectacles (France Billet)**
- <https://www.fnacspectacles.com/help/terms/> — Conditions générales de vente ; le résumé ne mentionne ni robots, ni file d'attente, ni limites d'achat.

**HelloAsso**
- <https://dev.helloasso.com/docs/introduction-%C3%A0-lapi-de-helloasso> — API officielle (OAuth2) ; le résumé indique un usage côté organisation (données de billetterie, checkout) — à établir.
- <https://dev.helloasso.com/reference/plus-billetterie-api> — API « Plus Billetterie ».

**Roland-Garros / FFT (billetterie officielle)**
- <https://tickets.rolandgarros.com/fr/tout-savoir-tirage-au-sort> — Le résumé indique une vente par tirage au sort (pas de file d'attente classique) et des limites de billets par catégorie de sessions.
- <https://tickets.rolandgarros.com/fr/informations/general> — Informations billetterie.

**See Tickets (Eventim group)**
- <https://www.seetickets.com/Content/Terms-and-Conditions> — Conditions générales ; le résumé ne mentionne ni robots ni limites d'achat.

**Shotgun**
- <https://support.shotgun.live/hc/en-us/articles/14330476029330--General-Terms-and-Conditions> — Conditions générales d'utilisation ; le résumé n'en donne pas le contenu sur les robots.

**Ticketmaster**
- <https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/> — Le résumé indique que la Discovery API permet de rechercher événements, artistes et lieux.
- <https://developer.ticketmaster.com/products-and-docs/apis/partner/> — Le résumé indique que la Partner API (réserver/acheter) n'est PAS ouverte : réservée aux entreprises ayant une relation officielle de distribution.
- <https://developer.ticketmaster.com/products-and-docs/apis/getting-started/> — Présentation des API (Discovery, Commerce…) ; périmètre exact d'accès à établir.
- <https://www.ticketmaster.be/help/terms.html?language=fr-be> — Le résumé indique une interdiction des robots/spiders et du contrôle automatique du site (version belge ; la version française est à identifier).

**UEFA (billetterie officielle)**
- <https://www.uefa.com/euro2028/news/02a0-1f55506ebc73-bd595aa88468-1000--uefa-euro-2028-puts-fans-first-with-fair-and-transparent-/> — Le résumé indique un tirage/ballot pour l'EURO 2028 (sans file d'attente) ; candidatures multiples interdites dans les conditions des éditions précédentes.
- <https://www.uefa.com/tickets/> — Portail billetterie UEFA.

**Weezevent**
- <https://api.weezevent.com/> — Le résumé indique une API réservée aux partenaires enregistrés (clé délivrée par Weezevent), côté billetterie organisateur.
- <https://weezevent.com/fr-ca/cgus/> — Conditions générales d'utilisation des services.

Plateformes sans piste (recherche non faite ou sans résultat exploitable) : BilletReduc, Comédie-Française, FIFA, LA28,
Opéra national de Paris, SeatGeek, StubHub, TicketSwap, Viagogo, Yurplan.

## Pour terminer l'étude

**Option A — autoriser les domaines officiels.** Dans les réglages de l'environnement (menu du cloud dans la barre de
titre de la session → Edit → *Network access*), ajoutez les domaines listés par
`npm run platforms -- --hosts` (69 domaines). Je pourrai alors lire les pages officielles et consigner les preuves.

**Option B — me coller les passages.** Collez ici, pour la plateforme de votre choix, les passages exacts des
conditions d'utilisation / de la documentation développeur (avec l'URL et la date de consultation). Je les consigne
comme preuves, sans les interpréter au-delà de ce qu'ils disent.

Dans les deux cas, pour chaque plateforme, les **sept points** à établir, chacun avec son URL officielle, sa date et le
passage cité :

| # | Point | Champ du catalogue |
|---|---|---|
| 1 | Conditions d'utilisation | `sources` / preuves ci-dessous |
| 2 | Documentation développeur / API officielle | `officialApi` (none · read-only · partner-only · open-transactional) |
| 3 | Règles sur robots, scripts, automatisation | `automation` (prohibited · not-addressed · permitted-interface · permitted-api · permitted-both) |
| 4 | File d'attente officielle | `queue` (none · official-queue · lottery) |
| 5 | API officielle permettant la billetterie | `officialApi` |
| 6 | Limites d'achat documentées | `purchaseLimits` (+ `value`) |
| 7 | Mécanisme officiel de réservation/panier | `cart` (none · official-api · web-only) |

Règles de consignation : jamais de valeur sans preuve ; le silence des conditions se note `not-addressed` (donc non
autorisé) ; une preuve de plus de 180 jours redevient « non vérifiée » ; une preuve hors des `officialHosts` de la
plateforme est refusée. Vérification : `npm run platforms -- --check`.

Un texte de loi (par exemple sur les robots d'achat ou la revente de billets) se vérifie sur une source officielle
(Légifrance, EUR-Lex) ; je ne le cite pas de mémoire.

## Comment le premier adaptateur sera choisi

Aucune plateforme n'est choisie tant qu'aucune n'est vérifiée. Une plateforme ne devient candidate que si son verdict
est `API-first` ou `adaptateur navigateur`. Avant d'écrire la moindre ligne, je vous présenterai : la plateforme, les
sources officielles (URL, date, passage), ce que l'adaptateur fera, ce qu'il ne fera pas, son architecture et ses
tests — et j'attendrai votre validation. Le canal humain reste disponible pour toutes les autres.
