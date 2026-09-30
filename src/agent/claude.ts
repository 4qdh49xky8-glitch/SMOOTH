import Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";
import type { BotConfig } from "../config/schema.js";
import type { SelectorResolver, SelectorSpec } from "../selectors/resolver.js";
import type { Logger } from "../utils/logger.js";
import { redact } from "../utils/redact.js";

/** Tout élément ressemblant à une action de paiement est exclu, quoi que réponde le modèle. */
const PAYMENT_RE = /(pay(er|ment|pal|s)?\b|paiement|checkout|place[- ]?order|order now|confirm(er)? (la|ma|votre|my|your|the)? ?(commande|achat|order|purchase)|valider (la|ma|mon|votre) (commande|achat)|passer (la|ma|votre) commande|commander|finaliser|acheter|buy\b|purchase|r[ée]gler|r[èe]glement|carte (bancaire|de cr[ée]dit)|credit card|card number|cvv|cvc|iban)/i;

export const looksLikePayment = (s: string): boolean => PAYMENT_RE.test(s);

/** Forme brute renvoyée par la page (jamais transmise telle quelle à Claude). */
export interface RawDigestEl {
  i: number;
  tag: string;
  type: string;
  text: string;
  aria: string;
  testid: string;
  id: string;
  href: string;
  stable: string | null;
}
export interface RawDigest {
  url: string;
  title: string;
  els: RawDigestEl[];
}

/** Ce qui est réellement envoyé à Claude : aucune valeur de champ, aucun texte de page, aucun paramètre d'URL. */
export interface SafeDigest {
  page: string;
  title: string;
  els: { i: number; tag: string; text: string; aria: string; testid: string; id: string; href: string }[];
}

/**
 * Éléments interactifs visibles UNIQUEMENT — pas le texte de la page, pas les champs de saisie.
 * Filtre n°1 (dans la page, avant même de sortir du navigateur) :
 *  - aucun <input> sauf boutons (submit/button/reset/image) ; aucun <textarea> ni <select> ; jamais de `.value` ;
 *  - rien de ce qui est dans un formulaire de paiement/identité (autocomplete cc-*, password, hidden, email, tel…) ;
 *  - jamais le titre de la page (il contient souvent le nom du client) ni le texte hors éléments interactifs.
 * Chaîne (et non fonction) : évite les soucis de transpilation dans evaluate.
 */
export const DIGEST_SCRIPT = `(() => {
  const BUTTON_INPUTS = ['submit', 'button', 'reset', 'image'];
  // Périmètre : le contenu principal. Menu de compte, en-tête, navigation et pied de page (où s'affichent nom et e-mail) sont exclus.
  const main = document.querySelector('main, [role="main"]');
  const SKIP = 'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]';
  const nodes = Array.from((main || document).querySelectorAll('a,button,input,[role="button"],[data-testid]'));
  const out = [];
  for (const el of nodes) {
    if (!main && el.closest(SKIP)) continue;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'input' && !BUTTON_INPUTS.includes(type)) continue;
    if (tag === 'textarea' || tag === 'select') continue;
    if (el.closest('[autocomplete*="cc-"], [autocomplete="current-password"], [autocomplete="new-password"]')) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || cs.display === 'none') continue;
    const testid = el.getAttribute('data-testid') || '';
    const id = el.id || '';
    const aria = el.getAttribute('aria-label') || '';
    const label = tag === 'input' ? (el.getAttribute('value') || el.getAttribute('alt') || '') : (el.innerText || '');
    const text = label.trim().replace(/\\s+/g, ' ').slice(0, 80);
    const stable = testid ? '[data-testid="' + testid + '"]' : id ? '#' + CSS.escape(id) : aria ? tag + '[aria-label="' + aria + '"]' : null;
    out.push({ i: out.length, tag, type, text, aria, testid, id, href: el.getAttribute('href') || '', stable });
    if (out.length >= 80) break;
  }
  return { url: location.href, title: '', els: out };
})()`;

/** Diagnostic : titre, titres de section et alertes seulement (jamais le texte complet de la page). */
export const DIAG_SCRIPT = `(() => {
  const pick = (sel, n) => Array.from(document.querySelectorAll(sel)).map((e) => (e.innerText || '').trim().replace(/\\s+/g, ' ')).filter(Boolean).slice(0, n);
  return { url: location.href, title: document.title, headings: pick('h1,h2,h3', 6), alerts: pick('[role="alert"],[role="status"],.error,.alert', 4) };
})()`;

