import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Locator, Page } from "playwright";
import { SelectorNotFoundError } from "../utils/errors.js";

export interface SelectorSpec {
  name: string;
  /** Décrit l'élément en langage naturel (sert aussi de but à Claude en cas de réparation). */
  description: string;
  /** Du plus stable (data-testid, rôle, aria) au plus fragile (texte, classes). */
  candidates: string[];
}

type Cache = Record<string, string[]>;

/**
 * Résout un SelectorSpec en Locator. Tous les candidats sont combinés avec `.or()` :
 * un seul aller-retour vers le navigateur, quel que soit le nombre de candidats.
 * Les sélecteurs « réparés » (par Claude, validés) sont mémorisés sur disque et essayés en premier
 * → la réparation coûte un appel API une fois, puis redevient déterministe.
 */
export class SelectorResolver {
  private cache: Cache = {};

  constructor(
    private readonly siteId: string,
    private readonly cachePath = ".cache/healed-selectors.json",
  ) {
    if (existsSync(cachePath)) {
      try {
        this.cache = JSON.parse(readFileSync(cachePath, "utf8")) as Cache;
      } catch {
        this.cache = {};
      }
    }
  }

  private key(spec: SelectorSpec): string {
    return `${this.siteId}:${spec.name}`;
  }

  locator(page: Page, spec: SelectorSpec): Locator {
    const all = [...(this.cache[this.key(spec)] ?? []), ...spec.candidates];
    return all
      .map((c) => page.locator(c))
      .reduce((acc, next) => acc.or(next))
      .first();
  }

  /** Attend que l'élément soit visible ; lève SelectorNotFoundError sinon. */
  async wait(page: Page, spec: SelectorSpec, timeout?: number): Promise<Locator> {
    const loc = this.locator(page, spec);
    try {
      await loc.waitFor({ state: "visible", timeout });
    } catch {
      throw new SelectorNotFoundError(spec);
    }
    return loc;
  }

  async click(page: Page, spec: SelectorSpec, timeout?: number): Promise<void> {
    const loc = await this.wait(page, spec, timeout);
    await loc.click({ timeout });
  }

  remember(spec: SelectorSpec, selector: string): void {
    const k = this.key(spec);
    this.cache[k] = [selector, ...(this.cache[k] ?? []).filter((s) => s !== selector)].slice(0, 3);
    mkdirSync(dirname(this.cachePath), { recursive: true });
    writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2));
  }
}
