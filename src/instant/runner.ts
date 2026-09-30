import { Agent, type RunResult } from "../agent/Agent.js";
import { resolveChannel } from "../agent/channels.js";
import { ClaudeAssistant, type MessagesClient } from "../agent/claude.js";
import type { Blocker } from "../sites/SiteAdapter.js";
import { createApiContext } from "../api/BaseApiAdapter.js";
import { installNetworkGuards } from "../browser/guards.js";
import { tuneNetwork } from "../browser/cdp.js";
import { defaultUserDataDir, openBrowser, type BrowserSession } from "../browser/launch.js";
import type { LiveDeps } from "../cli/live.js";
import { loadConfig, profileName, resolveConfigPath } from "../config/load.js";
import type { BotConfig } from "../config/schema.js";
import { assertAuthorized, assertNetworkAllowed, platformHosts } from "../platforms/authorize.js";
import { loadCatalog, stateOf } from "../platforms/catalog.js";
import { lockKeysFor } from "../sale/lockKeys.js";
import { SelectorResolver } from "../selectors/resolver.js";
import { assertCompliant } from "../sites/compliance.js";
import { discoverAdapters } from "../sites/registry.js";
import type { AdapterContext } from "../sites/SiteAdapter.js";
import { Clock } from "../utils/clock.js";
import { acquireEventLock, combineLocks, type EventLock } from "../utils/lock.js";
import { createLogger, pickLevel } from "../utils/logger.js";
import { trackSecretEnv } from "../utils/redact.js";
import type { Page } from "playwright";
import type { Logger } from "../utils/logger.js";
import type { SelectorSpec } from "../selectors/resolver.js";
import { compileSelection } from "./compile.js";
import { SaleMonitor, instrument, newCounts } from "./monitor.js";
import { formatDashboard, type InstantReport, type InstantStatus } from "./report.js";
import { buildEmail, createMailer, readEmailConfig, sendBounded, EmailConfigError, type EmailConfig, type Mailer, type NotificationOutcome } from "./emailNotify.js";
import { handOffToUser, type HandoffPage } from "./handoff.js";
import { Timeline, timingsOf, type TimelineEvent } from "./timeline.js";

/**
 * INSTANT-ON-SALE — `InstantSaleRunner` : une couche AU-DESSUS du cœur gelé (Agent, sélection, autorisation, verrous, garde-fous réseau,
 * blocages, paiement : aucun n'est modifié). Il prépare tout AVANT T0 (navigateur, session, page de l'événement, critères compilés,
 * autorisation, hôtes, verrous) puis confie le chemin critique au cœur :
 *
 *   disponibilité → offres → filtre/tri déterministes (cœur) → sélection → ajout au panier → relecture et vérification du panier
 *   → CART_SUCCESS → arrêt. Le navigateur reste ouvert ; le PAIEMENT reste MANUEL.
 *
 * L'ordre des garde-fous est celui de `run` (live.ts) : canal → autorisation → conformité → hôtes → verrous → navigateur → garde réseau →
 * première navigation. Aucune option ne permet d'en sauter un.
 */
export interface InstantSaleOptions {
  target: string;
  exitWhenDone?: boolean;
  logLevel?: string;
  logFile?: string;
}

export interface InstantSaleDeps extends LiveDeps {
  /** Session de navigateur déjà ouverte (tests) ; défaut : openBrowser (un navigateur par profil). */
  session?: Pick<BrowserSession, "context" | "page"> & { detach?: () => Promise<void>; shutdown?: () => Promise<void> };
  print?: (line: string) => void;
  locksDir?: string;
  claudeClient?: MessagesClient;
  /** Attente humaine (tests) ; défaut : celle du cœur (notification + Entrée / détection). */
  awaitHuman?: (b: Blocker) => Promise<void>;
  /** Compteur de requêtes vues côté serveur de fixture (tests). */
  observedRequests?: () => number;
  /** Intervalle de relecture locale de l'autorisation pendant la surveillance (défaut du cœur : 30 s). */
  authCheckIntervalMs?: number;
  catalogLoader?: () => import("../platforms/catalog.js").Catalog;
  /** Événements du chemin critique (journal minimal). */
  onEvent?: (e: TimelineEvent, at: number) => void;
  /** Notification e-mail : configuration déjà validée (tests) ; défaut : lue dans le fichier (`notifications.email`). `null` = désactivée. */
  emailConfig?: EmailConfig | null;
  /** Expéditeur e-mail (tests : double local, aucun serveur réel) ; défaut : celui du fournisseur configuré (SMTP ou API). */
  mailer?: Mailer;
  /** Délai maximal de l'envoi e-mail (défaut 10 s) : n'affecte jamais le passage de main. */
  emailTimeoutMs?: number;
}