const safeText = (s: string, max: number): string => redact(s, { urls: "drop", minDigits: 6, tokens: true }).slice(0, max);

/** URL réduite à hôte + chemin : jamais de paramètres (jetons, identifiants de session). */
export function safeUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname}`;
  } catch {
    return "<url>";
  }
}

/** Chemin seul d'un lien (sans paramètres) ; les liens vers d'autres hôtes gardent leur hôte. */
function safeHref(href: string, pageUrl: string): string {
  if (!href || href.startsWith("#") || /^(javascript|data):/i.test(href)) return "";
  try {
    const u = new URL(href, pageUrl);
    return u.origin === new URL(pageUrl).origin ? u.pathname : `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
}

/**
 * Filtre n°2 (dans Node, en défense en profondeur) : même si la page renvoyait plus que prévu, seuls des champs
 * courts, assainis et sans paramètres d'URL sont retenus. Les champs de saisie sont écartés une seconde fois.
 */
/** Éléments qui révèlent l'identité (menu de compte, déconnexion…) : écartés sauf si le sélecteur cherché en relève. */
const IDENTITY_RE = /(compte|account|profil|profile|mon[- ]?espace|d[ée]connexion|log[- ]?out|sign[- ]?out|utilisateur|\buser\b|bonjour|hello|welcome|bienvenue)/i;
const ACCOUNT_TARGET_RE = /(compte|account|profil|profile|connexion|login|log[- ]?in|sign[- ]?in|identifiant)/i;

export function sanitizeDigest(raw: RawDigest, spec?: SelectorSpec): SafeDigest {
  const BUTTON_INPUTS = new Set(["submit", "button", "reset", "image"]);
  const wantsAccount = spec ? ACCOUNT_TARGET_RE.test(`${spec.name} ${spec.description}`) : false;
  return {
    page: safeUrl(raw.url),
    title: "", // jamais transmis : il contient souvent le nom du client
    els: raw.els
      .filter((e) => e.tag !== "textarea" && e.tag !== "select" && (e.tag !== "input" || BUTTON_INPUTS.has(e.type)))
      .filter((e) => wantsAccount || !IDENTITY_RE.test(`${e.text} ${e.aria} ${e.href} ${e.testid} ${e.id}`))
      .slice(0, 80)
      .map((e) => ({
        i: e.i,
        tag: e.tag,
        text: safeText(e.text ?? "", 60),
        aria: safeText(e.aria ?? "", 60),
        testid: safeText(e.testid ?? "", 60),
        id: safeText(e.id ?? "", 60),
        href: safeHref(e.href ?? "", raw.url),
      })),
  };
}

export function buildHealPrompt(spec: SelectorSpec, d: SafeDigest): { system: string; user: string } {
  return {
    system:
      "Tu aides un agent de billetterie dont un sélecteur CSS ne fonctionne plus. " +
      "On te donne les éléments interactifs de la page (sans le contenu de la page ni les champs de saisie). Réponds UNIQUEMENT par un JSON " +
      '{"index": <numéro ou null>, "reason": "<court>"} désignant l\'élément décrit. ' +
      "Réponds null si aucun ne convient ou s'il y a le moindre doute. " +
      "Ne désigne JAMAIS un bouton de paiement, de commande ou de validation finale.",
    user:
      `Élément recherché : ${spec.description}\nPage : ${d.page}\nÉléments :\n` +
      d.els.map((e) => `${e.i}. <${e.tag}> "${e.text}" aria="${e.aria}" testid="${e.testid}" id="${e.id}" href="${e.href}"`).join("\n"),
  };
}

/** Sous-ensemble du client Anthropic utilisé ici : permet d'injecter un faux client (tests) et d'auditer les requêtes. */
export interface MessagesClient {
  messages: {
    create(
      body: { model: string; max_tokens: number; system: string; messages: { role: "user"; content: string }[] },
      opts?: { timeout?: number },
    ): Promise<{ content: { type: string; text?: string }[] }>;
  };
}

/**
 * Claude n'intervient QUE pour interpréter une page quand les sélecteurs déterministes échouent.
 * Il ne clique jamais lui-même : il désigne un élément, le code valide (visible, pas un paiement)
 * puis mémorise un sélecteur stable pour que la prochaine fois tout soit de nouveau déterministe.
 *
 * Données transmises : hôte + chemin de la page (sans paramètres), titre, et pour chaque élément interactif visible :
 * balise, libellé court, aria-label, data-testid, id, chemin du lien — tous assainis (e-mails, cartes, longs nombres,
 * jetons masqués). JAMAIS : valeurs de champs, mots de passe, texte de la page, cookies, paramètres d'URL.
 */
