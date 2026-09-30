# Preuves officielles

Un fichier JSON par relevé (`<plateforme>-<date>.json`). C'est **la seule source d'autorisation** : le catalogue
(`platforms/catalog.json`) ne contient que des données statiques.

```json
{
  "platform": "identifiant du catalogue",
  "checkedAt": "AAAA-MM-JJ",
  "source": { "url": "https://…", "title": "Titre de la page officielle" },
  "channel": "api | browser | both | human | prohibited",
  "authorization": "Ce que la source autorise ou interdit, en une phrase.",
  "excerpt": "Passage EXACT de la page officielle (≥ 30 caractères).",
  "note": "facultatif"
}
```

- `channel` : `api` (API officielle autorisée ; le navigateur ne l'est PAS par cette preuve), `browser` (interface autorisée ;
  l'API ne l'est PAS), `both`, `human` (seule l'intervention humaine est possible → `HUMAN_ONLY`), `prohibited` (la source
  interdit l'automatisation → `NOT_ALLOWED`). L'absence de preuve pour un canal = canal non autorisé.
- Autres sujets (documentation) : `"topic": "api|queue|limits|cart"` + `"value"` à la place de `channel`
  (voir `npm run platform template <id> --topic queue`).
- Refusée : URL non https, avec identifiants, fragment, query (sauf `allowedQueryParams` du catalogue) ou lien de redirection ;
  date absente/inexistante/future ; sans extrait ; plus de 180 jours ; domaine hors `officialHosts` ; champ inconnu. Une preuve valide expire 180 jours après `checkedAt`.
- Ne créez **jamais** de preuve de mémoire : consultez la page officielle et citez-la.

Commandes : `npm run platform verify [id]` · `npm run platform check [fichier]` · `npm run platform add <fichier>` ·
`npm run platform history <id>` · `npm run platform template <id>`.
