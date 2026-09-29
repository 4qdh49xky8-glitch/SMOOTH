import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

export interface DemoOptions {
  port?: number;
  /** Epoch ms d'ouverture de la vente. */
  openAt: number;
  /** Simule une salle d'attente sur les PAGES pendant N ms après l'ouverture (test du passage de main). */
  queueMs?: number;
  /** La 1re tentative d'ajout au panier échoue (« déjà vendu ») : teste le repli sur l'offre suivante. */
  contention?: boolean;
}

interface Offer {
  id: string;
  category: string;
  price: number;
  available: number;
  section: string;
  row: string;
  seats: string[];
}

const OFFERS: Offer[] = [
  { id: "o1", category: "Catégorie 1", price: 189, available: 4, section: "A", row: "3", seats: ["11", "12", "13", "14"] }, // trop cher
  { id: "o2", category: "Catégorie 2", price: 139, available: 2, section: "B", row: "7", seats: ["5", "6"] }, // idéale
  { id: "o3", category: "Catégorie 2", price: 129, available: 2, section: "B", row: "9", seats: ["8", "20"] }, // pas côte à côte
  { id: "o4", category: "Catégorie 3", price: 99, available: 1, section: "C", row: "2", seats: ["4"] }, // quantité insuffisante
  { id: "o5", category: "Catégorie 4", price: 79, available: 6, section: "D", row: "1", seats: ["1", "2", "3", "4", "5", "6"] }, // catégorie refusée
  { id: "o6", category: "Catégorie 3", price: 120, available: 2, section: "C", row: "5", seats: ["30", "31"] }, // repli si o2 vendue
];

const page = (title: string, body: string, head = ""): string =>
  `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body style="font-family:sans-serif;max-width:720px;margin:2rem auto">${body}</body></html>`;

