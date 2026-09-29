/**
 * Test de bout en bout : site local + bot réel (Chromium/CDP), sans aucun service externe.
 *   npm run demo                 → scénario nominal + contention (repli sur l'offre suivante)
 *   npm run demo -- --queue      → ajoute une salle d'attente factice : le bot passe la main (headless : échec attendu, voir README)
 *   npm run demo -- --headed     → fenêtre visible
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDemoServer } from "../demo/server.js";

const headed = process.argv.includes("--headed");
const openInSec = 8;
const openAt = Math.ceil((Date.now() + openInSec * 1000) / 1000) * 1000;
const demo = await startDemoServer({ openAt, contention: true });

const dir = mkdtempSync(join(tmpdir(), "ticket-demo-"));
const configPath = join(dir, "event.json");
writeFileSync(
  configPath,
  JSON.stringify({
    site: "example",
    event: { name: "Concert démo", date: "2026-12-01", url: `${demo.url}/event` },
    sale: { startTime: new Date(openAt).toISOString() },
    tickets: { quantity: 2, maxPricePerTicket: 150, categories: ["Catégorie 1", "Catégorie 2", "Catégorie 3"], seatsTogether: true },
    behavior: { autoAddToCart: true, autoPayment: false },
    timing: { preArmSeconds: 5 },
    browser: { headless: !headed, userDataDir: join(dir, "profile"), debugPort: 9333 },
  }),
);

process.env.EXAMPLE_EMAIL = "demo@example.com";
process.env.EXAMPLE_PASSWORD = "demo";

console.log(`Site démo ${demo.url} — ouverture dans ~${openInSec}s\n`);
const { main } = await import("../src/index.js");
await main(["run", "--config", configPath, "--exit-when-done", "--trace"]);
const cart = demo.state.cart;
const expected = cart.length === 1 && cart[0]!.offerId === "o6" && cart[0]!.quantity === 2 && demo.state.addAttempts === 2;
console.log(`\nÉtat du panier côté serveur : ${JSON.stringify(cart)} (tentatives d'ajout : ${demo.state.addAttempts})`);
console.log(expected ? "✅ DÉMO OK : repli sur la catégorie 3 côte à côte après contention." : "❌ DÉMO KO");
await demo.close();
process.exit(expected ? 0 : 1);
