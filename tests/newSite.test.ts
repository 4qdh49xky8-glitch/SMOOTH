import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { planNewSite, renderNewSite, toCamel, toPascal } from "../scripts/new-site.js";
import { checkAdapterContract, scanSource } from "../src/sites/contract.js";
import type { SiteAdapter } from "../src/sites/SiteAdapter.js";
import { NOW, TODAY, catalogWith, daysAgo, ev, plat } from "./helpers/platformFixtures.js";

const SRC = resolve("src");
/** Écrit les fichiers générés dans un dossier temporaire (imports vers le vrai src/ réécrits) et importe l'adaptateur. */
async function materialize(files: Record<string, string>, id: string): Promise<{ adapter: SiteAdapter; file: string }> {
  const root = mkdtempSync(join(tmpdir(), "gen-"));
  let adapterFile = "";
  for (const [path, content] of Object.entries(files)) {
    if (!path.startsWith("src/")) continue;
    const out = join(root, path);
    mkdirSync(dirname(out), { recursive: true });
    const fixed = content
      .replace(/from "\.\/(BaseSiteAdapter|SiteAdapter)\.js"/g, `from "${SRC}/sites/$1.js"`)
      .replace(/from "\.\.\/sites\/SiteAdapter\.js"/g, `from "${SRC}/sites/SiteAdapter.js"`)
      .replace(/from "\.\.\/api\/(\w+)\.js"/g, `from "${SRC}/api/$1.js"`);
    writeFileSync(out, fixed);
    if (path.startsWith("src/sites/")) adapterFile = out;
  }
  const mod = (await import(pathToFileURL(adapterFile).href)) as { default: new () => SiteAdapter };
  void id;
  return { adapter: new mod.default(), file: adapterFile };
}
const errorCodes = (a: SiteAdapter, file: string, cat: ReturnType<typeof catalogWith>): string[] =>
  checkAdapterContract(a, { sourceFile: file, catalog: cat, now: NOW }).filter((i) => i.severity === "error").map((i) => i.code);

test("plateforme NOT_VERIFIED / EXPIRED / absente : squelette EXPLICITEMENT marqué NOT_VERIFIED, refusé par le contrat", async () => {
  const cases: [string, ReturnType<typeof catalogWith>, string][] = [
    ["NOT_VERIFIED", catalogWith([plat("mon-site")]), "NOT_VERIFIED"],
    ["EXPIRED", catalogWith([plat("mon-site")], [ev("mon-site", "browser", daysAgo(181))]), "EXPIRED"],
    ["absente", catalogWith([]), "ABSENT_DU_CATALOGUE"],
  ];
  for (const [label, cat, status] of cases) {
    const plan = planNewSite(cat, "mon-site", "Mon Site", { now: NOW });
    assert.equal(plan.kind, "skeleton", label);
    if (plan.kind !== "skeleton") continue;
    assert.equal(plan.verified, false, label);
    assert.equal(plan.status, status);
    const src = plan.files["src/sites/MonSite.ts"]!;
    assert.match(src, /@skeleton-status NOT_VERIFIED/, `${label} : marqueur explicite`);
    assert.match(src, /NON EXÉCUTABLE/);
    assert.match(src, /TODO\(COMPLIANCE\)/);
    assert.equal(scanSource(src).length, 0);
    const { adapter, file } = await materialize(plan.files, "mon-site");
    const codes = errorCodes(adapter, file, cat);
    assert.ok(codes.includes("SKELETON_NOT_VERIFIED"), `${label} : ${codes.join(",")}`);
    assert.ok(codes.includes("PLATFORM_AUTH") && codes.includes("COMPLIANCE"), `${label} : non autorisé ET non conforme`);
    assert.match(plan.files["tests/mon-site.test.ts"]!, /squelette NOT_VERIFIED/);
  }
});

test("plateforme VERIFIED_BROWSER : squelette navigateur UTILISABLE — autorisation, canal et preuve pré-remplis, contrat satisfait", async () => {
  const cat = catalogWith([plat("mon-site")], [ev("mon-site", "browser", daysAgo(5), { authorization: 'Les CGU "autorisent" l\'automatisation.' })]);
  const plan = planNewSite(cat, "mon-site", "Mon Site", { now: NOW });
  assert.equal(plan.kind, "skeleton");
  if (plan.kind !== "skeleton") return;
  assert.equal(plan.verified, true);
  assert.equal(plan.status, "VERIFIED_BROWSER");
  const src = plan.files["src/sites/MonSite.ts"]!;
  assert.match(src, /@skeleton-status VERIFIED/);
  assert.doesNotMatch(src, /TODO\(COMPLIANCE\)/);
  assert.match(src, /policy: "permitted-by-terms"/);
  assert.match(src, /termsUrl: "https:\/\/www\.mon-site\.example\/conditions"/);
  assert.ok(src.includes(`reviewedAt: "${daysAgo(5)}"`));
  assert.match(src, /channel: "browser"/);
  assert.ok("src/selectors/mon-site.ts" in plan.files);
  const { adapter, file } = await materialize(plan.files, "mon-site");
  assert.deepEqual(errorCodes(adapter, file, cat), [], "le squelette vérifié passe le contrat");
  assert.match(plan.notes[0]!, /preuve du/);
});

