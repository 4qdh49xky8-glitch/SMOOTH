import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { CANONICAL_OFFERS, optionsForScenario, type FixtureOffer, type FixtureSiteOptions, type FixtureSkin } from "./scenarios.js";

/**
 * TEST_ONLY · NOT_A_REAL_PLATFORM — faux site de billetterie, local (127.0.0.1), configurable par scénario.
 * Il sert aux fixtures des futurs adaptateurs et au site de démonstration (demo/server.ts). Il n'implémente AUCUN paiement :
 * la page /payment ne fait que compter les requêtes (`paymentHits`, doit rester 0 tant que le bot tourne).
 *
 * Routes : /login (GET/POST) · /account · /event · /event/offers/:id · /api/event.json · /api/offers · /api/time · /cart/add · /cart ·
 * /payment · /__state. Chaque requête est consignée (méthode + chemin, jamais les paramètres ni les cookies) dans `state.requests`.
 */
export interface FixtureState {
  cart: { offerId: string; label: string; quantity: number; unitPrice: number; expiresAt: number }[];
  addAttempts: number;
  /** Requêtes reçues sur /payment : DOIT rester 0 tant que le bot tourne. */
  paymentHits: number;
  loggedIn: Set<string>;
  /** « MÉTHODE /chemin » de chaque requête reçue (sans paramètres). */
  requests: string[];
}

export interface FixtureSite {
  url: string;
  server: Server;
  state: FixtureState;
  close(): Promise<void>;
}

export const DEFAULT_CREDENTIALS = { email: "demo@example.com", password: "demo" } as const;

export const defaultSkin: FixtureSkin = {
  page: (title, body, head = "") =>
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body style="font-family:sans-serif;max-width:720px;margin:2rem auto">${body}</body></html>`,
  login: () =>
    `<h1>Connexion</h1><form method="post" action="/login">
        <p><input data-testid="login-email" name="email" type="email" placeholder="email"></p>
        <p><input data-testid="login-password" name="password" type="password" placeholder="mot de passe"></p>
        <button data-testid="login-submit" type="submit">Se connecter</button></form>`,
  account: () => `<h1>Mon compte</h1><p data-testid="account-name">Démo Utilisateur</p>`,
  event: ({ open, soldOut, offers }) => {
    const list = !open
      ? "<li>Vente non ouverte</li>"
      : soldOut
        ? `<li data-testid="sold-out">Complet — plus aucune place disponible</li>`
        : offers.map((o) => `<li data-testid="offer" data-offer-id="${o.id}"><a href="/event/offers/${o.id}">${o.category} — ${o.price} €</a></li>`).join("");
    return `<h1>Concert démo — Stade de démonstration</h1><p id="sale-status">${open ? (soldOut ? "Vente ouverte — complet" : "Vente ouverte") : "Vente non ouverte"}</p><ul>${list}</ul>`;
  },
  offer: (o) => {
    const options = Array.from({ length: o.available }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("");
    return `<h1>${o.category}</h1><p>${o.price} € / billet — bloc ${o.section}, rang ${o.row}, sièges ${o.seats.join(", ")}</p>
        <form method="post" action="/cart/add"><input type="hidden" name="offer" value="${o.id}">
        <select data-testid="quantity" name="quantity">${options}</select>
        <button data-testid="add-to-cart" type="submit">Ajouter au panier</button></form>`;
  },
  cart: ({ items, total, expiresAt }) => {
    const rows = items.map((i) => `<li data-testid="cart-item" data-quantity="${i.quantity}" data-unit-price="${i.unitPrice}">${i.quantity} × ${i.label} — ${i.unitPrice} €</li>`).join("");
    return `<div data-testid="cart" data-total="${total}" data-expires-at="${expiresAt}"><h1>Panier</h1><ul>${rows || "<li>Vide</li>"}</ul>
        <p>Total : ${total} €</p><a data-testid="pay" href="/payment">Payer</a></div>`;
  },
  queue: () => `<h1 id="waiting-room" data-testid="waiting-room">Vous êtes dans la file d'attente</h1><p>Merci de patienter…</p>`,
  captcha: () => `<h1>Vérification</h1><div class="g-recaptcha" data-testid="captcha">Cochez la case pour continuer</div>`,
  blocked: () => `<h1>Access denied</h1><p>Unusual traffic detected from your network.</p>`,
  purchaseLimit: (limit) => `<h1>Panier</h1><p data-testid="error" role="alert">Vous avez atteint la limite d'achat (${limit} billet${limit > 1 ? "s" : ""} par commande).</p>`,
  contention: () => `<p data-testid="error" role="alert">Ces billets viennent d'être vendus.</p>`,
  payment: () => "<h1>Paiement (démo) — à effectuer manuellement</h1>",
};

