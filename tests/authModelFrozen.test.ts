import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTHORIZATION_MODEL, AUTOMATABLE, STATUSES, stateOf } from "../src/platforms/catalog.js";
import { NOW, catalogWith, daysAgo, ev, plat } from "./helpers/platformFixtures.js";

/** MODÈLE FIGÉ : cette table est écrite à la main ; la modifier est une décision majeure, pas un réglage. */
const FROZEN = {
  NOT_VERIFIED: { api: false, browser: false },
  API_ONLY: { api: true, browser: false },
  BROWSER_ONLY: { api: false, browser: true },
  API_AND_BROWSER: { api: true, browser: true },
  HUMAN_ONLY: { api: false, browser: false },
  EXPIRED: { api: false, browser: false },
  NOT_ALLOWED: { api: false, browser: false },
} as const;

test("modèle d'autorisation figé : 7 statuts, dans cet ordre, avec cette sémantique exacte", () => {
  assert.deepEqual([...STATUSES], ["NOT_VERIFIED", "API_ONLY", "BROWSER_ONLY", "API_AND_BROWSER", "HUMAN_ONLY", "EXPIRED", "NOT_ALLOWED"]);
  assert.deepEqual(JSON.parse(JSON.stringify(AUTHORIZATION_MODEL)), FROZEN);
  assert.deepEqual([...AUTOMATABLE], ["API_ONLY", "BROWSER_ONLY", "API_AND_BROWSER"]);
});

test("le modèle est IMMUABLE à l'exécution (objet gelé : aucune modification possible, même par erreur)", () => {
  assert.ok(Object.isFrozen(AUTHORIZATION_MODEL));
  for (const s of STATUSES) assert.ok(Object.isFrozen(AUTHORIZATION_MODEL[s]));
  assert.throws(() => {
    (AUTHORIZATION_MODEL as { API_ONLY: { browser: boolean } }).API_ONLY.browser = true;
  }, TypeError);
});

test("le calcul des statuts (stateOf) produit exactement la sémantique figée : canaux autorisés = table, pour chaque statut", () => {
  const src = (u: string) => ({ source: { url: u, title: "Page officielle (FICTIVE)" } });
  const cases: Record<keyof typeof FROZEN, ReturnType<typeof ev>[]> = {
    NOT_VERIFIED: [],
    API_ONLY: [ev("p", "api", daysAgo(2), src("https://developer.p.example/t"))],
    BROWSER_ONLY: [ev("p", "browser", daysAgo(2), src("https://www.p.example/t"))],
    API_AND_BROWSER: [ev("p", "api", daysAgo(2), src("https://developer.p.example/t")), ev("p", "browser", daysAgo(2), src("https://www.p.example/t"))],
    HUMAN_ONLY: [ev("p", "human")],
    EXPIRED: [ev("p", "both", daysAgo(181))],
    NOT_ALLOWED: [ev("p", "prohibited")],
  };
  for (const status of STATUSES) {
    const st = stateOf(catalogWith([plat("p")], cases[status]), "p", NOW);
    assert.equal(st.status, status);
    assert.equal(st.channels.includes("official-api"), FROZEN[status].api, `${status} / API`);
    assert.equal(st.channels.includes("browser"), FROZEN[status].browser, `${status} / navigateur`);
  }
});
