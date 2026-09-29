import type { BotConfig } from "../config/schema.js";
import { notify } from "../notifications/notify.js";
import { assertAuthorized } from "../platforms/authorize.js";
import { loadCatalog, type Catalog } from "../platforms/catalog.js";
import { assertCompliant } from "../sites/compliance.js";
import type { AdapterContext, Blocker, CartSummary, Offer, SaleSnapshot, SiteAdapter } from "../sites/SiteAdapter.js";
import { sanitize, Telemetry, type TelemetryRecord } from "../telemetry/Telemetry.js";
import { Clock, estimateOffset, httpDateServerTime } from "../utils/clock.js";
import {
  BlockerError,
  HumanRequiredError,
  NotLoggedInError,
  OfferUnavailableError,
  RateLimitedError,
  SelectorNotFoundError,
  StopRunError,
} from "../utils/errors.js";
import type { Logger } from "../utils/logger.js";
import { waitForEnter } from "../utils/prompt.js";
import { redact } from "../utils/redact.js";
import { waitUntil } from "../utils/scheduler.js";
import type { ClaudeAssistant } from "./claude.js";
import { explainOffer, rankOffers, verifyCart } from "./matcher.js";
import { AUTO_DETECTABLE, reasonForState, State, type BlockingState, type FailureReason } from "./states.js";

/**
 * in-cart          panier vérifié conforme
 * cart-mismatch    billets ajoutés mais panier non conforme (quantité/prix) ou illisible : à vérifier À LA MAIN
 * ready-not-added  offre sélectionnée, ajout laissé à l'humain (autoAddToCart=false)
 */
export type RunStatus = "in-cart" | "ready-not-added" | "cart-mismatch" | "sale-timeout" | "blocked" | "error";

export interface RunResult {
  status: RunStatus;
  /** État standardisé final (voir src/agent/states.ts). */
  finalState: State;
  failureReason?: FailureReason;
  offer?: Offer;
  cart?: CartSummary;
  cartOk?: boolean;
  problems?: string[];
  blocker?: Blocker;
  timeline: TelemetryRecord["timeline"];
  telemetry: TelemetryRecord;
  telemetryFile?: string | null;
}

export interface AgentDeps {
  config: BotConfig;
  adapter: SiteAdapter;
  ctx: AdapterContext;
  claude: ClaudeAssistant;
  log: Logger;
  clock: Clock;
  mode?: "live" | "simulation";
  /** Nom du profil de configuration (télémétrie). */
  profile?: string;
  /** Appelé avant la phase chaude (ex. : blocage réseau CDP). */
  onArmed?: () => Promise<void>;
  /** Appelé à la fin (ex. : lever le garde-fou de paiement et le filtrage réseau). */
  onFinish?: () => Promise<void>;
  /** Remplaçables (tests, simulation) ; par défaut : notification OS/terminal et attente dans le terminal. */
  notifier?: typeof notify;
  awaitHuman?: (blocker: Blocker) => Promise<void>;
  /** Attente de la confirmation humaine (Entrée). Remplaçable pour tester la vraie attente. */
  waitForEnter?: typeof waitForEnter;
  /** Catalogue des plateformes (par défaut platforms/catalog.json, chargé seulement pour un adaptateur non-démo). */
  catalog?: Catalog;
}

type BuildExtra = Partial<Pick<RunResult, "failureReason" | "offer" | "cart" | "cartOk" | "problems" | "blocker">>;
interface Outcome {
  status: RunStatus;
  finalState: State;
  extra: BuildExtra;
  attempt: { outcome: "cart" | "selected" | "error"; reason?: FailureReason };
}

/** États détectés AVANT toute tentative de sélection. Les autres (limite d'achat, choix manuel) ne se jugent qu'après un échec, sinon une simple bannière d'information suffirait à stopper le run. */
const PREFLIGHT_STATES: readonly BlockingState[] = ["QUEUE", "CAPTCHA", "BLOCKED", "LOGIN_REQUIRED"];
/** Après une cession de main, un blocage encore détecté n'en redéclenche pas une autre pendant ce délai (évite une boucle de cessions). */
const HUMAN_ACK_MS = 15_000;

