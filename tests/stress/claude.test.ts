import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { Agent } from "../../src/agent/Agent.js";
import { buildHealPrompt, ClaudeAssistant, sanitizeDigest, type MessagesClient, type RawDigest } from "../../src/agent/claude.js";
import { ConfigSchema, type BotConfig } from "../../src/config/schema.js";
import { SelectorResolver, type SelectorSpec } from "../../src/selectors/resolver.js";
import { Clock } from "../../src/utils/clock.js";
import { SelectorNotFoundError } from "../../src/utils/errors.js";
import { silentLogger } from "../../src/utils/logger.js";
import { FakeAdapter, offer } from "../helpers/fakeAdapter.js";

/** Scénario 10 — sélecteur inconnu : Claude n'analyse que les éléments nécessaires, sans donnée sensible. */
const SECRETS = ["hunter2secret", "jean.dupont@example.com", "4970101234567890", "CANARY_TOKEN_abc123def456", "Jean Dupont", "12 rue de la Paix", "SESSION-9f8e7d6c5b4a"];
const spec: SelectorSpec = { name: "addToCart", description: "Bouton « Ajouter au panier » (jamais un bouton de paiement)", candidates: ["#nope"] };
const cfg = (over: Partial<BotConfig["claude"]> = {}): BotConfig["claude"] => ConfigSchema.parse({ site: "x", event: { name: "e" }, sale: { startTime: "2030-01-01T00:00:00Z" }, tickets: { quantity: 1, maxPricePerTicket: 1 }, claude: { enabled: true, ...over } }).claude;

/** Ce que la page pourrait renvoyer de pire : valeurs de champs, jetons dans les liens, texte de page, données personnelles. */
const hostile: RawDigest & { text: string } = {
  url: "https://billets.example/panier?token=CANARY_TOKEN_abc123def456&sid=SESSION-9f8e7d6c5b4a#frag",
  title: "Panier de Jean Dupont — jean.dupont@example.com",
  text: "Bonjour Jean Dupont, 12 rue de la Paix. Carte 4970101234567890",
  els: [
    { i: 0, tag: "input", type: "password", text: "hunter2secret", aria: "", testid: "", id: "pwd", href: "", stable: "#pwd" },
    { i: 1, tag: "input", type: "email", text: "jean.dupont@example.com", aria: "", testid: "", id: "mail", href: "", stable: "#mail" },
    { i: 2, tag: "textarea", type: "", text: "12 rue de la Paix", aria: "", testid: "", id: "addr", href: "", stable: "#addr" },
    { i: 3, tag: "select", type: "", text: "Jean Dupont", aria: "", testid: "", id: "who", href: "", stable: "#who" },
    { i: 4, tag: "a", type: "", text: "Mon compte jean.dupont@example.com", aria: "Compte de Jean Dupont", testid: "", id: "", href: "/compte?sid=SESSION-9f8e7d6c5b4a&token=CANARY_TOKEN_abc123def456", stable: null },
    { i: 5, tag: "button", type: "", text: "Ajouter au panier", aria: "", testid: "add-to-cart", id: "", href: "", stable: '[data-testid="add-to-cart"]' },
    { i: 6, tag: "input", type: "submit", text: "Valider 4970101234567890", aria: "", testid: "", id: "go", href: "", stable: "#go" },
  ],
};

function fakeClient(answer: unknown): { client: MessagesClient; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    client: {
      messages: {
        create: async (body) => {
          prompts.push(`${body.system}\n${body.messages.map((m) => m.content).join("\n")}`);
          return { content: [{ type: "text", text: JSON.stringify(answer) }] };
        },
      },
    },
  };
}
const pageReturning = (raw: unknown, count = 1): Page =>
  ({ evaluate: async () => raw, bringToFront: async () => undefined, locator: () => ({ count: async () => count }) }) as unknown as Page;