/** Point d'accès FIXE : ni ANTHROPIC_BASE_URL (variable d'environnement du SDK), ni la config ne peuvent rediriger les requêtes vers un autre domaine. */
export const ANTHROPIC_API_URL = "https://api.anthropic.com";

export class ClaudeAssistant {
  private client: MessagesClient | null;
  private callsLeft: number;

  constructor(
    private readonly cfg: BotConfig["claude"],
    private readonly log: Logger,
    client?: MessagesClient,
  ) {
    const key = process.env.ANTHROPIC_API_KEY;
    this.client = client ?? (cfg.enabled && key ? (new Anthropic({ apiKey: key, maxRetries: 0, baseURL: ANTHROPIC_API_URL }) as unknown as MessagesClient) : null);
    if (cfg.enabled && !key && !client) log.warn("claude.enabled=true mais ANTHROPIC_API_KEY absent : assistant désactivé.");
    this.callsLeft = cfg.maxCallsPerRun;
  }

  get enabled(): boolean {
    return this.client !== null && this.cfg.enabled && this.callsLeft > 0;
  }

  private async ask(system: string, user: string): Promise<string> {
    if (!this.client) throw new Error("Claude désactivé");
    this.callsLeft--;
    const res = await this.client.messages.create(
      { model: this.cfg.model, max_tokens: 300, system, messages: [{ role: "user", content: user }] },
      { timeout: this.cfg.timeoutMs },
    );
    return res.content.flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join("");
  }

  private static json(text: string): Record<string, unknown> | null {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** Répare un sélecteur : retourne true si un nouvel élément valide a été trouvé et mémorisé. */
  async healSelector(page: Page, spec: SelectorSpec, resolver: SelectorResolver): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const raw = (await page.evaluate(DIGEST_SCRIPT)) as RawDigest;
      const safe = sanitizeDigest(raw, spec);
      const { system, user } = buildHealPrompt(spec, safe);
      const answer = ClaudeAssistant.json(await this.ask(system, user));
      const idx = typeof answer?.index === "number" ? answer.index : null;
      const el = idx === null ? undefined : raw.els.find((e) => e.i === idx);
      if (!el) {
        this.log.warn(`Claude : aucun élément proposé pour « ${spec.name} » (${redact(String(answer?.reason ?? "?")).slice(0, 80)})`);
        return false;
      }
      if (looksLikePayment(`${el.text} ${el.aria} ${el.href} ${el.testid} ${el.id}`)) {
        this.log.warn(`Claude a proposé un élément de type paiement pour « ${spec.name} » : refusé.`);
        return false;
      }
      if (!el.stable) {
        this.log.warn(`Élément proposé sans attribut stable (id/data-testid/aria-label) : non mémorisé, ignoré.`);
        return false;
      }
      const count = await page.locator(el.stable).count();
      if (count !== 1) return false;
      resolver.remember(spec, el.stable);
      this.log.info(`Claude a réparé « ${spec.name} » → ${redact(el.stable)} (mémorisé pour les prochains runs)`);
      return true;
    } catch (err) {
      this.log.warn(`Assistant Claude indisponible : ${(err as Error).message}`);
      return false;
    }
  }

  /** Diagnostic en une phrase d'une page inattendue, pour informer l'humain. Aucune action. */
  async diagnose(page: Page): Promise<string | null> {
    if (!this.enabled) return null;
    try {
      const d = (await page.evaluate(DIAG_SCRIPT)) as { url: string; title: string; headings: string[]; alerts: string[] };
      const ctx =
        `Page : ${safeUrl(d.url)}\n` +
        `Titres : ${(d.headings ?? []).map((h) => safeText(h, 80)).join(" | ")}\nAlertes : ${(d.alerts ?? []).map((a) => safeText(a, 120)).join(" | ")}`;
      const out = await this.ask(
        "En une phrase française, explique ce que montre cette page de billetterie et ce que l'utilisateur doit faire (erreur, file d'attente, connexion, etc.).",
        ctx,
      );
      return safeText(out.trim(), 240);
    } catch {
      return null;
    }
  }
}
