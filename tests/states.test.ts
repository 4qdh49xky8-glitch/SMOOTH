import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTO_DETECTABLE, State, STATE_DESCRIPTIONS } from "../src/agent/states.js";

test("les 10 états standardisés existent, exactement", () => {
  assert.deepEqual(
    Object.keys(State).sort(),
    ["AVAILABLE", "BLOCKED", "CAPTCHA", "CART_SUCCESS", "ERROR", "LOGIN_REQUIRED", "MANUAL_SELECTION", "PURCHASE_LIMIT", "QUEUE", "SOLD_OUT"],
  );
  for (const [k, v] of Object.entries(State)) assert.equal(k, v);
  for (const s of Object.values(State)) assert.ok(STATE_DESCRIPTIONS[s].length > 0);
});

test("seuls file d'attente, CAPTCHA et blocage sont détectables automatiquement ; connexion/plan/limite attendent l'humain ou arrêtent", () => {
  assert.deepEqual([...AUTO_DETECTABLE].sort(), ["BLOCKED", "CAPTCHA", "QUEUE"]);
});