export function startFixtureSite(input: FixtureSiteOptions = {}): Promise<FixtureSite> {
  const opts: FixtureSiteOptions = { ...optionsForScenario(input.scenario ?? "nominal"), ...input };
  const skin: FixtureSkin = { ...defaultSkin, ...opts.skin };
  const offers: readonly FixtureOffer[] = opts.offers ?? CANONICAL_OFFERS;
  const creds = opts.credentials ?? DEFAULT_CREDENTIALS;
  const requireLogin = opts.requireLogin ?? true;
  const openAt = opts.openAt ?? Date.now() - 1000;
  const state: FixtureState = { cart: [], addAttempts: 0, paymentHits: 0, loggedIn: new Set(), requests: [] };

  const since = (): number => Date.now() - openAt;
  const isOpen = (): boolean => since() >= 0;
  const inWindow = (ms: number | undefined): boolean => isOpen() && since() < (ms ?? 0);
  const sid = (req: IncomingMessage): string | undefined => /(?:^|; )sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
  const authed = (req: IncomingMessage): boolean => {
    const s = sid(req);
    return !!s && state.loggedIn.has(s);
  };
  const send = (res: ServerResponse, code: number, body: string, type = "text/html; charset=utf-8", headers: Record<string, string> = {}): void => {
    res.writeHead(code, { "content-type": type, ...headers });
    res.end(body);
  };
  const html = (res: ServerResponse, code: number, title: string, body: string, head = ""): void => send(res, code, skin.page(title, body, head));
  const json = (res: ServerResponse, code: number, data: unknown): void => send(res, code, JSON.stringify(data), "application/json");
  const redirect = (res: ServerResponse, to: string, headers: Record<string, string> = {}): void => {
    res.writeHead(302, { location: to, ...headers });
    res.end();
  };
  const readBody = (req: IncomingMessage): Promise<URLSearchParams> =>
    new Promise((resolve) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => resolve(new URLSearchParams(data)));
    });
  const visible = (): readonly FixtureOffer[] => (opts.soldOut ? [] : offers);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    if (!path.startsWith("/__")) state.requests.push(`${req.method} ${path}`);

    if (path === "/payment") state.paymentHits++; // compté dès l'arrivée de la requête, connecté ou non
    if (path === "/api/time") return json(res, 200, { now: Date.now() });
    if (path === "/__state") return json(res, 200, { cart: state.cart, addAttempts: state.addAttempts, paymentHits: state.paymentHits });
    if (path === "/api/event.json") return json(res, 200, { name: "Concert démo", open: isOpen(), soldOut: !!opts.soldOut });

    if (path === "/login" && req.method === "GET") return html(res, 200, "Connexion", skin.login());
    if (path === "/login" && req.method === "POST") {
      const form = await readBody(req);
      if (form.get("email") === creds.email && form.get("password") === creds.password) {
        const id = Math.random().toString(36).slice(2);
        state.loggedIn.add(id);
        return redirect(res, "/account", { "set-cookie": `sid=${id}; Path=/; HttpOnly` });
      }
      return html(res, 401, "Erreur", "<p>Identifiants invalides</p>");
    }

    const publicPath = !requireLogin && (path === "/event" || path.startsWith("/event/offers/") || path === "/api/offers");
    if (!authed(req) && path !== "/api/offers" && !publicPath) return redirect(res, "/login");

    if (path === "/account") return html(res, 200, "Compte", skin.account());

    if (path === "/api/offers") {
      if (!authed(req) && requireLogin) return json(res, 401, { error: "auth" });
      const open = isOpen();
      return json(res, 200, { open, soldOut: open && !!opts.soldOut, offers: open ? visible().map((o) => ({ ...o, currency: "EUR", url: `/event/offers/${o.id}` })) : [] });
    }

    if (path === "/event" || path.startsWith("/event/offers/")) {
      if (inWindow(opts.queueMs)) return html(res, 200, "Salle d'attente", skin.queue(), `<meta http-equiv="refresh" content="1">`);
      if (inWindow(opts.captchaMs)) return html(res, 200, "Vérification", skin.captcha());
      if (inWindow(opts.blockedMs)) return html(res, 403, "Accès refusé", skin.blocked());
      if (path === "/event") return html(res, 200, "Concert démo", skin.event({ open: isOpen(), soldOut: !!opts.soldOut, offers: visible() }));
      const offer = offers.find((o) => o.id === path.split("/").pop());
      if (!offer || !isOpen() || opts.soldOut) return html(res, 404, "Introuvable", "<p>Offre introuvable</p>");
      return html(res, 200, offer.category, skin.offer(offer));
    }

    if (path === "/cart/add" && req.method === "POST") {
      const form = await readBody(req);
      state.addAttempts++;
      const offer = offers.find((o) => o.id === form.get("offer"));
      const quantity = Number(form.get("quantity"));
      if (!offer) return html(res, 404, "Erreur", "<p>Offre inconnue</p>");
      if (opts.contention && state.addAttempts === 1) return html(res, 409, "Indisponible", skin.contention());
      if (opts.purchaseLimit !== undefined && quantity > opts.purchaseLimit) return html(res, 403, "Limite d'achat", skin.purchaseLimit(opts.purchaseLimit));
      const stored = opts.cartMismatch ? Math.max(1, quantity - 1) : quantity;
      state.cart = [{ offerId: offer.id, label: `${offer.category} bloc ${offer.section} rang ${offer.row}`, quantity: stored, unitPrice: offer.price, expiresAt: Date.now() + 10 * 60_000 }];
      return redirect(res, "/cart");
    }

    if (path === "/cart") {
      const total = state.cart.reduce((n, i) => n + i.quantity * i.unitPrice, 0);
      return html(res, 200, "Panier", skin.cart({ items: state.cart, total, expiresAt: state.cart[0]?.expiresAt ?? 0 }));
    }

    if (path === "/payment") return html(res, 200, "Paiement", skin.payment());
    html(res, 404, "404", "<p>Introuvable</p>");
  });

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        server,
        state,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}
