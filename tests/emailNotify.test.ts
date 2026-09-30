import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EmailConfigError, PAYMENT_LINE, assertSafeContent, buildEmail, createMailer, parseEmailConfig, readEmailConfig, sendBounded } from "../src/instant/emailNotify.js";
import { MockMailer } from "../testkit/mockMailer.js";
import { startFakeSmtp } from "./helpers/fakeSmtp.js";
import { saleInstantCommand } from "../src/cli/instant.js";

const ENV = { SMTP_USER_X: "utilisateur-smtp", SMTP_PASS_X: "S3cr3t-Pa55word-ZZ", MAIL_TOKEN_X: "tok_live_ABCDEF1234567890" } as NodeJS.ProcessEnv;
const good = { enabled: true, to: "moi@example.org", on: "CART_SUCCESS", provider: "smtp", from: "bot@example.org", smtp: { host: "smtp.example.org", port: 587, userEnv: "SMTP_USER_X", passEnv: "SMTP_PASS_X" } };
const INFO = { eventName: "Concert test", platform: "Plateforme test", eventDate: "2026-12-01", quantity: 2, category: "Cat A", totalPrice: 200, currency: "EUR", at: Date.UTC(2026, 9, 1, 8, 0, 0, 123) };

test("configuration e-mail : valide acceptée, désactivée = null, invalide REFUSÉE (messages sans valeur secrète)", () => {
  const c = parseEmailConfig(good, ENV)!;
  assert.equal(c.to, "moi@example.org");
  assert.equal(parseEmailConfig({ ...good, enabled: false }, ENV), null);
  assert.equal(parseEmailConfig(undefined, ENV), null);
  const bad: [string, unknown][] = [
    ["MON_EMAIL", { ...good, to: "MON_EMAIL" }],
    ["deux adresses", { ...good, to: "a@example.org,b@example.org" }],
    ["injection d'en-tête", { ...good, to: "a@example.org\nBcc: x@example.org" }],
    ["événement inconnu", { ...good, on: "PAYMENT" }],
    ["sans fournisseur", { ...good, provider: undefined }],
    ["sans expéditeur", { ...good, from: undefined }],
    ["smtp absent", { ...good, smtp: undefined }],
    ["secret en clair (valeur au lieu du nom)", { ...good, smtp: { host: "h", port: 25, userEnv: "u", passEnv: "MotDePasse123" } }],
    ["variable absente", { ...good, smtp: { host: "h", port: 25, userEnv: "NOPE_A", passEnv: "NOPE_B" } }],
    ["clé inconnue", { ...good, password: "x" }],
    ["api http", { enabled: true, to: "a@example.org", provider: "api", from: "b@example.org", api: { url: "http://x.example/send", tokenEnv: "MAIL_TOKEN_X" } }],
    ["api avec identifiants", { enabled: true, to: "a@example.org", provider: "api", from: "b@example.org", api: { url: "https://u:p@x.example/send", tokenEnv: "MAIL_TOKEN_X" } }],
    ["api avec requête", { enabled: true, to: "a@example.org", provider: "api", from: "b@example.org", api: { url: "https://x.example/send?key=1", tokenEnv: "MAIL_TOKEN_X" } }],
    ["les deux fournisseurs", { ...good, api: { url: "https://x.example/s", tokenEnv: "MAIL_TOKEN_X" } }],
  ];
  for (const [name, cfg] of bad) {
    assert.throws(() => parseEmailConfig(cfg, ENV), (e: unknown) => {
      assert.ok(e instanceof EmailConfigError, name);
      for (const v of Object.values(ENV)) assert.ok(!(e as Error).message.includes(v!), `${name} : le message cite un secret`);
      return true;
    }, name);
  }
  assert.ok(parseEmailConfig({ enabled: true, to: "a@example.org", provider: "api", from: "b@example.org", api: { url: "https://api.mail.example/v1/send", tokenEnv: "MAIL_TOKEN_X" } }, ENV));
});

test("fichier : notifications.email lu (YAML, JSON, advanced.notifications) ; sale:instant refuse une configuration e-mail invalide avant toute attente", async () => {
  const d = mkdtempSync(join(tmpdir(), "email-cfg-"));
  const y = join(d, "a.yaml");
  writeFileSync(y, `site: example\nnotifications:\n  desktop: false\n  email:\n    enabled: true\n    to: "moi@example.org"\n    on: "CART_SUCCESS"\n    provider: smtp\n    from: "bot@example.org"\n    smtp: { host: "smtp.example.org", userEnv: SMTP_USER_X, passEnv: SMTP_PASS_X }\n`);
  assert.equal(readEmailConfig(y, ENV)!.provider, "smtp");
  const j = join(d, "b.json");
  writeFileSync(j, JSON.stringify({ advanced: { notifications: { email: good } } }));
  assert.equal(readEmailConfig(j, ENV)!.to, "moi@example.org");
  const inv = join(d, "c.yaml");
  writeFileSync(inv, `site: example\nnotifications:\n  email:\n    enabled: true\n    to: "MON_EMAIL"\n    on: "CART_SUCCESS"\n`);
  const lines: string[] = [];
  const code = await saleInstantCommand({ target: inv } as never, { wait: { print: (l: string) => void lines.push(l) } as never });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /Configuration e-mail invalide[\s\S]*Refusé/);
});

