import { normalize } from "../agent/matcher.js";
import { resolveChannel, type ChannelDecision } from "../agent/channels.js";
import { profileName, readConfigFile, resolveConfigPath } from "../config/load.js";
import type { BotConfig } from "../config/schema.js";
import { validateConfig } from "../config/validate.js";
import { assertNetworkAllowed } from "../platforms/authorize.js";
import { loadCatalog, stateOf, type Catalog, type PlatformStatus } from "../platforms/catalog.js";
import { defaultUserDataDir } from "../browser/launch.js";
import { discoverAdapters } from "../sites/registry.js";
import type { SiteAdapter } from "../sites/SiteAdapter.js";
import { eventKey, inspectLock, profileKey } from "../utils/lock.js";
import { convertSaleProfile, isSaleProfile, readStructuredFile } from "./profile.js";

/**
 * « READY FOR SALE » : évalue, SANS AUCUN ACCÈS RÉSEAU, si une vente peut être lancée automatiquement. Ne réserve rien (les verrous
 * sont seulement LUS). READY exige qu'un canal automatisé soit explicitement autorisé par des preuves officielles valides ; sinon
 * NOT_READY avec la raison exacte — jamais de lancement automatique sans autorisation.
 */
export type CheckStatus = "ok" | "fail" | "warn" | "info";
export interface SaleCheck {
  id: "config" | "time" | "timezone" | "adapter" | "authorization" | "channel" | "hosts" | "lock" | "selection" | "budget" | "quantity" | "behavior";
  label: string;
  status: CheckStatus;
  message: string;
}

export interface SaleAssessment {
  verdict: "READY" | "NOT_READY";
  /** automatic : canal API/navigateur autorisé · human : rappels seulement (aucune requête) · none : rien de lançable. */
  mode: "automatic" | "human" | "none";
  platform?: string;
  platformStatus?: PlatformStatus | "TEST_ONLY";
  channel?: ChannelDecision["channel"];
  adapter?: string;
  startsAt?: string;
  startEpochMs?: number;
  event?: string;
  checks: SaleCheck[];
  /** Raisons exactes du NOT_READY (vide si READY). */
  reasons: string[];
  config?: BotConfig;
}

export interface AssessOptions {
  now?: number;
  adapters?: SiteAdapter[];
  catalog?: Catalog;
  env?: NodeJS.ProcessEnv;
  locksDir?: string;
  /** Mode humain explicite (`sale:wait --human`) : rappels seulement, aucun automatisme, aucune requête. */
  human?: boolean;
}

const DAY = 86_400_000;
const fmtMin = (ms: number): string => (ms < 2 * 3_600_000 ? `${Math.round(ms / 60_000)} min` : ms < 2 * DAY ? `${(ms / 3_600_000).toFixed(1)} h` : `${(ms / DAY).toFixed(1)} jours`);