/** Lecture de l'état de la page : au-delà, on la considère absente (une page occupée ne doit jamais geler la surveillance). */
const BLOCKER_CHECK_TIMEOUT_MS = 250;
/** Erreurs de lecture consécutives : attente exponentielle plafonnée, journalisation espacée. */
const ERROR_BACKOFF_CAP_MS = 5000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Résout avec la valeur de `p`, ou `fallback` après `ms` (minuteur libéré dès la fin : rien ne traîne en arrière-plan). */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      () => (clearTimeout(timer), resolve(fallback)),
    );
  });
}

export class Agent {
  /** Exposé pour les tests. */
  readonly d: AgentDeps;
  private readonly saleEpochMs: number;
  private readonly telemetry: Telemetry;
  private readonly log: Logger;
  private state: State | null = null;
  private lastSaleState: State | null = null;
  private everOpen = false;
  private readonly ackUntil = new Map<string, number>();
  private readonly pending: Promise<unknown>[] = [];

  constructor(d: AgentDeps) {
    this.d = d;
    this.log = d.log.child("agent");
    this.saleEpochMs = Date.parse(d.config.sale.startTime);
    this.telemetry = new Telemetry({
      clock: d.clock,
      saleEpochMs: this.saleEpochMs,
      mode: d.mode ?? "live",
      site: d.adapter.meta.id,
      profile: d.profile,
      enabled: d.config.telemetry.enabled,
      dir: d.config.telemetry.dir,
    });
  }

  /**
   * Notification NON bloquante (un webhook lent ne doit jamais retarder le bot) et assainie :
   * les textes fournis par les sites (messages d'erreur, blocages) peuvent contenir des secrets.
   */
  private notify(o: Parameters<typeof notify>[0]): void {
    const safe = { ...o, title: redact(o.title), message: redact(o.message) };
    const p = Promise.resolve((this.d.notifier ?? notify)(safe)).catch(() => undefined);
    this.pending.push(p);
  }

  private setState(s: State, detail?: string): void {
    if (this.state === s) return;
    this.state = s;
    this.telemetry.state(s, detail);
    this.log.info(`État → ${s}${detail ? ` (${detail})` : ""}`);
  }

  async run(): Promise<RunResult> {
    const { adapter } = this.d;
    assertCompliant(adapter.meta, adapter.resolveEventUrl(this.d.config)); // refus avant toute action
    // Tout adaptateur non-démo doit correspondre à une plateforme dont les PREUVES officielles autorisent son canal.
    const catalog = this.d.catalog ?? (adapter.meta.compliance.policy === "demo" ? undefined : loadCatalog());
    if (catalog) assertAuthorized(adapter.meta, catalog);
    let result: RunResult;
    try {
      result = await this.execute();
    } catch (err) {
      result = this.failure(err);
    }
    await this.finish(result);
    return result;
  }

  private build(status: RunStatus, finalState: State, extra: BuildExtra = {}): RunResult {
    const telemetry = this.telemetry.finalize({
      status,
      finalState,
      failureReason: extra.failureReason,
      cart: extra.cart && { itemCount: extra.cart.itemCount, totalPrice: extra.cart.totalPrice, currency: extra.cart.currency },
    });
    return { status, finalState, ...extra, timeline: telemetry.timeline, telemetry };
  }

  private failure(err: unknown): RunResult {
    if (err instanceof StopRunError) {
      this.log.error(err.message);
      return this.build("blocked", err.blocker.state, { failureReason: reasonForState(err.blocker.state), blocker: err.blocker });
    }
    const reason: FailureReason =
      err instanceof HumanRequiredError
        ? "HUMAN_REQUIRED_HEADLESS"
        : err instanceof SelectorNotFoundError
          ? "SELECTOR_NOT_FOUND"
          : err instanceof RateLimitedError
            ? "RATE_LIMITED"
            : "ADAPTER_ERROR";
    this.log.error((err as Error).message);
    this.setState(State.ERROR, sanitize((err as Error).message, 80));
    return this.build("error", State.ERROR, { failureReason: reason });
  }