test("contenu : uniquement les champs prévus ; AUCUN secret, cookie, jeton, URL, carte, CVV, session", () => {
  const m = buildEmail({ from: "bot@example.org", to: "moi@example.org" }, INFO, ENV);
  assert.equal(m.text, ["CART_SUCCESS", "", "Événement : Concert test", "Plateforme : Plateforme test", "Date de l'événement : 2026-12-01", "Quantité : 2", "Catégorie / section : Cat A", "Prix total : 200 EUR", "Heure du CART_SUCCESS : 2026-10-01T08:00:00.123Z", "", PAYMENT_LINE].join("\n"));
  // champs optionnels absents → lignes omises
  const min = buildEmail({ from: "bot@example.org", to: "moi@example.org" }, { eventName: "E", platform: "P", at: 0 }, ENV);
  assert.ok(!/Quantité|Catégorie|Prix|Date de l'événement/.test(min.text));
  // un nom d'événement piégé est assaini ou l'envoi est refusé
  const hostile = { ...INFO, eventName: "Concert https://user:pw@x.example/p?token=abcdef1234567890 Cookie: sid=123456789012345678 4111 1111 1111 1111 cvv 123\r\nBcc: x@example.org" };
  let body: string | undefined;
  try {
    const h = buildEmail({ from: "bot@example.org", to: "moi@example.org" }, hostile, ENV);
    body = h.text + h.subject;
    assert.ok(!/\r|\n.*Bcc:/.test(h.subject), "pas d'injection d'en-tête");
  } catch (e) {
    assert.match((e as Error).message, /CONTENT_REJECTED/);
  }
  if (body) for (const re of [/https?:/i, /4111/, /cookie/i, /cvv/i, /token/i, /user:pw/, /sid=/i]) assert.ok(!re.test(body), String(re));
  // valeur secrète de l'environnement dans un champ : refusé
  try {
    const leaked = buildEmail({ from: "a@example.org", to: "b@example.org" }, { ...INFO, category: ENV.SMTP_PASS_X! }, ENV);
    assert.ok(!leaked.text.includes(ENV.SMTP_PASS_X!) && !leaked.subject.includes(ENV.SMTP_PASS_X!), "valeur secrète masquée");
  } catch (e) {
    assert.match((e as Error).message, /CONTENT_REJECTED/);
  }
  assert.throws(() => assertSafeContent(`x ${ENV.SMTP_PASS_X}`, ENV), /CONTENT_REJECTED/, "le garde final refuse une valeur secrète connue");
  for (const bad of ["Authorization: Bearer abc", "Cookie: a=b", "cvc 123", "https://x.example/?a=1", "4111 1111 1111 1111", "password=1"]) assert.throws(() => assertSafeContent(bad, ENV), /CONTENT_REJECTED/, bad);
});

test("transport SMTP réel vers un FAUX serveur en boucle locale : message émis sans secret ; le mot de passe n'est ni dans le message ni dans les journaux", async () => {
  const smtp = await startFakeSmtp();
  try {
    const env = { ...ENV };
    const cfg = parseEmailConfig({ ...good, smtp: { host: "127.0.0.1", port: smtp.port, secure: false, userEnv: "SMTP_USER_X", passEnv: "SMTP_PASS_X" } }, env)!;
    const msg = buildEmail(cfg, INFO, env);
    const out = await sendBounded(createMailer(cfg, env, 3000), msg, 5000);
    assert.equal(out, "SENT");
    assert.equal(smtp.messages.length, 1);
    const raw = smtp.messages[0]!.raw;
    assert.match(raw, /CART_SUCCESS/);
    assert.match(raw, /PAYMENT REQUIRED/);
    for (const v of Object.values(env)) assert.ok(!raw.includes(v!), "aucun secret dans le message");
    assert.ok(!/authorization|cookie|set-cookie|cvv|cvc|bearer/i.test(raw), "aucun en-tête sensible");
    assert.ok(smtp.messages[0]!.auth, "l'authentification a bien eu lieu (canal séparé du message)");
  } finally {
    await smtp.close();
  }
});

test("échec SMTP réel (port fermé) : FAILED sans exception et sans détail ; délai borné", async () => {
  const cfg = parseEmailConfig({ ...good, smtp: { host: "127.0.0.1", port: 9, secure: false } }, ENV)!;
  const msg = buildEmail(cfg, INFO, ENV);
  assert.equal(await sendBounded(createMailer(cfg, ENV, 1000), msg, 2000), "FAILED");
  const t = Date.now();
  assert.equal(await sendBounded(new MockMailer("hang").mailer, msg, 300), "FAILED");
  assert.ok(Date.now() - t < 1000);
});
