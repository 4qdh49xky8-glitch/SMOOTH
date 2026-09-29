import Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";
import type { BotConfig } from "../config/schema.js";
import type { SelectorResolver, SelectorSpec } from "../selectors/resolver.js";
import type { Logger } from "../utils/logger.js";

/** Tout élément ressemblant à une action de paiement est exclu, quoi que réponde le modèle. */
const PAYMENT_RE = /(pay(er|ment|pal)?\b|paiement|checkout\/pay|place[- ]?order|commander|confirmer (la|votre) commande|finaliser|acheter maintenant|buy now|purchase)/i;

export const looksLikePayment = (s: string): boolean => PAYMENT_RE.test(s);

interface DigestEl {
  i: number;
  tag: string;
  text: string;
  aria: string;
  testid: string;
  id: string;
  href: string;
  stable: string | null;
}

/** Résumé compact des éléments interactifs visibles (chaîne : évite les soucis de transpilation dans evaluate). */
const DIGEST_SCRIPT = `(() => {
  const nodes = Array.from(document.querySelectorAll('a,button,input,select,textarea,[role="button"],[data-testid]'));
  const out = [];
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || cs.display === 'none') continue;
    const testid = el.getAttribute('data-testid') || '';
    const id = el.id || '';
    const aria = el.getAttribute('aria-label') || '';
    const text = (el.innerText || el.value || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const stable = testid ? '[data-testid="' + testid + '"]' : id ? '#' + CSS.escape(id) : aria ? el.tagName.toLowerCase() + '[aria-label="' + aria + '"]' : null;
    el.setAttribute('data-agent-idx', String(out.length));
    out.push({ i: out.length, tag: el.tagName.toLowerCase(), text, aria, testid, id, href: el.getAttribute('href') || '', stable });
    if (out.length >= 150) break;
  }
  return { url: location.href, title: document.title, text: (document.body.innerText || '').slice(0, 1500), els: out };
})()`;

/**
 * Claude n'intervient QUE pour interpréter une page quand les sélecteurs déterministes échouent.
 * Il ne clique jamais lui-même : il désigne un élément, le code valide (visible, pas un paiement)
 * puis mémorise un sélecteur stable pour que la prochaine fois tout soit de nouveau déterministe.
 */
export class ClaudeAssistant {
  private client: Anthropic | null;
  private callsLeft: number;

  constructor(
    private readonly cfg: BotConfig["claude"],
    private readonly log: Logger,
  ) {
    const key = process.env.ANTHROPIC_API_KEY;
    this.client = cfg.enabled && key ? new Anthropic({ apiKey: key, maxRetries: 0 }) : null;
    if (cfg.enabled && !key) log.warn("claude.enabled=true mais ANTHROPIC_API_KEY absent : assistant désactivé.");
    this.callsLeft = cfg.maxCallsPerRun;
  }

  get enabled(): boolean {
    return this.client !== null && this.callsLeft > 0;
  }

  private async ask(system: string, user: string): Promise<string> {
    if (!this.client) throw new Error("Claude désactivé");
    this.callsLeft--;
    const res = await this.client.messages.create(
      { model: this.cfg.model, max_tokens: 300, system, messages: [{ role: "user", content: user }] },
      { timeout: this.cfg.timeoutMs },
    );
    return res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
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
      const digest = (await page.evaluate(DIGEST_SCRIPT)) as { url: string; title: string; text: string; els: DigestEl[] };
      const system =
        "Tu aides un agent de billetterie dont un sélecteur CSS ne fonctionne plus. " +
        "On te donne les éléments interactifs de la page. Réponds UNIQUEMENT par un JSON " +
        '{"index": <numéro ou null>, "reason": "<court>"} désignant l\'élément décrit. ' +
        "Réponds null si aucun ne convient ou s'il y a le moindre doute. " +
        "Ne désigne JAMAIS un bouton de paiement, de commande ou de validation finale.";
      const user =
        `Élément recherché : ${spec.description}\nURL : ${digest.url}\nTitre : ${digest.title}\n` +
        `Texte de la page : ${digest.text}\nÉléments :\n` +
        digest.els
          .map((e) => `${e.i}. <${e.tag}> "${e.text}" aria="${e.aria}" testid="${e.testid}" id="${e.id}" href="${e.href}"`)
          .join("\n");
      const answer = ClaudeAssistant.json(await this.ask(system, user));
      const idx = typeof answer?.index === "number" ? answer.index : null;
      const el = idx === null ? undefined : digest.els.find((e) => e.i === idx);
      if (!el) {
        this.log.warn(`Claude : aucun élément proposé pour « ${spec.name} » (${String(answer?.reason ?? "?")})`);
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
      this.log.info(`Claude a réparé « ${spec.name} » → ${el.stable} (mémorisé pour les prochains runs)`);
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
      const d = (await page.evaluate(DIGEST_SCRIPT)) as { url: string; title: string; text: string };
      return (
        await this.ask(
          "En une phrase française, explique ce que montre cette page de billetterie et ce que l'utilisateur doit faire (erreur, file d'attente, connexion, etc.).",
          `URL: ${d.url}\nTitre: ${d.title}\nTexte: ${d.text}`,
        )
      ).trim();
    } catch {
      return null;
    }
  }
}
