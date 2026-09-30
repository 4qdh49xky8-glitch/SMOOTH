/**
 * Horodatages du chemin critique (INSTANT-ON-SALE). Horloge monotone (`performance.now`) rapportée à l'époque murale : les durées ne
 * sont pas faussées par un changement d'heure système.
 */
export const EVENTS = [
  "T_PREPARE_START",
  "T_BROWSER_READY",
  "T_EVENT_START",
  "T_EVENT_READY",
  "T_SALE_START",
  "T_FIRST_POLL",
  "T_AVAILABILITY_DETECTED",
  "T_OFFER_SELECTED",
  "T_CART_REQUEST",
  "T_CART_SUCCESS",
] as const;
export type TimelineEvent = (typeof EVENTS)[number];

export const wallNow = (): number => performance.timeOrigin + performance.now();

export class Timeline {
  private readonly t = new Map<TimelineEvent, number>();
  private readonly listeners: ((e: TimelineEvent, at: number) => void)[] = [];
  /** Observateur (journal minimal) : appelé à chaque enregistrement effectif. */
  onMark(cb: (e: TimelineEvent, at: number) => void): void {
    this.listeners.push(cb);
  }
  /** Enregistre un événement (`overwrite=false` : le premier l'emporte). */
  mark(e: TimelineEvent, at = wallNow(), overwrite = false): void {
    if (overwrite || !this.t.has(e)) {
      this.t.set(e, at);
      for (const cb of this.listeners) cb(e, at);
    }
  }
  clear(e: TimelineEvent): void {
    this.t.delete(e);
  }
  get(e: TimelineEvent): number | undefined {
    return this.t.get(e);
  }
  /** Durée entre deux événements (ms, 0,1 ms près), ou null si l'un manque. */
  between(a: TimelineEvent, b: TimelineEvent): number | null {
    const x = this.t.get(a);
    const y = this.t.get(b);
    return x === undefined || y === undefined ? null : Math.round((y - x) * 10) / 10;
  }
  snapshot(): Partial<Record<TimelineEvent, number>> {
    return Object.fromEntries(this.t);
  }
}

export interface InstantTimings {
  prepare_to_browser_ready: number | null;
  event_prepare: number | null;
  sale_open_to_first_poll: number | null;
  sale_open_to_availability: number | null;
  availability_to_selection: number | null;
  selection_to_cart_request: number | null;
  cart_request_to_cart_success: number | null;
  total_sale_open_to_cart: number | null;
}

export function timingsOf(tl: Timeline): InstantTimings {
  return {
    prepare_to_browser_ready: tl.between("T_PREPARE_START", "T_BROWSER_READY"),
    event_prepare: tl.between("T_EVENT_START", "T_EVENT_READY"),
    sale_open_to_first_poll: tl.between("T_SALE_START", "T_FIRST_POLL"),
    sale_open_to_availability: tl.between("T_SALE_START", "T_AVAILABILITY_DETECTED"),
    availability_to_selection: tl.between("T_AVAILABILITY_DETECTED", "T_OFFER_SELECTED"),
    selection_to_cart_request: tl.between("T_OFFER_SELECTED", "T_CART_REQUEST"),
    cart_request_to_cart_success: tl.between("T_CART_REQUEST", "T_CART_SUCCESS"),
    total_sale_open_to_cart: tl.between("T_SALE_START", "T_CART_SUCCESS"),
  };
}