export function startDemoServer(opts: DemoOptions): Promise<{ url: string; server: Server; state: State; close: () => Promise<void> }> {
  const state: State = { cart: [], addAttempts: 0, paymentHits: 0, loggedIn: new Set() };
  const isOpen = (): boolean => Date.now() >= opts.openAt;
  const inQueue = (): boolean => isOpen() && Date.now() < opts.openAt + (opts.queueMs ?? 0);
  const sid = (req: IncomingMessage): string | undefined => /(?:^|; )sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
  const authed = (req: IncomingMessage): boolean => {
    const s = sid(req);
    return !!s && state.loggedIn.has(s);
  };
  const send = (res: ServerResponse, code: number, body: string, type = "text/html; charset=utf-8", headers: Record<string, string> = {}): void => {
    res.writeHead(code, { "content-type": type, ...headers });
    res.end(body);
  };
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

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;

    if (path === "/payment") state.paymentHits++; // compté dès l'arrivée de la requête, connecté ou non
    if (path === "/api/time") return json(res, 200, { now: Date.now() });
    if (path === "/__state") return json(res, 200, { cart: state.cart, addAttempts: state.addAttempts, paymentHits: state.paymentHits });

    if (path === "/login" && req.method === "GET") {
      return send(res, 200, page("Connexion", `<h1>Connexion</h1><form method="post" action="/login">
        <p><input data-testid="login-email" name="email" type="email" placeholder="email"></p>
        <p><input data-testid="login-password" name="password" type="password" placeholder="mot de passe"></p>
        <button data-testid="login-submit" type="submit">Se connecter</button></form>`));
    }
    if (path === "/login" && req.method === "POST") {
      const form = await readBody(req);
      if (form.get("email") === "demo@example.com" && form.get("password") === "demo") {
        const id = Math.random().toString(36).slice(2);
        state.loggedIn.add(id);
        return redirect(res, "/account", { "set-cookie": `sid=${id}; Path=/; HttpOnly` });
      }
      return send(res, 401, page("Erreur", "<p>Identifiants invalides</p>"));
    }

    if (!authed(req) && path !== "/api/offers") return redirect(res, "/login");

    if (path === "/account") return send(res, 200, page("Compte", `<h1>Mon compte</h1><p data-testid="account-name">Démo Utilisateur</p>`));

    if (path === "/api/offers") {
      if (!authed(req)) return json(res, 401, { error: "auth" });
      const open = isOpen();
      return json(res, 200, {
        open,
        offers: open ? OFFERS.map((o) => ({ ...o, currency: "EUR", url: `/event/offers/${o.id}` })) : [],
      });
    }

    if (path === "/event" || path.startsWith("/event/offers/")) {
      if (inQueue()) {
        return send(res, 200, page("Salle d'attente", `<h1 id="waiting-room" data-testid="waiting-room">Vous êtes dans la file d'attente</h1><p>Merci de patienter…</p>`, `<meta http-equiv="refresh" content="1">`));
      }
      if (path === "/event") {
        const list = isOpen()
          ? OFFERS.map((o) => `<li data-testid="offer" data-offer-id="${o.id}"><a href="/event/offers/${o.id}">${o.category} — ${o.price} €</a></li>`).join("")
          : "<li>Vente non ouverte</li>";
        return send(res, 200, page("Concert démo", `<h1>Concert démo — Stade de démonstration</h1><p id="sale-status">${isOpen() ? "Vente ouverte" : "Vente non ouverte"}</p><ul>${list}</ul>`));
      }
      const offer = OFFERS.find((o) => o.id === path.split("/").pop());
      if (!offer || !isOpen()) return send(res, 404, page("Introuvable", "<p>Offre introuvable</p>"));
      const options = Array.from({ length: offer.available }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("");
      return send(res, 200, page(offer.category, `<h1>${offer.category}</h1><p>${offer.price} € / billet — bloc ${offer.section}, rang ${offer.row}, sièges ${offer.seats.join(", ")}</p>
        <form method="post" action="/cart/add"><input type="hidden" name="offer" value="${offer.id}">
        <select data-testid="quantity" name="quantity">${options}</select>
        <button data-testid="add-to-cart" type="submit">Ajouter au panier</button></form>`));
    }

    if (path === "/cart/add" && req.method === "POST") {
      const form = await readBody(req);
      state.addAttempts++;
      const offer = OFFERS.find((o) => o.id === form.get("offer"));
      const quantity = Number(form.get("quantity"));
      if (!offer) return send(res, 404, page("Erreur", "<p>Offre inconnue</p>"));
      if (opts.contention && state.addAttempts === 1) {
        return send(res, 409, page("Indisponible", `<p data-testid="error" role="alert">Ces billets viennent d'être vendus.</p>`));
      }
      state.cart = [{ offerId: offer.id, label: `${offer.category} bloc ${offer.section} rang ${offer.row}`, quantity, unitPrice: offer.price, expiresAt: Date.now() + 10 * 60_000 }];
      return redirect(res, "/cart");
    }

    if (path === "/cart") {
      const total = state.cart.reduce((n, i) => n + i.quantity * i.unitPrice, 0);
      const exp = state.cart[0]?.expiresAt ?? 0;
      const items = state.cart
        .map((i) => `<li data-testid="cart-item" data-quantity="${i.quantity}" data-unit-price="${i.unitPrice}">${i.quantity} × ${i.label} — ${i.unitPrice} €</li>`)
        .join("");
      return send(res, 200, page("Panier", `<div data-testid="cart" data-total="${total}" data-expires-at="${exp}"><h1>Panier</h1><ul>${items || "<li>Vide</li>"}</ul>
        <p>Total : ${total} €</p><a data-testid="pay" href="/payment">Payer</a></div>`));
    }

    if (path === "/payment") return send(res, 200, page("Paiement", "<h1>Paiement (démo) — à effectuer manuellement</h1>"));
    send(res, 404, page("404", "<p>Introuvable</p>"));
  });

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        server,
        state,
        close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
      });
    });
  });
}

interface State {
  cart: { offerId: string; label: string; quantity: number; unitPrice: number; expiresAt: number }[];
  addAttempts: number;
  /** Nombre de requêtes reçues sur la page de paiement : doit rester 0 tant que le bot tourne. */
  paymentHits: number;
  loggedIn: Set<string>;
}

// Lancement manuel : npm run demo:server -- [secondes avant ouverture] [--queue=8] [--contention]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const secs = Number(args.find((a) => /^\d+$/.test(a)) ?? 30);
  const queue = Number(args.find((a) => a.startsWith("--queue="))?.split("=")[1] ?? 0);
  const openAt = Math.ceil((Date.now() + secs * 1000) / 1000) * 1000;
  startDemoServer({ port: 4173, openAt, queueMs: queue * 1000, contention: args.includes("--contention") }).then((s) => {
    console.log(`Site démo : ${s.url}/event  (identifiants demo@example.com / demo)`);
    console.log(`Ouverture de la vente : ${new Date(openAt).toISOString()}  → saleTime à mettre dans la config : ${new Date(openAt).toISOString()}`);
  });
}
