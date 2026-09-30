/**
 * Assainissement des textes avant journalisation, notification ou télémétrie.
 * Les messages d'erreur des sites/navigateurs contiennent souvent des URLs à jeton, des e-mails, des numéros de
 * carte ou des en-têtes d'autorisation : on les retire À LA SOURCE (logger, notifier, télémétrie), pas au cas par cas.
 */
export interface RedactOptions {
  /** "keep-path" (défaut) : `https://hôte/chemin?<masqué>` ; "drop" : `<url>`. */
  urls?: "keep-path" | "drop";
  /** Longueur minimale d'une suite de chiffres masquée (défaut 8). */
  minDigits?: number;
  /**
   * Masque aussi les identifiants opaques (≥ 16 caractères mêlant lettres et chiffres : jetons, identifiants de session).
   * Actif pour la télémétrie et tout texte destiné à Claude ; inactif dans les logs, où il abîmerait les chemins de fichiers.
   */
  tokens?: boolean;
}

const SECRET_KEYS = "access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|passwd|pwd|passphrase|secret|session[_-]?id|sessionid|session|sid|authorization|api[_-]?key|apikey|cookie|csrf|xsrf|signature|cvv2?|cvc2?|cid|card[_-]?number|card[_-]?no|pan|security[_-]?code";

/** Variables d'environnement dont la VALEUR est un secret (par leur nom) : masquées telles quelles où qu'elles apparaissent. */
const SECRET_ENV_NAME = /(key|token|secret|passw(or)?d|pwd|cookie|auth|credential|webhook|bearer|session)/i;
const tracked = new Set<string>();
/** Déclare d'autres variables (ex. `meta.requires.env` d'un adaptateur, `auth.envVar` d'un client API) dont la valeur est secrète. */
export const trackSecretEnv = (...names: (string | undefined)[]): void => void names.forEach((n) => n && tracked.add(n));
/** Valeurs secrètes courantes : lues À L'APPEL (un secret défini après le démarrage est quand même masqué). */
export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) if (v && v.length >= 8 && (tracked.has(k) || SECRET_ENV_NAME.test(k))) out.push(v);
  return out.sort((a, b) => b.length - a.length);
}

export function redact(text: string, opts: RedactOptions = {}): string {
  const minDigits = opts.minDigits ?? 8;
  let s = text;
  // 0. Valeurs exactes des secrets d'environnement (clé d'API, jeton, webhook…), même sous une forme inhabituelle.
  for (const v of secretValues()) if (s.includes(v)) s = s.split(v).join("<secret>");

  // 1. URLs : sans paramètres, fragment ni identifiants intégrés.
  s = s.replace(/https?:\/\/[^\s"'<>)\]]+/gi, (m) => {
    if (opts.urls === "drop") return "<url>";
    try {
      const u = new URL(m);
      return `${u.origin}${u.pathname}${u.search || u.hash ? "?<masqué>" : ""}`;
    } catch {
      return "<url>";
    }
  });
  // 1b. Identifiants intégrés à une URL d'un autre schéma (postgres://u:mdp@hôte, ftp://…) : retirés aussi.
  s = s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@"'<>]+@/gi, "$1<masqué>@");
  // 1c. En-têtes Cookie / Set-Cookie : TOUTE la ligne de valeurs (a=1; b=2; …), pas seulement la première paire.
  s = s.replace(/(\b(?:set-)?cookie["']?\s*:\s*)[^\r\n]+/gi, "$1<masqué>");
  // 2. Clés sensibles : password=…, "token": "…", Authorization: Bearer …
  s = s.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "<masqué>");
  s = s.replace(new RegExp(`(["']?\\b(?:${SECRET_KEYS})["']?\\s*[:=]\\s*)(["']?)[^\\s"'&,;)\\]}]+`, "gi"), "$1$2<masqué>");
  // 3. Clés d'API, e-mails, IBAN, numéros de carte (avec ou sans séparateurs), longues suites de chiffres.
  s = s.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "<clé-api>");
  s = s.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<e-mail>");
  s = s.replace(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, "<iban>");
  s = s.replace(/\b(?:\d[ -]?){12,18}\d\b/g, "<carte>");
  s = s.replace(new RegExp(`\\d{${minDigits},}`, "g"), "<nombre>");
  if (opts.tokens) s = s.replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{16,}\b/g, "<jeton>");
  return s;
}
