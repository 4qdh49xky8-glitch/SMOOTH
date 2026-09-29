import type { BotConfig } from "../config/schema.js";
import { notify } from "../notifications/notify.js";
import { assertCompliant } from "../sites/compliance.js";
import { AUTO_DETECTABLE, type AdapterContext, type Blocker, type CartSummary, type Offer, type SiteAdapter } from "../sites/SiteAdapter.js";
import { Clock, estimateOffset, httpDateServerTime } from "../utils/clock.js";
import {
  BlockerError,
  NotLoggedInError,
  OfferUnavailableError,
  RateLimitedError,
  SelectorNotFoundError,
  StopRunError,
} from "../utils/errors.js";
import type { Logger } from "../utils/logger.js";
import { waitForEnter } from "../utils/prompt.js";
import { waitUntil } from "../utils/scheduler.js";
import { LatencyTracker } from "../utils/timing.js";
import type { ClaudeAssistant } from "./claude.js";
import { rankOffers, verifyCart } from "./matcher.js";

export type RunStatus = "in-cart" | "ready-not-added" | "sale-timeout" | "blocked";

export interface RunResult {
  status: RunStatus;
  offer?: Offer;
  cart?: CartSummary;
  cartOk?: boolean;
  problems?: string[];
  /** Renseigné quand status = "blocked" (ex. limite d'achat). */
  blocker?: Blocker;
  timeline: ReturnType<LatencyTracker["report"]>;
}

