# Preuves officielles

Un fichier JSON par relevé (`<plateforme>-<date>.json`). C'est **la seule source d'autorisation** : le catalogue
(`platforms/catalog.json`) ne contient que des données statiques.

```json
{
  "platform": "identifiant du catalogue",
  "checkedAt": "AAAA-MM-JJ",
  "source": { "url": "https://…", "title": "Titre de la page officielle" },
  "channel": "api | browser | both | human",
  "authorization": "Ce que la source autorise ou interdit, en une phrase.",
  "excerpt": "Passage EXACT de la page officielle (≥ 30 caractères).",
  "note": "facultatif"
}
```

- `channel` : `api` (API officielle autorisée), `browser` (automatisation de l'interface autorisée), `both`, ou `human`
  (rien d'automatisé : achat humain seulement).
- Autres sujets (documentation) : `"topic": "api|queue|limits|cart"` + `"value"` à la place de `channel`
  (voir `npm run platform template <id> --topic queue`).
- Refusée : sans URL https, sans date, sans extrait, plus de 180 jours, domaine hors `officialHosts` de la plateforme,
  champ inconnu. Une preuve valide expire 180 jours après `checkedAt`.
- Ne créez **jamais** de preuve de mémoire : consultez la page officielle et citez-la.

Commandes : `npm run platform verify [id]` · `npm run platform check [fichier]` · `npm run platform add <fichier>` ·
`npm run platform history <id>` · `npm run platform template <id>`.