  private async execute(): Promise<RunResult> {
    const { config, adapter, ctx, clock } = this.d;
    this.log.info(`Événement « ${config.event.name} » — ouverture ${config.sale.startTime} — site « ${adapter.meta.id} »`);

    // Limite d'achat officielle connue : on ne tente rien qui la dépasse (ni ne la contourne). Aucun appel au site.
    const cap = adapter.meta.capabilities.maxTicketsPerOrder;
    if (cap !== undefined && config.tickets.quantity > cap) {
      const blocker: Blocker = {
        state: "PURCHASE_LIMIT",
        message: `quantité demandée (${config.tickets.quantity}) supérieure à la limite d'achat du site (${cap}) : le bot ne contourne pas les limites`,
      };
      this.setState(State.PURCHASE_LIMIT, blocker.message);
      throw new StopRunError(blocker);
    }

    await this.syncClock();

    // Phase 1 : préparation à T − preArm (connexion, chargement, connexions chaudes).
    const armAt = this.saleEpochMs - config.timing.preArmSeconds * 1000;
    if (clock.now() < armAt) {
      this.log.info(`Attente jusqu'à la préparation (${new Date(armAt).toISOString()})…`);
      await waitUntil(armAt, clock, { spinThresholdMs: 50 }); // précision suffisante ; pas d'attente active longue
    }
    await this.step("login", () => adapter.ensureLoggedIn(ctx));
    this.log.info("Compte connecté.");
    await this.step("prepare", () => adapter.prepare(ctx));
    await this.d.onArmed?.();
    if (this.saleEpochMs - clock.now() > 20_000) await this.syncClock(); // recalage final

    // Phase 2 : déclenchement précis.
    const remaining = this.saleEpochMs - clock.now();
    if (remaining > 0) this.log.info(`Prêt. Ouverture dans ${(remaining / 1000).toFixed(1)} s.`);
    const overshoot = await waitUntil(this.saleEpochMs, clock, {
      spinThresholdMs: config.timing.spinThresholdMs,
      onTick: (ms) => ms < 30_000 && this.log.info(`T−${(ms / 1000).toFixed(0)} s`),
    });
    this.telemetry.mark("triggered");
    this.telemetry.setOvershoot(overshoot);
    this.log.info(`GO (dépassement de l'horloge : ${overshoot.toFixed(1)} ms)`);

    // Phase 3 : surveillance + tentatives.
    return this.watchAndBuy();
  }

  /** Synchronise l'horloge avec le serveur du site (heure précise si exposée, sinon en-tête Date). */
  private async syncClock(): Promise<void> {
    const { adapter, ctx, clock, config } = this.d;
    try {
      const fetcher = adapter.getServerTime
        ? () => adapter.getServerTime!(ctx)
        : () => httpDateServerTime(adapter.resolveEventUrl(config));
      const est = await estimateOffset(fetcher, adapter.getServerTime ? 7 : 3); // en-tête Date : résolution 1 s, plus d'échantillons n'apporteraient rien
      clock.offsetMs = est.offsetMs;
      this.telemetry.setClock(est.offsetMs, est.rttMs);
      this.log.info(
        `Horloge : décalage serveur ${est.offsetMs.toFixed(1)} ms (RTT min ${est.rttMs.toFixed(1)} ms)` +
          (adapter.getServerTime ? "" : " — précision ±500 ms (en-tête Date)"),
      );
    } catch (err) {
      this.log.warn(`Synchronisation d'horloge impossible (${(err as Error).message}) : horloge locale utilisée.`);
    }
  }

