import { normalize } from "../agent/matcher.js";
import { assertCompliant } from "../sites/compliance.js";
import { checkAdapterContract } from "../sites/contract.js";
import { resolveChannel, type ChannelDecision } from "../agent/channels.js";
import { loadCatalog, findPlatform, type Catalog } from "../platforms/catalog.js";
import { discoverAdapters } from "../sites/registry.js";
import type { SiteAdapter } from "../sites/SiteAdapter.js";
import { basename } from "node:path";
import { ConfigSchema, type BotConfig } from "./schema.js";
import { readConfigFile, resolveConfigPath } from "./load.js";

export interface ValidationReport {
  file: string;
  profile: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
  info: string[];
  config?: BotConfig;
}

export interface ValidateOptions {
  now?: number;
  adapters?: SiteAdapter[];
  env?: NodeJS.ProcessEnv;
  catalog?: Catalog;
}

/**
 * Valide un fichier de configuration SANS contacter aucun site : schéma, existence et conformité de
 * l'adaptateur, cohérence entre la stratégie, les capacités du site et le mode d'exécution.
 */
export async function validateConfig(target: string, opts: ValidateOptions = {}): Promise<ValidationReport> {
  const now = opts.now ?? Date.now();
  const env = opts.env ?? process.env;
  const report: ValidationReport = { file: target, profile: basename(target, ".json"), ok: false, errors: [], warnings: [], info: [] };
  const { errors, warnings, info } = report;

  let raw: unknown;
  try {
    report.file = resolveConfigPath(target);
    report.profile = basename(report.file, ".json");
    raw = readConfigFile(report.file);
  } catch (e) {
    errors.push((e as Error).message);
    return report;
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    for (const i of parsed.error.issues) errors.push(`${i.path.join(".") || "(racine)"} : ${i.message}`);
    return report;
  }
  const cfg = parsed.data;
  report.config = cfg;

  // — Adaptateur
  const adapters = opts.adapters ?? (await discoverAdapters());
  const catalog = opts.catalog ?? loadCatalog();
  let decision: ChannelDecision | undefined;
  try {
    decision = resolveChannel({ platform: cfg.site, adapters, catalog, env, config: cfg, now });
  } catch (e) {
    errors.push((e as Error).message); // canal forcé indisponible
  }
  const known = adapters.some((a) => a.meta.id === cfg.site || (a.meta.platform ?? a.meta.id) === cfg.site) || findPlatform(catalog, cfg.site) !== undefined;
  if (decision) {
    info.push(`canal retenu : ${decision.channel}${decision.adapter ? ` (adaptateur « ${decision.adapter.meta.id} »)` : ""} — ${decision.reasons.join("; ")}`);
    for (const r of decision.rejected) info.push(`canal écarté : ${r.adapter} (${r.channel}) — ${r.reason}`);
  }
  if (decision?.channel === "human" && known) {
    warnings.push("canal humain : aucune automatisation n'est disponible/autorisée pour cette plateforme ; le bot se limitera à des rappels (aucun contact avec le site).");
  }
  const adapter = decision?.adapter;
  if (!known) {
    errors.push(`site « ${cfg.site} » : aucun adaptateur et absent du catalogue des plateformes. Adaptateurs : ${adapters.map((a) => a.meta.id).join(", ") || "(aucun)"}`);
  } else if (adapter) {
    const caps = adapter.meta.capabilities;
    let url: string | undefined;
    try {
      url = adapter.resolveEventUrl(cfg);
      assertCompliant(adapter.meta, url, now);
    } catch (e) {
      errors.push((e as Error).message);
    }
    for (const issue of checkAdapterContract(adapter, { now }).filter((i) => i.severity === "error" && i.code !== "COMPLIANCE")) {
      errors.push(`adaptateur « ${adapter.meta.id} » non conforme : ${issue.message}`);
    }
    for (const m of adapter.validateOptions?.(cfg.siteOptions) ?? []) errors.push(`siteOptions : ${m}`);

    if (caps.maxTicketsPerOrder !== undefined && cfg.tickets.quantity > caps.maxTicketsPerOrder)
      errors.push(`tickets.quantity (${cfg.tickets.quantity}) dépasse la limite d'achat du site (${caps.maxTicketsPerOrder}) : le bot ne contourne jamais les limites, il refusera de démarrer.`);
    if (cfg.tickets.seatsTogether && cfg.tickets.seatsTogetherStrict && !caps.reportsSeatAdjacency)
      warnings.push("seatsTogetherStrict=true mais ce site n'indique pas si les places sont côte à côte : aucune offre ne sera jamais retenue.");
    if (caps.seatSelection === "manual" && cfg.browser.headless) errors.push("ce site exige un choix de places manuel : browser.headless doit être false.");
    if (cfg.browser.headless && adapter.meta.compliance.policy !== "demo")
      warnings.push("browser.headless=true : impossible de céder la main à l'humain (file d'attente, CAPTCHA, connexion).");
    if (adapter.meta.compliance.policy !== "demo" && cfg.timing.pollIntervalMs < 400)
      warnings.push(`timing.pollIntervalMs=${cfg.timing.pollIntervalMs} ms : cadence agressive, vérifiez que le site l'autorise.`);
    info.push(`adaptateur « ${adapter.meta.displayName} » (${adapter.meta.compliance.policy}, CGU relues le ${adapter.meta.compliance.reviewedAt})`);
  }

  // — Calendrier
  const start = Date.parse(cfg.sale.startTime);
  const minutes = (start - now) / 60_000;
  if (minutes < 0) warnings.push(`sale.startTime est dans le passé (${Math.round(-minutes)} min) : le bot démarrerait immédiatement.`);
  else info.push(`ouverture de la vente dans ${minutes < 120 ? `${Math.round(minutes)} min` : `${(minutes / 60 / 24).toFixed(1)} jours`}`);
  if (cfg.event.date) {
    const ev = Date.parse(`${cfg.event.date}T23:59:59Z`);
    if (ev < now) warnings.push(`event.date (${cfg.event.date}) est passée.`);
    else if (ev < start) warnings.push("event.date précède l'ouverture de la vente : vérifiez les dates.");
  }

  // — Stratégie
  const cats = cfg.tickets.categories.map(normalize);
  if (new Set(cats).size !== cats.length) warnings.push("tickets.categories contient des doublons.");
  if (cats.length)
    for (const c of cfg.strategy.priorityCategories)
      if (!cats.includes(normalize(c))) warnings.push(`strategy.priorityCategories : « ${c} » n'est pas dans tickets.categories, elle ne sera jamais retenue.`);
  const p = cfg.strategy.placement;
  const overlap = p.preferSections.filter((s) => p.avoidSections.map(normalize).includes(normalize(s)));
  if (overlap.length) warnings.push(`strategy.placement : sections à la fois préférées et évitées : ${overlap.join(", ")}.`);
  if (cfg.strategy.priority.includes("seatsTogether") && !cfg.tickets.seatsTogether) info.push("critère seatsTogether ignoré (tickets.seatsTogether=false).");
  if (cfg.strategy.priority.includes("placement") && !p.preferSections.length && !p.avoidSections.length && p.rowPreference === "any")
    info.push("critère placement sans effet (aucune préférence de section ni de rang).");
  info.push(
    `sélection : max ${cfg.tickets.maxPricePerTicket} €/billet × ${cfg.tickets.quantity} = ${cfg.tickets.maxPricePerTicket * cfg.tickets.quantity} € ; ` +
      `catégories ${cfg.tickets.categories.length ? cfg.tickets.categories.join(" > ") : "toutes"} ; ordre ${cfg.strategy.priority.join(" > ")} ; prix ${cfg.strategy.priceOrder}`,
  );

  // — Divers
  if (cfg.claude.enabled && !env.ANTHROPIC_API_KEY) warnings.push("claude.enabled=true mais ANTHROPIC_API_KEY est absent : l'assistant sera désactivé.");
  if (!cfg.behavior.autoAddToCart) info.push("autoAddToCart=false : le bot sélectionnera l'offre puis vous laissera ajouter au panier.");
  if (!cfg.telemetry.enabled) info.push("télémétrie locale désactivée.");

  report.ok = errors.length === 0;
  return report;
}
