# Funnel + prospection (P0/P2)

```
Short ──► vidéo longue / pack gratuit ──► lead (e-mail ou réservation) ──► audit 59 $ ──► pack 290 $
                         ▲
Prospection directe (manuelle, ciblée) ──┘   ← chemin le plus rapide vers 500 $
```

**Réalité chiffrée** : avec ~3 000 vues, 3 % de clics, 5 % de leads et 20 % de closing, on obtient ~1 vente. YouTube seul n'atteindra donc probablement pas 500 $ en 14 jours. La **prospection directe** (20-30 messages ciblés/jour à des freelances/TPE qui expriment publiquement ce problème) est le levier P0 ; la chaîne sert de preuve (« voici une démo de 40 s de ce que je ferais pour vous »).

Règles : messages individualisés, pas de spam ni d'envoi de masse, pas de scraping d'e-mails, respecter les règles de chaque plateforme (pas d'automatisation de DM), et toujours proposer une sortie (« pas intéressé ? aucun souci »). Prospection **envoyée par le propriétaire** depuis un compte dédié (je prépare, il envoie).

## Landing page
`landing/index.html` — une page statique. Placeholders à remplir : `{{LIEN_RESERVATION}}`, `{{LIEN_RESSOURCE}}`, `{{EMAIL_DEDIE}}`.

## Messages de prospection (à personnaliser, ≤ 70 mots)
**M1 — après un post où la personne se plaint de relances/devis**
> Bonjour [Prénom], j'ai vu votre message sur [sujet précis]. Je prépare des démos courtes sur l'automatisation des devis/relances avec l'IA (données fictives). Si ça vous parle, je vous envoie gratuitement un pack de modèles à adapter : {{LIEN_RESSOURCE}}. Aucun engagement, et pas de souci si ce n'est pas le bon moment.

**M2 — relance J+4 (une seule)**
> Re-bonjour [Prénom], juste pour vérifier que le pack vous est utile. Si vous voulez qu'on regarde ensemble votre cas (30 min, 59 $, plan écrit), voici la réservation : {{LIEN_RESERVATION}}. Sinon, bonne continuation !

**M3 — réponse à un lead chaud**
> Merci pour votre retour ! Pour être utile : quelle tâche vous coûte le plus de temps (devis, factures, relances, e-mails) et combien d'heures par semaine ? Je vous dis honnêtement si je peux vous aider.

## E-mails de suivi (lead magnet)
- **E1 (immédiat)** : lien vers le pack + « répondez-moi avec votre tâche la plus pénible, je vous suggère le bon prompt ».
- **E2 (J+2)** : mini-cas démonstratif (données fictives signalées) + lien vidéo.
- **E3 (J+5)** : offre audit 59 $ avec garantie ; désinscription en une phrase.
(Uniquement aux personnes qui ont demandé le pack ; consentement explicite ; lien de désinscription.)

## Proposition commerciale (modèle)
```
Objet : Proposition — Admin en pilote automatique pour [Entreprise]
1. Contexte : [2 phrases tirées de l'intake]
2. Objectif : réduire le temps passé sur [tâche] (mesure avant/après convenue ensemble)
3. Livrables : [liste]
4. Planning : [dates]
5. Prix : [59 $ audit | 290 $ pack] — paiement : [lien]
6. Garantie : [texte de 01-OFFER.md]
7. Hors périmètre : [liste]
8. Données : accès minimal, révoqué à la fin ; aucune donnée utilisée ailleurs.
9. Transparence : travail assisté par IA, relu par un humain.
```

## Script d'appel (30 min)
1. 3 min : cadre (objectif, durée, confidentialité).
2. 10 min : « Racontez-moi la dernière fois que vous avez fait un devis/une relance : combien de temps, quels outils ? »
3. 10 min : démonstration live sur un exemple fictif proche de leur cas.
4. 5 min : récapitulatif des 3 automatisations possibles ; proposer pack ou audit selon l'intérêt ; ne jamais forcer.
5. 2 min : prochaines étapes + lien de paiement.

## Affiliation (P2, complément)
Programmes candidats vus lors de la recherche (**à vérifier sur les pages officielles avant tout usage**, sources tierces) : FreshBooks (commission récurrente annoncée), Notion (50 % sur 12 mois annoncé). Ne recommander que des outils réellement testés dans les démos, avec mention « lien affilié » en description. Inscription : étape humaine (infos fiscales/paiement) — voir README.
