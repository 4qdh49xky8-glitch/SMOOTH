/**
 * TEST_ONLY · NOT_A_REAL_PLATFORM — faux serveur pretix EN MÉMOIRE (faux `fetch`) : aucune requête réseau réelle, aucun vrai jeton.
 * Reproduit la FORME des ressources documentées utilisées (événement, items, catégories, quotas, disponibilité d'un quota, commandes
 * avec `simulate`). Les détails non établis par les sources officielles fournies (en-tête d'idempotence, champs exacts des réponses)
 * sont une HYPOTHÈSE de fixture : à valider sur une instance de test réelle (docs/PRETIX.md, NOT_ESTABLISHED).
 */
export interface FakeItem {
  id: number;
  name: string;
  category?: number | null;
  price: string;
  admission?: boolean;
  active?: boolean;
  min_per_order?: number | null;
  max_per_order?: number | null;
  variations?: { id: number; value: string; price?: string }[];
}
export interface FakePretixOptions {
  organizer?: string;
  event?: string;
  token?: string;
  live?: boolean;
  currency?: string;
  categories?: { id: number; name: string }[];
  items?: FakeItem[];
  quotas?: { id: number; items: number[]; variations?: number[]; available: boolean; number: number | null }[];
  /** 401 / 403 sur toutes les requêtes. */
  authFail?: 401 | 403;
  notFound?: boolean;
  malformed?: "items" | "availability" | "order" | "event";
  /** 429 + Retry-After sur les N premières requêtes dont le chemin correspond. */
  rateLimit?: { path: RegExp; times: number; retryAfter: string };
  /** Statut de la commande relue (n pending, p paid, e expired, c canceled). */
  orderStatus?: string;
  /** Commande créée incohérente : moins de positions, ou total différent. */
  inconsistent?: "short" | "total";
  /** Expiration de la commande (ISO). */
  expires?: string;
  /** La création de commande échoue par coupure (résultat incertain). */
  dropCreate?: boolean;
}
export interface FakeCall {
  method: string;
  host: string;
  path: string;
  authOk: boolean;
  idempotencyKey?: string;
  body?: Record<string, unknown>;
}
export interface FakePretix {
  fetchImpl: typeof fetch;
  calls: FakeCall[];
  orders: Map<string, { status: string; total: string; positions: { item: number; variation: number | null; price: string }[]; expires: string }>;
  /** Commandes réellement créées (hors simulation). */
  created: () => number;
  simulations: () => number;
  paymentRequests: () => FakeCall[];
  opts: FakePretixOptions;
}

export const FAKE_TOKEN = "FAKE-PRETIX-TOKEN-0000000000000000";
const PAYMENTISH = /payments?|mark_paid|mark_[a-z]+|refund|confirm|transition|execute/i;