export interface AgentDeps {
  config: BotConfig;
  adapter: SiteAdapter;
  ctx: AdapterContext;
  claude: ClaudeAssistant;
  log: Logger;
  clock: Clock;
  /** Appelé avant la phase chaude (ex. : blocage réseau CDP). */
  onArmed?: () => Promise<void>;
  /** Appelé à la fin (ex. : lever le garde-fou de paiement et le filtrage réseau). */
  onFinish?: () => Promise<void>;
  /** Remplaçables (tests, autres interfaces) ; par défaut : notification OS/terminal et attente dans le terminal. */
  notifier?: typeof notify;
  awaitHuman?: (blocker: Blocker) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class Agent {
  private readonly saleEpochMs: number;
  private readonly latency: LatencyTracker;
  /** Exposé pour les tests. */
  readonly d: AgentDeps;

  constructor(d: AgentDeps) {
    this.d = d;
    this.saleEpochMs = Date.parse(d.config.sale.startTime);
    this.latency = new LatencyTracker(d.clock, this.saleEpochMs);
  }

  private notify(o: Parameters<typeof notify>[0]): Promise<void> {
    return (this.d.notifier ?? notify)(o);
  }

  async run(): Promise<RunResult> {
    const { adapter, log } = this.d;
    assertCompliant(adapter.meta, adapter.resolveEventUrl(this.d.config)); // refus avant toute action
    try {
      const result = await this.execute();
      await this.finish(result);
      return result;
    } catch (err) {
      if (!(err instanceof StopRunError)) throw err;
      log.error(err.message);
      const result: RunResult = { status: "blocked", blocker: err.blocker, timeline: this.latency.report() };
      await this.finish(result);
      return result;
    }
  }

  private async execute(): Promise<RunResult> {
    const { config, adapter, ctx, log, clock } = this.d;
    log.info(`Événement « ${config.event.name} » — ouverture ${config.sale.startTime} — site « ${adapter.meta.id} »`);

    await this.syncClock();

    // Phase 1 : préparation à T − preArm (connexion, chargement, connexions chaudes).
    const armAt = this.saleEpochMs - config.timing.preArmSeconds * 1000;
    if (clock.now() < armAt) {
      log.info(`Attente jusqu'à la préparation (${new Date(armAt).toISOString()})…`);
      await waitUntil(armAt, clock, { spinThresholdMs: 1000 });
    }
    await this.step("login", () => adapter.ensureLoggedIn(ctx));
    log.info("Compte connecté.");
    await this.step("prepare", () => adapter.prepare(ctx));
    await this.d.onArmed?.();
    if (this.saleEpochMs - clock.now() > 20_000) await this.syncClock(); // recalage final

    // Phase 2 : déclenchement précis.
    const remaining = this.saleEpochMs - clock.now();
    if (remaining > 0) log.info(`Prêt. Ouverture dans ${(remaining / 1000).toFixed(1)} s.`);
    const overshoot = await waitUntil(this.saleEpochMs, clock, {
      spinThresholdMs: config.timing.spinThresholdMs,
      onTick: (ms) => ms < 30_000 && log.info(`T−${(ms / 1000).toFixed(0)} s`),
    });
    this.latency.mark("triggered");
    log.info(`GO (dépassement de l'horloge : ${overshoot.toFixed(1)} ms)`);

    // Phase 3 : surveillance + tentatives.
    return this.watchAndBuy();
  }

  /** Synchronise l'horloge avec le serveur du site (heure précise si exposée, sinon en-tête Date). */
  private async syncClock(): Promise<void> {
    const { adapter, ctx, log, clock, config } = this.d;
    try {
      const fetcher = adapter.getServerTime
        ? () => adapter.getServerTime!(ctx)
        : () => httpDateServerTime(adapter.resolveEventUrl(config));
      const est = await estimateOffset(fetcher);
      clock.offsetMs = est.offsetMs;
      log.info(
        `Horloge : décalage serveur ${est.offsetMs.toFixed(1)} ms (RTT min ${est.rttMs.toFixed(1)} ms)` +
          (adapter.getServerTime ? "" : " — précision ±500 ms (en-tête Date)"),
      );
    } catch (err) {
      log.warn(`Synchronisation d'horloge impossible (${(err as Error).message}) : horloge locale utilisée.`);
    }
  }

  private async watchAndBuy(): Promise<RunResult> {
    const { config, adapter, ctx, log, clock } = this.d;
    const deadline = this.saleEpochMs + config.timing.maxWaitAfterSaleSeconds * 1000;
    let attempts = 0;
    let announcedOpen = false;
    let lastSummary = "";

    while (clock.now() < deadline) {
      const t0 = clock.now();
      let snapshot;
      try {
        snapshot = await adapter.fetchSale(ctx);
      } catch (err) {
        if (err instanceof RateLimitedError) {
          log.warn(err.message);
          await sleep(err.retryAfterMs);
          continue;
        }
        log.warn(`Lecture de la vente : ${(err as Error).message}`);
        await sleep(config.timing.pollIntervalMs);
        continue;
      }

      if (snapshot.open) {
        if (!announcedOpen) {
          announcedOpen = true;
          this.latency.mark("sale-detected");
          log.info("Vente détectée ouverte.");
        }
        const ranked = rankOffers(snapshot.offers, config.tickets);
        const summary = `${snapshot.offers.length} offres, ${ranked.length} correspondent`;
        if (summary !== lastSummary) {
          lastSummary = summary;
          log.info(summary);
        }
        for (const offer of ranked) {
          if (attempts >= config.cart.maxAttempts) break;
          attempts++;
          this.latency.mark("offer-ranked");
          try {
            const result = await this.tryOffer(offer);
            if (result) return result;
          } catch (err) {
            if (!(err instanceof OfferUnavailableError)) throw err;
            log.warn(`Offre ${offer.id} indisponible (${err.message}) — suivante.`);
          }
        }
        if (attempts >= config.cart.maxAttempts) {
          log.error(`Nombre maximal de tentatives atteint (${config.cart.maxAttempts}).`);
          break;
        }
      }

      // Cadence volontairement limitée : mesurée depuis le DÉBUT de la requête (pas de cumul).
      const jitter = Math.random() * config.timing.pollJitterMs;
      const wait = config.timing.pollIntervalMs + jitter - (clock.now() - t0);
      if (wait > 0) await sleep(wait);
    }

    await this.notify({
      title: "⏱️ Aucun panier obtenu",
      message: "Aucune offre correspondant à vos critères n'a pu être ajoutée dans le temps imparti.",
      ...config.notifications,
    });
    return { status: "sale-timeout", timeline: this.latency.report() };
  }

  private async tryOffer(offer: Offer): Promise<RunResult | null> {
    const { config, adapter, ctx, log } = this.d;
    log.info(`Tentative : ${offer.category} · ${offer.pricePerTicket} ${offer.currency}/billet · id=${offer.id} · côte à côte=${String(offer.seatsTogether)}`);
    await this.step("selectOffer", () => adapter.selectOffer(ctx, offer, config.tickets.quantity));
    if (adapter.selectSeats) await this.step("selectSeats", () => adapter.selectSeats!(ctx, offer, config.tickets.quantity));
    this.latency.mark("offer-selected");

    if (!config.behavior.autoAddToCart) {
      return { status: "ready-not-added", offer, timeline: this.latency.report() };
    }
    await this.step("addToCart", () => adapter.addToCart(ctx));
    this.latency.mark("added-to-cart");

    let cart: CartSummary | undefined;
    try {
      cart = await this.step("readCart", () => adapter.readCart(ctx));
      this.latency.mark("cart-verified");
    } catch (err) {
      log.warn(`Ajout effectué mais lecture du panier impossible : ${(err as Error).message}`);
    }
    const check = cart ? verifyCart(cart, config.tickets) : { ok: false, problems: ["panier non relu — à vérifier manuellement"] };
    return { status: "in-cart", offer, cart, cartOk: check.ok, problems: check.problems, timeline: this.latency.report() };
  }

  /**
   * Exécute une étape de l'adaptateur avec la logique de reprise :
   *  - limite d'achat → arrêt définitif du run (jamais contournée) ;
   *  - file d'attente / CAPTCHA / anti-bot / connexion → cession de la main à l'humain, puis nouvel essai ;
   *  - étape confiée à l'humain (choix de places sur un plan) → cession de la main, puis on continue ;
   *  - sélecteur introuvable → réparation par Claude (si activé), puis nouvel essai ;
   *  - sinon l'erreur remonte.
   */
  private async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const { adapter, ctx, claude, log } = this.d;
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof OfferUnavailableError || err instanceof RateLimitedError || err instanceof StopRunError) throw err;
        if (attempt >= 3) throw err;
        const blocker: Blocker | null =
          err instanceof NotLoggedInError
            ? { kind: "login-required", message: err.message }
            : err instanceof BlockerError
              ? err.blocker
              : await adapter.detectBlocker(ctx).catch(() => null);
        if (blocker) {
          if (blocker.kind === "purchase-limit") throw new StopRunError(blocker);
          await this.handoff(blocker);
          if (blocker.kind === "human-step") return undefined as T; // l'humain a réalisé l'étape
          continue;
        }
        if (err instanceof SelectorNotFoundError && (await claude.healSelector(ctx.page, err.spec, ctx.selectors))) {
          log.info(`Étape « ${name} » : nouvel essai avec le sélecteur réparé.`);
          continue;
        }
        const hint = await claude.diagnose(ctx.page);
        if (hint) log.warn(`Diagnostic Claude : ${hint}`);
        throw err;
      }
    }
  }

  /** Le bot ne touche plus à la page : l'humain traite la file/le CAPTCHA/la connexion/le plan de salle. */
  private async handoff(blocker: Blocker): Promise<void> {
    const { config, adapter, ctx, log } = this.d;
    if (!this.d.awaitHuman && config.browser.headless) {
      throw new Error(`Action humaine requise (${blocker.kind}: ${blocker.message}) mais le navigateur est en mode headless.`);
    }
    await ctx.page.bringToFront().catch(() => undefined);
    await this.notify({
      title: "🖐️ Action requise",
      message: `${blocker.message}. Traitez-le dans la fenêtre du navigateur ; le bot reprendra ensuite (automatiquement ou avec Entrée ici).`,
      ...config.notifications,
    });
    log.warn(`Passage de main humaine : ${blocker.kind} — ${blocker.message}`);
    if (this.d.awaitHuman) {
      await this.d.awaitHuman(blocker);
      log.info("Reprise du bot.");
      return;
    }
    // Connexion / étape humaine : rien à détecter côté page, seule la confirmation humaine compte.
    const detectable = AUTO_DETECTABLE.includes(blocker.kind);
    const enter = waitForEnter(
      detectable
        ? "Appuyez sur Entrée quand c'est réglé (ou attendez la détection automatique)."
        : "Appuyez sur Entrée quand c'est fait.",
    );
    let cleared = false;
    const auto = detectable
      ? (async () => {
          let clean = 0;
          while (!cleared) {
            await sleep(500);
            const b = await adapter.detectBlocker(ctx).catch(() => blocker);
            clean = b ? 0 : clean + 1;
            if (clean >= 2) return;
          }
        })()
      : new Promise<void>(() => undefined);
    await Promise.race([enter.promise, auto]);
    cleared = true;
    enter.cancel();
    log.info("Reprise du bot.");
  }

  private async finish(result: RunResult): Promise<void> {
    const { config, log, ctx } = this.d;
    await this.d.onFinish?.();
    if (result.status === "sale-timeout") return;
    await ctx.page.bringToFront().catch(() => undefined);

    if (result.status === "blocked") {
      await this.notify({
        title: "⛔ Arrêt du bot",
        message: `${result.blocker?.message ?? "Blocage"}. Le bot ne contourne pas les limites du site : vérifiez votre compte/panier manuellement.`,
        ...config.notifications,
      });
    } else if (result.status === "ready-not-added") {
      await this.notify({
        title: "🎟️ Offre sélectionnée (non ajoutée)",
        message: `${result.offer?.category} — ${result.offer?.pricePerTicket} ${result.offer?.currency}/billet. Ajoutez au panier manuellement.`,
        ...config.notifications,
      });
    } else {
      const c = result.cart;
      const detail = c ? `${c.itemCount} billet(s), total ${c.totalPrice} ${c.currency}` : "panier à vérifier";
      const expiry = c?.expiresAt ? `\nRéservation jusqu'à ${new Date(c.expiresAt).toLocaleTimeString()}` : "";
      const warn = result.cartOk ? "" : `\n⚠️ À vérifier : ${(result.problems ?? []).join("; ")}`;
      await this.notify({
        title: "🎟️ PANIER OBTENU — finalisez le paiement vous-même",
        message: `${result.offer?.category} — ${detail}${expiry}${warn}`,
        ...config.notifications,
      });
    }
    log.info(`Chronologie (T = ouverture officielle) :\n${this.latency.format()}`);
    log.info(`Rapport : ${this.latency.save("runs", { event: config.event.name, status: result.status })}`);
  }
}