test("10 · le résumé envoyé à Claude ne contient ni valeurs de champs, ni texte de page, ni données personnelles, ni paramètres d'URL", () => {
  const safe = sanitizeDigest(hostile, spec);
  const { system, user } = buildHealPrompt(spec, safe);
  const sent = `${system}\n${user}`;
  for (const s of SECRETS) assert.ok(!sent.includes(s), `« ${s} » transmis à Claude`);
  assert.ok(!/[?#][^\s"]*(token|sid)=/.test(sent), "paramètres d'URL transmis");
  assert.ok(!safe.els.some((e) => ["input:password", "input:email", "textarea", "select"].includes(e.tag + (e.tag === "input" ? ":" + (hostile.els[e.i]!.type) : ""))), "champs de saisie transmis");
  assert.ok(sent.includes("Ajouter au panier"), "l'élément nécessaire, lui, est bien présent");
  assert.equal(safe.page, "https://billets.example/panier");
  assert.ok(safe.els.length <= 80);
});

test("10 · à l'exécution : le prompt réellement envoyé est propre et l'élément désigné est mémorisé", async () => {
  const { client, prompts } = fakeClient({ index: 5, reason: "bouton d'ajout" });
  const claude = new ClaudeAssistant(cfg(), silentLogger, client);
  const remembered: string[] = [];
  const resolver = { remember: (_s: SelectorSpec, sel: string) => void remembered.push(sel) } as unknown as SelectorResolver;
  assert.equal(await claude.healSelector(pageReturning(hostile), spec, resolver), true);
  assert.deepEqual(remembered, ['[data-testid="add-to-cart"]']);
  assert.equal(prompts.length, 1);
  for (const s of SECRETS) assert.ok(!prompts[0]!.includes(s), `« ${s} » dans le prompt`);
});

test("10 · Claude ne peut ni désigner un paiement, ni un élément sans attribut stable, ni dépasser son quota d'appels", async () => {
  const resolver = { remember: () => assert.fail("rien ne doit être mémorisé") } as unknown as SelectorResolver;
  const pay: RawDigest = { url: "https://x.example/p", title: "t", els: [{ i: 0, tag: "button", type: "", text: "Payer maintenant", aria: "", testid: "pay", id: "", href: "", stable: '[data-testid="pay"]' }] };
  assert.equal(await new ClaudeAssistant(cfg(), silentLogger, fakeClient({ index: 0 }).client).healSelector(pageReturning(pay), spec, resolver), false);
  assert.equal(await new ClaudeAssistant(cfg(), silentLogger, fakeClient({ index: 4 }).client).healSelector(pageReturning(hostile), spec, resolver), false); // pas d'attribut stable
  assert.equal(await new ClaudeAssistant(cfg(), silentLogger, fakeClient({ index: 99 }).client).healSelector(pageReturning(hostile), spec, resolver), false); // index inexistant
  assert.equal(await new ClaudeAssistant(cfg(), silentLogger, fakeClient({ index: 5 }).client).healSelector(pageReturning(hostile, 2), spec, resolver), false); // sélecteur ambigu

  const limited = fakeClient({ index: null });
  const one = new ClaudeAssistant(cfg({ maxCallsPerRun: 1 }), silentLogger, limited.client);
  await one.healSelector(pageReturning(hostile), spec, resolver);
  await one.healSelector(pageReturning(hostile), spec, resolver);
  assert.equal(limited.prompts.length, 1, "le quota d'appels est respecté");
  assert.equal(one.enabled, false);
});

test("10 · diagnostic : titres de section et alertes seulement — ni titre de page, ni texte complet", async () => {
  const { client, prompts } = fakeClient({});
  const claude = new ClaudeAssistant(cfg(), silentLogger, client);
  const diag = { url: "https://x.example/e?token=CANARY_TOKEN_abc123def456", title: "Erreur pour jean.dupont@example.com", headings: ["Oups"], alerts: ["Session SESSION-9f8e7d6c5b4a expirée, carte 4970101234567890"] };
  await claude.diagnose({ evaluate: async () => diag } as unknown as Page);
  for (const s of SECRETS) assert.ok(!prompts[0]!.includes(s), `« ${s} » dans le diagnostic`);
});

test("10 · dans le cœur : sélecteur inconnu → réparation, nouvel essai, panier ; Claude n'est jamais appelé sur le chemin nominal", async () => {
  const build = (failFirst: boolean) => {
    const adapter = new FakeAdapter();
    adapter.offers = [offer({ id: "a" })];
    if (failFirst) adapter.failures.selectOffer = [new SelectorNotFoundError(spec)];
    const fake = fakeClient({ index: 5 });
    const claude = new ClaudeAssistant(cfg(), silentLogger, fake.client);
    const config = ConfigSchema.parse({
      site: "fake", event: { name: "T", url: "http://127.0.0.1:9/e" }, sale: { startTime: new Date(Date.now() - 1000).toISOString() },
      tickets: { quantity: 2, maxPricePerTicket: 150 }, timing: { preArmSeconds: 0, maxWaitAfterSaleSeconds: 3 },
      notifications: { desktop: false, sound: false }, telemetry: { enabled: false }, claude: { enabled: true },
    });
    const agent = new Agent({
      config, adapter, claude, log: silentLogger, clock: new Clock(), notifier: async () => undefined,
      ctx: { config, context: {} as never, page: pageReturning(hostile), log: silentLogger, env: {}, selectors: new SelectorResolver("fake", "/nonexistent/x.json") },
    });
    return { agent, adapter, fake };
  };
  const nominal = build(false);
  assert.equal((await nominal.agent.run()).finalState, "CART_SUCCESS");
  assert.equal(nominal.fake.prompts.length, 0, "aucun appel à Claude quand tout se passe bien");

  const broken = build(true);
  const r = await broken.agent.run();
  assert.equal(r.finalState, "CART_SUCCESS");
  assert.equal(broken.fake.prompts.length, 1, "un seul appel, uniquement à cause du sélecteur cassé");
  assert.equal(broken.adapter.calls.filter((c) => c.startsWith("selectOffer")).length, 2, "nouvel essai après réparation");
  for (const s of SECRETS) assert.ok(!broken.fake.prompts[0]!.includes(s));
});