export interface InstantSaleResult {
  code: number;
  report: InstantReport;
  dashboard: string;
  run?: RunResult;
  timeline: Partial<Record<TimelineEvent, number>>;
}

/** Claude n'intervient que si la configuration l'autorise ET que l'adaptateur signale un sélecteur introuvable (ambiguïté explicite). Jamais pour un diagnostic. */
export class InstantClaude extends ClaudeAssistant {
  criticalPath = 0;
  total = 0;
  denied = 0;
  constructor(cfg: BotConfig["claude"], log: Logger, private readonly critical: () => boolean, client?: MessagesClient) {
    super(cfg, log, client);
  }
  override async healSelector(page: Page, spec: SelectorSpec, resolver: SelectorResolver): Promise<boolean> {
    if (!this.enabled) return false;
    this.total++;
    if (this.critical()) this.criticalPath++;
    return super.healSelector(page, spec, resolver);
  }
  /** Un diagnostic n'est pas une action du chemin nominal : refusé (il n'est jamais nécessaire pour atteindre le panier). */
  override async diagnose(_page: Page): Promise<string | null> {
    this.denied++;
    return null;
  }
}

const pad = (n: number, w = 2): string => String(Math.floor(n)).padStart(w, "0");
const rel = (ms: number): string => (Math.abs(ms) >= 1000 ? `T${ms < 0 ? "-" : "+"}${pad(Math.abs(ms) / 60000)}:${(Math.abs(ms) / 1000 % 60).toFixed(1).padStart(4, "0")}` : `T${ms < 0 ? "" : "+"}${Math.round(ms)}ms`);

