# Notification e-mail (sale:instant) — configuration sécurisée

L'e-mail part une seule fois, après un `CART_SUCCESS` vérifié, sans jamais retarder la prise de main (voir [INSTANT.md](INSTANT.md)).
Il ne contient aucun secret, cookie, jeton, URL ni donnée bancaire. **Rien de personnel ni de secret ne doit être écrit dans un fichier versionné.**

## 1. Variables d'environnement à définir

| Variable | Rôle | Obligatoire |
|---|---|---|
| `NOTIFICATION_EMAIL` | adresse du destinataire (lue via `toEnv`) | oui |
| `SMTP_USER` | identifiant de connexion au serveur SMTP (`smtp.userEnv`) | oui (avec `SMTP_PASS`) |
| `SMTP_PASS` | mot de passe du serveur SMTP, idéalement un mot de passe d'application (`smtp.passEnv`) | oui (avec `SMTP_USER`) |

Les noms sont ceux de `config/sale.example.yaml` ; vous pouvez en choisir d'autres en changeant `toEnv`, `userEnv`, `passEnv` (MAJUSCULES, chiffres et `_`).
Le fichier `.env` (copié depuis `.env.example`, **ignoré par Git**) est chargé automatiquement au démarrage ; vous pouvez aussi exporter les variables dans votre shell.

## 2. Paramètres non secrets, dans votre profil de vente (non versionné)

Copiez `config/sale.example.yaml` vers `config/sale.yaml` (ignoré par Git) et adaptez :

```yaml
advanced:
  notifications:
    email:
      enabled: true
      toEnv: NOTIFICATION_EMAIL
      on: CART_SUCCESS
      provider: smtp
      from: "expediteur@votre-domaine.tld"   # adresse d'expédition autorisée par VOTRE fournisseur
      smtp: { host: "smtp.votre-fournisseur.tld", port: 587, secure: false, userEnv: SMTP_USER, passEnv: SMTP_PASS }
```

- `port: 587` + `secure: false` : connexion STARTTLS (le transport exige TLS hors boucle locale, jamais d'authentification en clair) ; `port: 465` + `secure: true` : TLS direct.
- `from` et `smtp.host` sont propres à votre fournisseur : les valeurs de l'exemple (`example.org`) sont des **espaces réservés** à remplacer.
- Le profil générique n'accepte pas `notifications` à la racine : la section est sous `advanced`.

## 3. Comportement en cas de configuration incomplète

`sale:instant` refuse de démarrer, **avant toute attente ou requête**, si : `NOTIFICATION_EMAIL`, `SMTP_USER` ou `SMTP_PASS` est absente ou vide, l'adresse est invalide, `provider`/`from`/`smtp` manquent, une clé est inconnue, ou un secret est écrit en clair à la place d'un nom de variable. Le message nomme la variable manquante, jamais sa valeur.

## 4. Vérifier sans rien envoyer

```bash
npm test                                   # double local + faux serveur SMTP en boucle locale, aucun vrai serveur
npm run sale:check -- --config config/sale.yaml   # évaluation locale, aucune requête réseau
```