export function fakePretix(o: FakePretixOptions = {}): FakePretix {
  const organizer = o.organizer ?? "demo-org";
  const event = o.event ?? "demo-event";
  const token = o.token ?? FAKE_TOKEN;
  const items: FakeItem[] = o.items ?? [
    { id: 1, name: "Standard", category: 10, price: "40.00" },
    { id: 2, name: "VIP", category: 11, price: "120.00" },
  ];
  const quotas = o.quotas ?? [
    { id: 100, items: [1], available: true, number: 50 },
    { id: 101, items: [2], available: true, number: 10 },
  ];
  const categories = o.categories ?? [{ id: 10, name: "Standard" }, { id: 11, name: "VIP" }];
  const calls: FakeCall[] = [];
  const orders: FakePretix["orders"] = new Map();
  const byKey = new Map<string, string>();
  let sims = 0;
  let n = 0;
  const limited = new Map<RegExp, number>();
  if (o.rateLimit) limited.set(o.rateLimit.path, o.rateLimit.times);
  const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const base = `/api/v1/organizers/${organizer}/events/${event}`;
  const page = <T>(results: T[]): unknown => ({ count: results.length, next: null, previous: null, results });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const h = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, host: url.hostname, path: url.pathname, authOk: h.authorization === `Token ${token}`, idempotencyKey: h["X-Idempotency-Key"], body });
    const path = url.pathname;
    if (PAYMENTISH.test(path)) return json(404, { detail: "Not found." });
    if (o.authFail === 401 || h.authorization !== `Token ${token}`) return json(401, { detail: "Authentication credentials were not provided." });
    if (o.authFail === 403) return json(403, { detail: "You do not have permission to perform this action." });
    if (o.notFound) return json(404, { detail: "Not found." });
    if (o.rateLimit) {
      for (const [re, left] of limited) if (left > 0 && re.test(path)) return limited.set(re, left - 1), json(429, { detail: "Request was throttled." }, { "retry-after": o.rateLimit.retryAfter });
    }
    if (path === `${base}/`) return o.malformed === "event" ? json(200, "nope") : json(200, { slug: event, name: { en: "Demo" }, live: o.live ?? true, currency: o.currency ?? "EUR", presale_start: null, presale_end: null });
    if (path === `${base}/items/`) {
      if (o.malformed === "items") return json(200, { results: "x" });
      return json(200, page(items.map((i) => ({ id: i.id, name: { en: i.name }, category: i.category ?? null, active: i.active ?? true, admission: i.admission ?? true, default_price: i.price, min_per_order: i.min_per_order ?? null, max_per_order: i.max_per_order ?? null, available_from: null, available_until: null, variations: (i.variations ?? []).map((v) => ({ id: v.id, value: { en: v.value }, active: true, default_price: v.price ?? null })) }))));
    }
    if (path === `${base}/categories/`) return json(200, page(categories.map((c) => ({ id: c.id, name: { en: c.name } }))));
    if (path === `${base}/quotas/`) return json(200, page(quotas.map((q) => ({ id: q.id, name: `Quota ${q.id}`, items: q.items, variations: q.variations ?? [] }))));
    const av = path.match(new RegExp(`^${base}/quotas/(\\d+)/availability/$`));
    if (av) {
      const q = quotas.find((x) => x.id === Number(av[1]));
      if (!q) return json(404, { detail: "Not found." });
      return o.malformed === "availability" ? json(200, { available: "maybe" }) : json(200, { available: q.available, available_number: q.number });
    }
    if (path === `${base}/orders/` && method === "POST") {
      if (o.dropCreate && !body?.simulate) throw new TypeError("fetch failed");
      const positions = (body?.positions ?? []) as { item: number; variation?: number }[];
      const item = items.find((i) => i.id === positions[0]?.item);
      if (!item || positions.length === 0) return json(400, { positions: ["invalid"] });
      if (item.max_per_order && positions.length > item.max_per_order) return json(400, { positions: ["max_per_order"] });
      const q = quotas.find((x) => x.items.includes(item.id));
      if (!q || !q.available || (q.number !== null && positions.length > q.number)) return json(400, { positions: ["quota exhausted"] });
      const unit = item.price;
      const total = o.inconsistent === "total" ? "1.00" : (Number(unit) * positions.length).toFixed(2);
      const lines = positions.map((p) => ({ item: p.item, variation: p.variation ?? null, price: unit }));
      const shown = o.inconsistent === "short" ? lines.slice(0, Math.max(1, lines.length - 1)) : lines;
      if (body?.simulate) {
        sims++;
        return json(201, o.malformed === "order" ? { total: "x" } : { code: "", status: "n", total, positions: shown, fees: [], expires: null });
      }
      const key = h["X-Idempotency-Key"];
      if (key && byKey.has(key)) {
        const c = byKey.get(key)!;
        return json(201, { code: c, ...orders.get(c) });
      }
      const code = `AB${String(++n).padStart(3, "0")}`;
      const status = o.orderStatus ?? "n";
      orders.set(code, { status, total, positions: shown, expires: o.expires ?? new Date(Date.now() + 30 * 60_000).toISOString() });
      if (key) byKey.set(key, code);
      return o.malformed === "order" ? json(201, { total: "x" }) : json(201, { code, ...orders.get(code), fees: [] });
    }
    const one = path.match(new RegExp(`^${base}/orders/([A-Z0-9]+)/$`));
    if (one && method === "GET") {
      const ord = orders.get(one[1]!);
      return ord ? json(200, { code: one[1], ...ord, fees: [] }) : json(404, { detail: "Not found." });
    }
    return json(404, { detail: "Not found." });
  }) as typeof fetch;

  return { fetchImpl, calls, orders, created: () => orders.size, simulations: () => sims, paymentRequests: () => calls.filter((c) => PAYMENTISH.test(c.path)), opts: o };
}