export async function runInstantSale(o: InstantSaleOptions, deps: InstantSaleDeps = {}): Promise<InstantSaleResult> {
  const print = deps.print ?? ((l: string) => console.log(l));
  const timeline = new Timeline();
  timeline.mark("T_PREPARE_START");

  // ── 1. configuration + autorisation COMPLÈTE avant tout réseau
  const config = loadConfig(o.target);
  let email: EmailConfig | null;
  try {
    email = deps.emailConfig !== undefined ? deps.emailConfig : readEmailConfig(o.target);
  } catch (e) {
    if (!(e instanceof EmailConfigError)) throw e;
    const report = emptyReport("REFUSED", e.message, { authorization: "non évaluée", channel: "—", lock: "non pris", payment: "MANUAL" });
    return { code: 1, report, dashboard: formatDashboard(report), timeline: timeline.snapshot() };
  }
  const profile = profileName(resolveConfigPath(o.target));
  const instance = `${profile}#${process.pid}`;
  const saleStart = Date.parse(config.sale.startTime);
  timeline.mark("T_SALE_START", saleStart);
  const log = createLogger({ level: pickLevel(o.logLevel, process.env.LOG_LEVEL, "warn"), file: o.logFile?.replaceAll("{profile}", profile).replaceAll("{pid}", String(process.pid)), scope: instance });
  const catalog = deps.catalog ?? loadCatalog();
  const decision = resolveChannel({ platform: config.site, adapters: deps.adapters ?? (await discoverAdapters()), catalog, env: process.env, config });
  const refuse = (reason: string, security: Partial<InstantReport["security"]> = {}): InstantSaleResult => {
    const report = emptyReport("REFUSED", reason, { authorization: security.authorization ?? "refusée", channel: decision.channel, lock: "non pris", payment: "MANUAL" });
    return { code: 1, report, dashboard: formatDashboard(report), timeline: timeline.snapshot() };
  };
  if (decision.channel === "human" || !decision.adapter) {
    const st = catalog.platforms.some((p) => p.id === config.site) ? stateOf(catalog, config.site) : undefined;
    return refuse(`aucun canal automatisé autorisé pour « ${config.site} »${st ? ` (statut ${st.status})` : " (absente du catalogue)"} : INSTANT-ON-SALE refuse de démarrer — ${decision.reasons.join("; ")}`);
  }
  const adapter = decision.adapter;
  trackSecretEnv(...(adapter.meta.requires?.env ?? []));
  assertAuthorized(adapter.meta, catalog);
  assertCompliant(adapter.meta, adapter.resolveEventUrl(config));
  assertNetworkAllowed(adapter, config, catalog);
  const hosts = platformHosts(adapter.meta, catalog);
  const testOnly = adapter.meta.testOnly === true;
  const status0 = testOnly ? "TEST_ONLY" : (stateOf(catalog, adapter.authorization.platform).status as string);

  // ── 2. verrous : les mêmes que run / sale:wait / login / check (événement + profil de navigateur)
  const wanted = lockKeysFor(adapter, config, decision.channel, profile).map((k) => k.key);
  const locks: EventLock[] = [];
  let lock: EventLock;
  let session: (NonNullable<InstantSaleDeps["session"]> | BrowserSession) | undefined;
  let releaseGuard: () => Promise<void> = async () => undefined;
  let tuning: { release(): Promise<void> } = { release: async () => undefined };
  let monitor: SaleMonitor | undefined;
  try {
    if (deps.held) {
      if (wanted.some((k) => !deps.held!.keys.includes(k)) || deps.held.keys.length !== wanted.length) {
        deps.held.lock.release();
        throw new Error("Les verrous détenus ne correspondent plus à l'événement/profil à lancer (configuration modifiée) : lancement refusé.");
      }
      if (!deps.held.lock.verify()) throw new Error("Le verrou d'événement n'est plus détenu par cette instance : lancement refusé.");
      lock = deps.held.lock;
      locks.push(lock);
    } else {
      for (const k of wanted) locks.push(acquireEventLock(k, instance, deps.locksDir));
      lock = combineLocks(...locks);
    }

    // ── 3. navigateur / session (une seule fois, avant T0) et garde réseau AVANT toute navigation
    const userDataDir = config.browser.userDataDir ?? defaultUserDataDir(profile);
    const t0b = performance.now();
    session = decision.channel === "browser" ? (deps.session ?? (await openBrowser(config, log.child("browser"), { userDataDir }))) : undefined;
    const browserStartMs = session ? performance.now() - t0b : undefined;
    timeline.mark("T_BROWSER_READY");
    if (session) releaseGuard = await installNetworkGuards(session.context, { paymentPatterns: adapter.paymentUrlPatterns, allowedHosts: hosts, log: log.child("guard") });
    const ctx: AdapterContext = session
      ? { config, context: session.context, page: session.page, log: log.child(`site:${adapter.meta.id}`), env: process.env, selectors: new SelectorResolver(adapter.meta.id) }
      : createApiContext(config, log.child(`site:${adapter.meta.id}`), process.env);
    if (session && "browser" in session) tuning = await tuneNetwork(session.context, session.page, config.browser, log.child("cdp"));

    // ── 4. critères compilés, instrumentation, surveillance autorisée, Claude borné
    const criteria = compileSelection(config);
    const counts = newCounts();
    const blockersSeen = new Set<string>();
    let handoffs = 0;
    let instrumented!: ReturnType<typeof instrument>;
    instrumented = instrument(adapter, { timeline, counts }, () => monitor);
    monitor = new SaleMonitor({ adapter: instrumented, raw: adapter, ctx, criteria, timeline, counts, minIntervalMs: config.timing.pollIntervalMs, saleStartMs: saleStart });
    const claude = new InstantClaude(config.claude, log, () => timeline.get("T_FIRST_POLL") !== undefined, deps.claudeClient);
    const evt = (e: TimelineEvent, at: number): void => {
      deps.onEvent?.(e, at);
      const r = rel(at - saleStart);
      if (e === "T_EVENT_READY") print(`[${rel(at - saleStart)}] SALE_READY`);
      else if (e === "T_FIRST_POLL") print("[T0] SALE_OPEN");
      else if (e === "T_AVAILABILITY_DETECTED") print(`[${r}] AVAILABILITY`);
      else if (e === "T_CART_REQUEST") print(`[${r}] CART_REQUEST`);
    };
    timeline.onMark(evt);
    monitor.onAvailability(() => undefined);

    // ── 5. le cœur pilote : préparation avant T0, déclenchement précis, chemin critique, vérification du panier
    const clock = new Clock();
    const agent = new Agent({
      config,
      adapter: instrumented,
      ctx,
      catalog,
      lock,
      browserStartMs,
      claude,
      log,
      clock,
      mode: "live",
      profile,
      authCheckIntervalMs: deps.authCheckIntervalMs,
      catalogLoader: deps.catalogLoader,
      awaitHuman: deps.awaitHuman ? async (b: Blocker) => (blockersSeen.add(b.state), handoffs++, deps.awaitHuman!(b)) : undefined,
      onArmed: async () => {
        await monitor!.start(); // abonnement au flux OFFICIEL s'il existe ; sinon rien
      },
      onFinish: async () => {
        monitor?.stop(); // CART_SUCCESS ou arrêt : la surveillance cesse
        await releaseGuard(); // le paiement manuel redevient possible
        await tuning.release();
      },
    });
    let result: RunResult;
    try {
      result = await agent.run();
    } finally {
      monitor.stop();
    }

    let notification: Promise<NotificationOutcome> | undefined;
    const ok = result.status === "in-cart";
    if (!ok) timeline.clear("T_CART_SUCCESS"); // une relecture du panier n'est un succès que si le cœur l'a validé
    else {
      print(`[${rel((timeline.get("T_CART_SUCCESS") ?? wallNowFallback()) - saleStart)}] CART_SUCCESS`);
      // Passage de main immédiat : surveillance déjà arrêtée (onFinish), panier déjà revérifié par le cœur, aucune navigation.
      monitor.stop();
      // Notification e-mail : préparée ici, envoyée SANS attendre (le passage de main ne dépend jamais d'elle) ; une seule fois.
      if (email && result.cartOk === true && result.cart) {
        const at = timeline.get("T_CART_SUCCESS") ?? wallNowFallback();
        let send: Promise<NotificationOutcome>;
        try {
          const msg = buildEmail(email, {
            eventName: config.event.name,
            platform: adapter.meta.displayName,
            eventDate: config.event.date,
            quantity: result.cart.itemCount,
            category: [result.offer?.category, result.offer?.section].filter(Boolean).join(" / ") || undefined,
            totalPrice: result.cart.totalPrice,
            currency: result.cart.currency,
            at,
          });
          const mailer = deps.mailer ?? createMailer(email, process.env, deps.emailTimeoutMs ?? 10_000);
          send = sendBounded(mailer, msg, deps.emailTimeoutMs ?? 10_000);
        } catch {
          send = Promise.resolve("FAILED");
        }
        notification = send.then((r) => (r === "SENT" ? (print("EMAIL_NOTIFICATION_SENT"), r) : (print("CART_SUCCESS — EMAIL_NOTIFICATION_FAILED"), r)));
      }
      await handOffToUser(session?.page as HandoffPage | undefined, timeline, print);
    }
    for (const st of result.telemetry?.states ?? []) if (["QUEUE", "CAPTCHA", "BLOCKED", "LOGIN_REQUIRED"].includes(st.state)) blockersSeen.add(st.state);
    const mm = monitor.getMetrics();
    const operations = counts.fetchSale + counts.pollState + counts.getAvailability + counts.getOffers + counts.selectOffer + counts.addToCart + counts.getCartState;
    const report: InstantReport = {
      status: statusOf(result),
      reason: result.failureReason,
      timings: timingsOf(timeline),
      prepare: { prepareToBrowserMs: timeline.between("T_PREPARE_START", "T_BROWSER_READY"), eventPrepareMs: timeline.between("T_EVENT_START", "T_EVENT_READY") },
      metrics: {
        claudeCallsInCriticalPath: claude.criticalPath,
        claudeCallsTotal: claude.total,
        claudeDenied: claude.denied,
        calls: counts,
        networkOperations: operations,
        observedRequests: deps.observedRequests?.(),
        retries: mm.rateLimited + mm.errors,
        rateLimited: mm.rateLimited,
        offersExamined: mm.offersExamined,
        polls: mm.polls,
        skippedByFeed: mm.skippedByFeed,
        feed: mm.feed,
        handoffs,
      },
      security: { authorization: `${status0}${testOnly ? " (fixture locale)" : ""}`, channel: decision.channel, lock: `tenu (${wanted.length === 2 ? "événement + profil" : "événement"}) → libéré`, payment: "MANUAL" },
      blockersSeen: [...blockersSeen],
      mode: testOnly ? "fixture" : "live",
    };
    const dashboard = formatDashboard(report);
    print(dashboard);
    if (session) {
      if (o.exitWhenDone && !ok) await session.shutdown?.(); // jamais de fermeture après CART_SUCCESS : l'utilisateur paie
      else await session.detach?.(); // le navigateur reste ouvert pour le paiement manuel
    }
    if (notification) report.notification = await notification; // après le passage de main : attente bornée, le navigateur est déjà rendu
    else report.notification = "DISABLED";
    return { code: ok ? 0 : 1, report, dashboard, run: result, timeline: timeline.snapshot() };
  } finally {
    monitor?.stop();
    for (const l of locks) l.release(); // succès, erreur ou arrêt : toujours libérés
  }
}

