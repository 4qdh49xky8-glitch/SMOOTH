import type { EmailMessage, Mailer } from "../src/instant/emailNotify.js";

/** Notification locale simulée (tests) : enregistre les messages, n'ouvre AUCUNE connexion. */
export class MockMailer {
  readonly sent: EmailMessage[] = [];
  calls = 0;
  /** ok : succès immédiat ; fail : rejette ; slow : ne répond jamais avant `slowMs` ; hang : ne répond jamais. */
  constructor(public mode: "ok" | "fail" | "slow" | "hang" = "ok", private readonly slowMs = 500) {}
  readonly mailer: Mailer = async (m) => {
    this.calls++;
    if (this.mode === "fail") throw new Error("SMTP 421 indisponible (simulé)");
    if (this.mode === "hang") return new Promise<void>(() => undefined);
    if (this.mode === "slow") await new Promise((r) => setTimeout(r, this.slowMs));
    this.sent.push(m);
  };
}