  private async watchAndBuy(): Promise<RunResult> {
    const { config, adapter, ctx, clock } = this.d;
    const deadline = this.saleEpochMs + config.timing.maxWaitAfterSaleSeconds * 1000;
    const cooldown = new Map<string, number>(); // offre → instant avant lequel on ne la retente pas
    let attempts = 0;
    let readErrors = 0;
    let lastSummary = "";

    while (clock.now() < deadline) {
      const t0 = clock.now();
      let snapshot: SaleSnapshot;
      let blocker: Blocker | null;
      try {
        // Disponibilité (HTTP) et état de la page (lecture seule) EN PARALLÈLE : aucune latence ajoutée,
        // et aucune sélection n'est tentée si une file d'attente / un CAPTCHA / un contrôle anti-bot est affiché.
        if (adapter.pollState) {
          ({ snapshot, blocker } = await adapter.pollState(ctx));
        } else {
          [snapshot, blocker] = await Promise.all([
            adapter.fetchSale(ctx),
            withTimeout(adapter.detectBlocker(ctx), BLOCKER_CHECK_TIMEOUT_MS, null),
          ]);
        }
        this.telemetry.poll(clock.now() - t0);
        readErrors = 0;
      } catch (err) {
        if (err instanceof RateLimitedError) {
          this.log.warn(err.message);
          await sleep(err.retryAfterMs);
          continue;
        }
        // Panne persistante (réseau, site) : on ne martèle pas à cadence fixe et on n'inonde pas les logs.
        readErrors++;
        if (readErrors <= 2 || (readErrors & (readErrors - 1)) === 0) {
          this.log.warn(`Lecture de la vente : ${(err as Error).message}${readErrors > 2 ? ` (échec n°${readErrors}, logs espacés)` : ""}`);
        }
        await sleep(Math.min(ERROR_BACKOFF_CAP_MS, config.timing.pollIntervalMs * 2 ** Math.min(readErrors - 1, 5)));
        continue;
      }

      if (blocker && PREFLIGHT_STATES.includes(blocker.state) && (this.ackUntil.get(blocker.state) ?? 0) < clock.now()) {
        await this.handoff(blocker); // aucune action sur le site tant que l'humain n'a pas traité le blocage
        continue;
      }

      if (snapshot.open) {
        this.everOpen = true;
        const purchasable = snapshot.offers.filter((o) => o.available > 0);
        const saleState = snapshot.soldOut || purchasable.length === 0 ? State.SOLD_OUT : State.AVAILABLE;
        this.lastSaleState = saleState;
        this.setState(saleState);
        if (saleState === State.AVAILABLE && !this.telemetry.hasMark("availability-detected")) {
          this.telemetry.mark("availability-detected");
          this.log.info("Disponibilité détectée.");
        }

        const now = clock.now();
        const ranked = rankOffers(snapshot.offers, config.tickets, config.strategy).filter((o) => (cooldown.get(o.id) ?? 0) <= now);
        const summary = `${snapshot.offers.length} offres, ${ranked.length} correspondent`;
        if (summary !== lastSummary) {
          lastSummary = summary;
          this.log.info(summary);
          for (const o of ranked.slice(0, 3)) this.log.debug(`  classement : ${o.id} ${o.category} ${o.pricePerTicket} — ${explainOffer(o, config.tickets, config.strategy)}`);
        }

        for (const offer of ranked) {
          if (attempts >= config.cart.maxAttempts) break;
          attempts++;
          const started = clock.now();
          const meta = { category: offer.category, pricePerTicket: offer.pricePerTicket };
          try {
            const outcome = await this.tryOffer(offer);
            // La tentative est enregistrée AVANT la finalisation du rapport (sinon elle n'y figurerait pas).
            this.telemetry.attempt({ ...meta, ...outcome.attempt, durationMs: clock.now() - started });
            return this.build(outcome.status, outcome.finalState, outcome.extra);
          } catch (err) {
            if (err instanceof OfferUnavailableError) {
              cooldown.set(offer.id, clock.now() + config.cart.unavailableCooldownMs);
              this.telemetry.attempt({ ...meta, outcome: "unavailable", reason: "OFFER_UNAVAILABLE", durationMs: clock.now() - started });
              this.log.warn(`Offre ${offer.id} indisponible (${err.message}) — suivante.`);
              continue;
            }
            this.telemetry.attempt({ ...meta, outcome: "error", reason: err instanceof StopRunError ? reasonForState(err.blocker.state) : "ADAPTER_ERROR", durationMs: clock.now() - started });
            throw err;
          }
        }
        if (attempts >= config.cart.maxAttempts) {
          this.log.error(`Nombre maximal de tentatives atteint (${config.cart.maxAttempts}).`);
          return this.timeout("MAX_ATTEMPTS");
        }
      }

      // Cadence volontairement limitée, mesurée depuis le DÉBUT de la requête (pas de cumul). Vente complète : on ralentit.
      const base = this.lastSaleState === State.SOLD_OUT ? Math.max(config.timing.pollIntervalMs, config.timing.soldOutPollIntervalMs) : config.timing.pollIntervalMs;
      const wait = base + Math.random() * config.timing.pollJitterMs - (clock.now() - t0);
      if (wait > 0) await sleep(wait);
    }
    return this.timeout(this.everOpen ? "NO_MATCHING_OFFER" : "SALE_NOT_OPEN_TIMEOUT");
  }