test("plateforme VERIFIED_API : squelette API (BaseApiAdapter, sans navigateur, secret par variable d'environnement, pas de paiement)", async () => {
  const cat = catalogWith([plat("mon-site")], [ev("mon-site", "api", daysAgo(5))]);
  const plan = planNewSite(cat, "mon-site", "Mon Site", { now: NOW });
  assert.equal(plan.kind, "skeleton");
  if (plan.kind !== "skeleton") return;
  assert.equal(plan.status, "VERIFIED_API");
  const src = plan.files["src/sites/MonSite.ts"]!;
  assert.match(src, /extends BaseApiAdapter/);
  assert.match(src, /channel: "official-api"/);
  assert.match(src, /requires: \{ env: \["MON_SITE_API_KEY"\] \}/);
  assert.match(src, /policy: "official-api"/);
  assert.ok(!("src/selectors/mon-site.ts" in plan.files), "pas de sélecteurs : aucun navigateur");
  assert.ok(!/\bpay|checkout|purchase/i.test(src.replace(/JAMAIS un paiement|Jamais un paiement|jamais un paiement/g, "")), "aucune méthode de paiement");
  const { adapter, file } = await materialize(plan.files, "mon-site");
  assert.deepEqual(errorCodes(adapter, file, cat), []);
});

test("canal demandé non autorisé, ou plateforme NOT_ALLOWED : AUCUN fichier n'est créé", () => {
  const onlyApi = catalogWith([plat("mon-site")], [ev("mon-site", "api", daysAgo(5))]);
  const p1 = planNewSite(onlyApi, "mon-site", "Mon Site", { channel: "browser", now: NOW });
  assert.equal(p1.kind, "refused");
  assert.match((p1 as { message: string }).message, /canal « browser » n'est pas autorisé/);
  const notAllowed = catalogWith([plat("mon-site")], [ev("mon-site", "human", daysAgo(5))]);
  const p2 = planNewSite(notAllowed, "mon-site", "Mon Site", { now: NOW });
  assert.equal(p2.kind, "refused");
  assert.match((p2 as { message: string }).message, /NOT_ALLOWED[\s\S]*rien n'a été créé/);
  const both = catalogWith([plat("mon-site")], [ev("mon-site", "both", daysAgo(5))]);
  assert.equal((planNewSite(both, "mon-site", "Mon Site", { channel: "api", now: NOW }) as { status: string }).status, "VERIFIED_API_AND_BROWSER");
  assert.match((planNewSite(both, "mon-site", "Mon Site", { now: NOW }) as { files: Record<string, string> }).files["src/sites/MonSite.ts"]!, /extends BaseApiAdapter/, "sans --channel : l'API d'abord");
  assert.match((planNewSite(both, "mon-site", "Mon Site", { channel: "browser", now: NOW }) as { files: Record<string, string> }).files["src/sites/MonSite.ts"]!, /extends BaseSiteAdapter/);
});

test("--platform relie un adaptateur à une plateforme du catalogue ; identifiant invalide refusé ; nom assaini", () => {
  const cat = catalogWith([plat("fnac")], [ev("fnac", "browser", daysAgo(2))]);
  const plan = planNewSite(cat, "fnac-web", "Fnac Web", { platform: "fnac", now: NOW });
  assert.equal(plan.kind, "skeleton");
  assert.match((plan as { files: Record<string, string> }).files["src/sites/FnacWeb.ts"]!, /platform: "fnac"/);
  assert.throws(() => planNewSite(cat, "Mon Site", "x"), /minuscules/);
  assert.throws(() => renderNewSite("../evil", "x"), /minuscules/);
  assert.ok(!renderNewSite("ok", 'a"; process.exit(1); //')["src/sites/Ok.ts"]!.includes('"; process.exit'));
  assert.equal(toPascal("see-tickets"), "SeeTickets");
  assert.equal(toCamel("axs"), "axs");
  void TODAY;
});

test("npm run new-site -- : sans argument → aide ; plateforme absente en --dry-run → NOT_VERIFIED, aucun fichier écrit", () => {
  const bare = spawnSync("npx", ["tsx", "scripts/new-site.ts"], { encoding: "utf8" });
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /Usage : npm run new-site/);
  const dry = spawnSync("npx", ["tsx", "scripts/new-site.ts", "zz-absent-test", "Site absent", "--dry-run"], { encoding: "utf8" });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Statut : ABSENT_DU_CATALOGUE — squelette NOT_VERIFIED \(non exécutable\)/);
  assert.match(dry.stdout, /\(simulation\)/);
  assert.equal(existsSync("src/sites/ZzAbsentTest.ts"), false);
});