export async function assessSale(target: string, opts: AssessOptions = {}): Promise<SaleAssessment> {
  const now = opts.now ?? Date.now();
  const env = opts.env ?? process.env;
  const checks: SaleCheck[] = [];
  const add = (id: SaleCheck["id"], label: string, status: CheckStatus, message: string): void => void checks.push({ id, label, status, message });
  const finish = (extra: Partial<SaleAssessment> = {}): SaleAssessment => {
    const reasons = [...new Set(checks.filter((c) => c.status === "fail").map((c) => `${c.label} : ${c.message}`))];
    return { verdict: reasons.length ? "NOT_READY" : "READY", mode: "none", checks, reasons, ...extra };
  };

  // ── 1. configuration (schéma, adaptateur, contrat, options)
  const adapters = opts.adapters ?? (await discoverAdapters());
  const catalog = opts.catalog ?? loadCatalog();
  const report = await validateConfig(target, { now, adapters, catalog, env });
  if (!report.config) {
    for (const e of report.errors) add("config", "Configuration", "fail", e);
    return finish();
  }
  let cfg: BotConfig = report.config;
  if (opts.human) cfg = { ...cfg, channel: "human" };
  if (report.errors.length) for (const e of report.errors) add("config", "Configuration", "fail", e);
  else add("config", "Configuration", "ok", `valide (${report.file})`);
  const base = { platform: cfg.site, event: cfg.event.name, startsAt: cfg.sale.startTime, startEpochMs: Date.parse(cfg.sale.startTime), config: cfg };

  // ── 2. date / heure / fuseau
  const start = base.startEpochMs;
  let tz: string | undefined;
  let tzNote = "décalage explicite dans sale.startTime";
  try {
    const raw = readStructuredFile(resolveConfigPath(target));
    if (isSaleProfile(raw)) {
      const conv = convertSaleProfile(raw);
      tz = conv.start?.timezone;
      tzNote = tz ? `${tz} (${conv.start?.offset})` : "décalage explicite dans sale.startTime";
    }
  } catch {
    /* lecture déjà validée plus haut */
  }
  if (Number.isNaN(start)) add("time", "Date d'ouverture", "fail", `sale.startTime « ${cfg.sale.startTime} » illisible`);
  else {
    const untilMs = start - now;
    const windowEnd = start + cfg.timing.maxWaitAfterSaleSeconds * 1000;
    if (now > windowEnd) add("time", "Date d'ouverture", "fail", `la vente a ouvert le ${cfg.sale.startTime} et la fenêtre de surveillance (${cfg.timing.maxWaitAfterSaleSeconds} s) est terminée`);
    else if (untilMs < 0) add("time", "Date d'ouverture", "warn", `la vente est déjà ouverte (${cfg.sale.startTime}) : le bot démarrerait immédiatement`);
    else add("time", "Date d'ouverture", "ok", `${cfg.sale.startTime} — dans ${fmtMin(untilMs)} (préparation ${cfg.timing.preArmSeconds} s avant)`);
    add("timezone", "Fuseau horaire", "ok", tzNote);
  }
  if (cfg.event.date) {
    const ev = Date.parse(`${cfg.event.date}T23:59:59Z`);
    if (ev < now) add("time", "Date de l'événement", "warn", `event.date ${cfg.event.date} est passée`);
  }

  // ── 3. adaptateur, autorisation, canal
  let decision: ChannelDecision | undefined;
  try {
    decision = resolveChannel({ platform: cfg.site, adapters, catalog, env, config: cfg, now });
  } catch (e) {
    add("authorization", "Autorisation", "fail", (e as Error).message);
  }
  const adapter = decision?.adapter;
  const platformState = catalog.platforms.some((p) => p.id === cfg.site) ? stateOf(catalog, cfg.site, now) : undefined;
  const testOnly = adapter?.meta.testOnly === true;
  const candidates = adapters.filter((a) => (a.meta.platform ?? a.meta.id) === cfg.site || a.meta.id === cfg.site);
  if (candidates.length === 0) add("adapter", "Adaptateur", "fail", `aucun adaptateur pour « ${cfg.site} »${platformState ? " (plateforme du catalogue, mais aucun adaptateur)" : " et plateforme absente du catalogue"}`);
  else add("adapter", "Adaptateur", adapter ? "ok" : "info", adapter ? `« ${adapter.meta.id} » (${adapter.meta.displayName})` : `présent (${candidates.map((a) => a.meta.id).join(", ")}) mais non retenu`);
  const platformStatus: SaleAssessment["platformStatus"] = testOnly ? "TEST_ONLY" : platformState?.status;

  if (decision) {
    if (decision.channel === "human") {
      if (opts.human) add("authorization", "Autorisation", "info", "mode humain demandé : aucun automatisme, rappels seulement (aucune requête vers la plateforme)");
      else {
        const why = platformState ? `statut ${platformState.status} — ${platformState.reasons.join("; ")}` : "plateforme absente du catalogue (aucune preuve officielle)";
        const extra = decision.rejected.length ? ` ; canaux écartés : ${decision.rejected.map((r) => `${r.adapter} (${r.channel}) : ${r.reason}`).join(" | ")}` : "";
        add("authorization", "Autorisation", "fail", `aucune automatisation autorisée pour « ${cfg.site} » : ${why}${extra}. Lancement automatique REFUSÉ (mode humain possible : sale:wait --human)`);
      }
    } else if (testOnly) {
      add("authorization", "Autorisation", "warn", `adaptateur de test TEST_ONLY · NOT_A_REAL_PLATFORM (limité à localhost) : aucune preuve requise, aucune plateforme réelle`);
    } else {
      add("authorization", "Autorisation", "ok", `statut ${platformState?.status} — ${platformState?.reasons.join("; ")}`);
      if (platformState?.expiresAt) {
        const validUntil = Date.parse(platformState.expiresAt) + DAY; // la preuve vaut jusqu'à la fin de ce jour (UTC)
        const windowEnd = start + cfg.timing.maxWaitAfterSaleSeconds * 1000;
        if (!Number.isNaN(windowEnd) && validUntil < windowEnd) add("authorization", "Expiration de la preuve", "fail", `la preuve expire le ${platformState.expiresAt}, avant la fin de la fenêtre de la vente (${new Date(windowEnd).toISOString()}) : reconsultez la source officielle (npm run platform verify ${cfg.site})`);
        else add("authorization", "Expiration de la preuve", (platformState.expiresInDays ?? 999) <= 30 ? "warn" : "info", `valide jusqu'au ${platformState.expiresAt} (${platformState.expiresInDays} jours)`);
      }
    }
    add("channel", "Canal", decision.channel === "human" ? (opts.human ? "info" : "fail") : "ok", `${decision.channel} — ${decision.reasons.join("; ")}${cfg.channel !== "auto" ? ` (restriction de configuration : ${cfg.channel})` : ""}`);
  }

  // ── 4. hôtes autorisés
  if (adapter) {
    try {
      assertNetworkAllowed(adapter, cfg, catalog);
      const hosts = [...new Set([new URL(adapter.resolveEventUrl(cfg)).hostname, ...adapter.allowedHosts(cfg)])];
      add("hosts", "Hôtes autorisés", "ok", hosts.join(", "));
    } catch (e) {
      add("hosts", "Hôtes autorisés", "fail", (e as Error).message);
    }

    // ── 5. verrous (lecture seule)
    try {
      const url = adapter.resolveEventUrl(cfg);
      const keys: [string, string][] = [[eventKey(adapter.meta.id, url), "événement"]];
      if (decision?.channel === "browser") keys.push([profileKey(cfg.browser.userDataDir ?? defaultUserDataDir(profileName(report.file))), "profil de navigateur"]);
      const problems: string[] = [];
      for (const [key, what] of keys) {
        const l = inspectLock(key, opts.locksDir, now);
        if (l.state === "held") problems.push(`verrou ${what} détenu par « ${l.owner?.instance} » (PID ${l.owner?.pid}, depuis ${l.owner?.startedAt})`);
        else if (l.state === "stale") add("lock", "Verrou", "info", `verrou ${what} périmé : sera récupéré au lancement`);
      }
      if (problems.length) add("lock", "Verrou", "fail", `${problems.join(" ; ")} — un seul bot par événement et par profil`);
      else add("lock", "Verrou", "ok", "libre (événement et profil)");
    } catch (e) {
      add("lock", "Verrou", "fail", (e as Error).message);
    }
  }

  // ── 6. critères de sélection, budget, quantité, comportement
  const t = cfg.tickets;
  const cats = t.categories.map(normalize);
  const dup = cats.filter((c, i) => cats.indexOf(c) !== i);
  const p = cfg.strategy.placement;
  const overlapS = p.preferSections.filter((s) => p.avoidSections.map(normalize).includes(normalize(s)));
  const overlapR = p.preferRows.filter((s) => p.avoidRows.map(normalize).includes(normalize(s)));
  const prefExcluded = p.preferSections.filter((s) => p.excludeSections.map(normalize).includes(normalize(s)));
  const sel: string[] = [];
  let selStatus: CheckStatus = "ok";
  if (dup.length) { selStatus = "warn"; sel.push(`catégories en double : ${dup.join(", ")}`); }
  if (overlapS.length) { selStatus = "warn"; sel.push(`sections à la fois préférées et évitées : ${overlapS.join(", ")}`); }
  if (overlapR.length) { selStatus = "warn"; sel.push(`rangées à la fois préférées et évitées : ${overlapR.join(", ")}`); }
  if (prefExcluded.length) { selStatus = "warn"; sel.push(`sections préférées mais exclues : ${prefExcluded.join(", ")}`); }
  if (adapter && t.seatsTogether && t.seatsTogetherStrict && !adapter.capabilities.reportsSeatAdjacency) {
    selStatus = "fail";
    sel.push("strictTogether=true mais la plateforme n'indique pas si les places sont côte à côte : aucune offre ne serait jamais retenue");
  }
  add("selection", "Critères de sélection", selStatus, sel.length ? sel.join(" ; ") : `ordre ${cfg.strategy.priority.join(" > ")}, prix ${cfg.strategy.priceOrder} ; catégories ${t.categories.length ? t.categories.join(" > ") : "toutes"} ; places ensemble ${t.seatsTogether ? (t.seatsTogetherStrict ? "STRICT" : "préférées") : "indifférent"}`);
  if (!Number.isFinite(t.maxPricePerTicket) || t.maxPricePerTicket <= 0) add("budget", "Budget", "fail", "budget maximum par billet manquant ou invalide");
  else add("budget", "Budget", "ok", `max ${t.maxPricePerTicket} €/billet × ${t.quantity} = ${Math.round(t.maxPricePerTicket * t.quantity * 100) / 100} € (contrainte dure)`);
  const cap = adapter?.capabilities.maxTicketsPerOrder;
  if (!Number.isInteger(t.quantity) || t.quantity < 1 || t.quantity > 10) add("quantity", "Quantité", "fail", `${t.quantity} hors de 1–10`);
  else if (cap !== undefined && t.quantity > cap) add("quantity", "Quantité", "fail", `${t.quantity} dépasse la limite d'achat de la plateforme (${cap}) : le bot ne contourne pas les limites`);
  else add("quantity", "Quantité", "ok", `${t.quantity} billet(s)${cap !== undefined ? ` (limite de la plateforme : ${cap})` : ""}`);
  add("behavior", "Comportement", cfg.behavior.autoAddToCart ? "ok" : "warn", `${cfg.behavior.autoAddToCart ? "ajout au panier automatique" : "sélection seulement (ajout au panier manuel)"} ; paiement TOUJOURS manuel`);

  const mode: SaleAssessment["mode"] = decision?.channel === "human" ? (opts.human ? "human" : "none") : decision ? "automatic" : "none";
  return finish({ ...base, mode, channel: decision?.channel, adapter: adapter?.meta.id, platformStatus });
}

const ICON: Record<CheckStatus, string> = { ok: "✓", fail: "✗", warn: "⚠", info: "·" };

/** Rapport lisible : une ligne par contrôle, puis READY ou NOT_READY avec la raison exacte. */
export function formatAssessment(a: SaleAssessment): string {
  const lines = [`SALE CHECK — ${a.event ?? "(configuration illisible)"}${a.platform ? ` · plateforme « ${a.platform} »` : ""}`, ""];
  for (const c of a.checks) lines.push(`  ${ICON[c.status]} ${c.label.padEnd(24)} ${c.message}`);
  lines.push("");
  lines.push(a.verdict === "READY" ? `READY${a.mode === "human" ? " (mode humain : rappels seulement)" : ` — canal ${a.channel}${a.platformStatus ? `, statut ${a.platformStatus}` : ""}`}` : "NOT_READY");
  for (const r of a.reasons) lines.push(`  ✗ ${r}`);
  lines.push("Aucune requête réseau n'a été émise (contrôle local). Le paiement reste toujours manuel.");
  return lines.join("\n");
}