  private timeout(reason: FailureReason): RunResult {
    const finalState = reason === "SALE_NOT_OPEN_TIMEOUT" ? State.ERROR : (this.lastSaleState ?? State.ERROR);
    if (finalState === State.ERROR) this.setState(State.ERROR, reason);
    return this.build("sale-timeout", finalState, { failureReason: reason });
  }

  private async tryOffer(offer: Offer): Promise<Outcome> {
    const { config, adapter, ctx } = this.d;
    const quantity = config.tickets.quantity;
    this.log.info(
      `Tentative : ${offer.category} · ${offer.pricePerTicket} ${offer.currency}/billet · id=${offer.id} · côte à côte=${String(offer.seatsTogether)}`,
    );
    await this.step("selectOffer", () => adapter.selectOffer(ctx, offer, quantity));
    if (adapter.selectSeats) await this.step("selectSeats", () => adapter.selectSeats!(ctx, offer, quantity));
    this.telemetry.mark("offer-selected");

    if (!config.behavior.autoAddToCart) {
      this.setState(State.MANUAL_SELECTION, "autoAddToCart=false");
      return { status: "ready-not-added", finalState: State.MANUAL_SELECTION, extra: { offer }, attempt: { outcome: "selected" } };
    }
    await this.step("addToCart", () => adapter.addToCart(ctx));
    this.telemetry.mark("added-to-cart");
    // Notification IMMÉDIATE (avant la relecture du panier) : c'est ce qui compte quand chaque seconde compte.
    this.notify({
      title: "🎟️ PANIER OBTENU — finalisez le paiement vous-même",
      message: `${offer.category} — ${quantity} billet(s) à ${offer.pricePerTicket} ${offer.currency}. Vérification du panier en cours…`,
      ...config.notifications,
    });

    let cart: CartSummary | undefined;
    try {
      cart = await this.step("readCart", () => adapter.readCart(ctx));
      this.telemetry.mark("cart-verified");
    } catch (err) {
      this.log.warn(`Ajout effectué mais lecture du panier impossible : ${(err as Error).message}`);
    }

    if (!cart) {
      this.setState(State.ERROR, "CART_UNVERIFIED");
      return {
        status: "cart-mismatch",
        finalState: State.ERROR,
        extra: { offer, cartOk: false, problems: ["panier non relu — à vérifier manuellement"], failureReason: "CART_UNVERIFIED" },
        attempt: { outcome: "error", reason: "CART_UNVERIFIED" },
      };
    }
    const check = verifyCart(cart, config.tickets);
    if (!check.ok) {
      // Panier incomplet ou hors budget : on NE le déclare PAS réussi, on n'empile pas d'autres ajouts, l'humain tranche.
      this.setState(State.ERROR, "CART_MISMATCH");
      return {
        status: "cart-mismatch",
        finalState: State.ERROR,
        extra: { offer, cart, cartOk: false, problems: check.problems, failureReason: "CART_MISMATCH" },
        attempt: { outcome: "error", reason: "CART_MISMATCH" },
      };
    }
    this.setState(State.CART_SUCCESS);
    return { status: "in-cart", finalState: State.CART_SUCCESS, extra: { offer, cart, cartOk: true, problems: [] }, attempt: { outcome: "cart" } };
  }