const wallNowFallback = (): number => performance.timeOrigin + performance.now();

function statusOf(r: RunResult): InstantStatus {
  switch (r.status) {
    case "in-cart":
    case "ready-not-added":
      return r.status === "in-cart" ? "CART_SUCCESS" : "ERROR";
    case "cart-mismatch":
      return "CART_MISMATCH";
    case "authorization-expired":
      return "AUTHORIZATION_EXPIRED";
    case "blocked":
      return (r.blocker?.state as InstantStatus | undefined) ?? "BLOCKED";
    case "sale-timeout":
      return r.finalState === "SOLD_OUT" ? "SOLD_OUT" : r.failureReason === "SALE_NOT_OPEN_TIMEOUT" ? "NOT_OPEN" : (["QUEUE", "CAPTCHA", "BLOCKED", "LOGIN_REQUIRED"].includes(r.finalState) ? (r.finalState as InstantStatus) : "ERROR");
    default:
      return "ERROR";
  }
}

function emptyReport(status: InstantStatus, reason: string, security: InstantReport["security"]): InstantReport {
  const n = null;
  return {
    status, reason,
    timings: { prepare_to_browser_ready: n, event_prepare: n, sale_open_to_first_poll: n, sale_open_to_availability: n, availability_to_selection: n, selection_to_cart_request: n, cart_request_to_cart_success: n, total_sale_open_to_cart: n, cart_success_to_ui_ready: n, ui_ready_to_user_control: n },
    prepare: { prepareToBrowserMs: n, eventPrepareMs: n },
    metrics: { claudeCallsInCriticalPath: 0, claudeCallsTotal: 0, claudeDenied: 0, calls: newCounts(), networkOperations: 0, retries: 0, rateLimited: 0, offersExamined: 0, polls: 0, skippedByFeed: 0, feed: "none", handoffs: 0 },
    security, blockersSeen: [], mode: "refused",
  };
}