  /**
   * Exécute une étape de l'adaptateur avec la logique de reprise :
   *  - PURCHASE_LIMIT → arrêt définitif du run (jamais contournée) ;
   *  - QUEUE / CAPTCHA / BLOCKED / LOGIN_REQUIRED → cession de la main à l'humain, puis nouvel essai ;
   *  - MANUAL_SELECTION (choix de places sur un plan) → cession de la main, puis on continue ;
   *  - sélecteur introuvable → réparation par Claude (si activé), puis nouvel essai ;
   *  - sinon l'erreur remonte.
   */
  private async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const { adapter, ctx, claude } = this.d;
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof OfferUnavailableError || err instanceof RateLimitedError || err instanceof StopRunError) throw err;
        if (attempt >= 3) throw err;
        const blocker: Blocker | null =
          err instanceof NotLoggedInError
            ? { state: "LOGIN_REQUIRED", message: err.message }
            : err instanceof BlockerError
              ? err.blocker
              : await adapter.detectBlocker(ctx).catch(() => null);
        if (blocker) {
          if (blocker.state === "PURCHASE_LIMIT") {
            this.setState(State.PURCHASE_LIMIT, blocker.message);
            throw new StopRunError(blocker);
          }
          await this.handoff(blocker);
          if (blocker.state === "MANUAL_SELECTION") return undefined as T; // l'humain a réalisé l'étape
          continue;
        }
        if (err instanceof SelectorNotFoundError && (await claude.healSelector(ctx.page, err.spec, ctx.selectors))) {
          this.log.info(`Étape « ${name} » : nouvel essai avec le sélecteur réparé.`);
          continue;
        }
        const hint = await claude.diagnose(ctx.page);
        if (hint) this.log.warn(`Diagnostic Claude : ${hint}`);
        throw err;
      }
    }
  }

  /** Le bot ne touche plus à la page : l'humain traite la file/le CAPTCHA/la connexion/le plan de salle. */
  private async handoff(blocker: Blocker): Promise<void> {
    const { config, adapter, ctx } = this.d;
    const before = this.state;
    this.setState(State[blocker.state], blocker.message);
    this.telemetry.handoff();
    if (!this.d.awaitHuman && config.browser.headless) {
      throw new HumanRequiredError(`Action humaine requise (${blocker.state}: ${blocker.message}) mais le navigateur est en mode headless.`);
    }
    await ctx.page.bringToFront().catch(() => undefined);
    this.notify({
      title: "🖐️ Action requise",
      message: `${blocker.message}. Traitez-le dans la fenêtre du navigateur ; le bot reprendra ensuite (automatiquement ou avec Entrée ici).`,
      ...config.notifications,
    });
    this.log.warn(`Passage de main humaine : ${blocker.state} — ${blocker.message}`);
    if (this.d.awaitHuman) {
      await this.d.awaitHuman(blocker);
    } else {
      // Connexion / étape humaine : rien à détecter côté page, seule la confirmation humaine compte.
      const detectable = AUTO_DETECTABLE.includes(blocker.state);
      const enter = (this.d.waitForEnter ?? waitForEnter)(
        detectable ? "Appuyez sur Entrée quand c'est réglé (ou attendez la détection automatique)." : "Appuyez sur Entrée quand c'est fait.",
      );
      // Détection automatique ANNULABLE : dès la reprise, plus aucune lecture de la page en arrière-plan.
      const ctl = { stopped: false, timer: undefined as NodeJS.Timeout | undefined, wake: undefined as (() => void) | undefined };
      const nap = (ms: number): Promise<void> =>
        new Promise((res) => {
          ctl.wake = res;
          ctl.timer = setTimeout(res, ms);
        });
      const auto = detectable
        ? (async () => {
            let clean = 0;
            while (!ctl.stopped) {
              await nap(500);
              if (ctl.stopped) return;
              const b = await adapter.detectBlocker(ctx).catch(() => blocker);
              clean = b ? 0 : clean + 1;
              if (clean >= 2) return;
            }
          })()
        : new Promise<void>(() => undefined);
      await Promise.race([enter.promise, auto]);
      ctl.stopped = true;
      clearTimeout(ctl.timer);
      ctl.wake?.();
      enter.cancel();
      if (detectable) await auto; // la boucle est terminée avant de reprendre : aucune action concurrente
    }
    this.ackUntil.set(blocker.state, this.d.clock.now() + HUMAN_ACK_MS);
    this.state = before; // retour à l'état précédent (le blocage est levé)
    this.log.info("Reprise du bot.");
  }

  private async finish(result: RunResult): Promise<void> {
    const { config, ctx } = this.d;
    await this.d.onFinish?.();
    const opts = config.notifications;

    if (result.status === "blocked") {
      this.notify({
        title: "⛔ Arrêt du bot",
        message: `${result.blocker?.message ?? "Blocage"}. Le bot ne contourne pas les limites du site : vérifiez votre compte/panier manuellement.`,
        ...opts,
      });
    } else if (result.status === "error") {
      this.notify({ title: "❌ Erreur du bot", message: `Raison : ${result.failureReason}. Consultez les logs.`, ...opts });
    } else if (result.status === "sale-timeout") {
      this.notify({
        title: "⏱️ Aucun panier obtenu",
        message: `Raison : ${result.failureReason} (état ${result.finalState}). Aucune offre correspondant à vos critères n'a pu être ajoutée.`,
        ...opts,
      });
    } else {
      await ctx.page.bringToFront().catch(() => undefined);
      if (result.status === "ready-not-added") {
        this.notify({
          title: "🎟️ Offre sélectionnée (non ajoutée)",
          message: `${result.offer?.category} — ${result.offer?.pricePerTicket} ${result.offer?.currency}/billet. Ajoutez au panier manuellement.`,
          ...opts,
        });
      } else if (result.status === "cart-mismatch") {
        this.notify({
          title: "⚠️ PANIER À VÉRIFIER — ne payez pas sans contrôle",
          message: `Des billets ont été ajoutés mais le panier n'est pas conforme à votre demande : ${(result.problems ?? []).join("; ")}.`,
          ...opts,
        });
      } else {
        // La notification « PANIER OBTENU » est partie dès l'ajout ; on journalise ici le détail vérifié.
        const c = result.cart;
        if (c) {
          const expiry = c.expiresAt ? ` — réservation jusqu'à ${new Date(c.expiresAt).toLocaleTimeString()}` : "";
          this.log.info(`Panier vérifié : ${c.itemCount} billet(s), total ${c.totalPrice} ${c.currency}${expiry}`);
        }
      }
    }

    const m = result.telemetry.metrics;
    const fmt = (v: number | null): string => (v === null ? "—" : `${v} ms`);
    this.log.info(
      `Bilan : ${result.finalState}${result.failureReason ? ` (${result.failureReason})` : ""} · disponibilité T+${fmt(m.timeToAvailabilityMs)} · sélection +${fmt(m.timeToSelectionMs)} · panier T+${fmt(m.timeToCartMs)} · tentatives ${m.attempts}`,
    );
    this.log.debug(`Chronologie :\n${result.timeline.map((t) => `  ${t.name.padEnd(22)} T+${t.tMs} ms`).join("\n")}`);
    result.telemetryFile = this.telemetry.save(result.telemetry);
    if (result.telemetryFile) this.log.info(`Télémétrie locale : ${result.telemetryFile}`);
    await Promise.allSettled(this.pending); // les notifications ont fini d'être envoyées avant de rendre la main
  }
}
