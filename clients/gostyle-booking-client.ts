/**
 * Go Style booking API — TypeScript client for the single-booking flow.
 *
 * Zero dependencies. Uses the global `fetch`, so it runs in the browser,
 * Node 18+, Bun and Deno alike. Copy this file into the front end, or publish
 * the `clients/` folder as an internal package; it imports nothing from the
 * server.
 *
 * THE FLOW, in the order the screens need it:
 *
 *   catalogue()    what can be booked        (no token)
 *   availability() which starts are real     (no token)
 *   quote()        what it costs             (token)
 *   placeHold()    reserve it for 15 minutes (token)
 *   confirm()      take the deposit, book it (token + Idempotency-Key)
 *   getBooking()   the whole drawer          (token)
 *   checkIn() -> start() -> complete() -> settle()
 *
 * Availability is advice, a hold is a promise, and only confirm() creates
 * anything. Nothing is ever charged on an error path: every failure below
 * means no money moved.
 *
 * @see ./README.md for the walkthrough, the error table and the gotchas.
 */

/* ------------------------------------------------------------------ *
 * Vocabulary
 * ------------------------------------------------------------------ */

/**
 * Money is ALWAYS an integer in fils, the minor unit: 1 AED = 100 fils.
 * `24000` is AED 240.00. Never send a decimal; the server rejects a
 * fractional fil outright. Every money field also arrives with a formatted
 * twin (`depositMinor` / `deposit`) so the UI never has to divide.
 */
export type Minor = number;

/** Minutes from midnight in the branch timezone. 610 is 10:10, 1105 is 18:25. */
export type MinuteOfDay = number;

/** `YYYY-MM-DD`, the trading day in the branch timezone (Asia/Dubai). */
export type TradingDay = string;

export type BookingStatus =
  | 'DRAFT'
  | 'HELD'
  | 'PENDING_PAYMENT'
  | 'PENDING_CONFIRMATION'
  | 'CONFIRMED'
  | 'CHECKED_IN'
  | 'IN_SERVICE'
  | 'COMPLETED'
  | 'SETTLED'
  | 'CANCELLED'
  | 'NO_SHOW'
  | 'RESCHEDULED';

export type PaymentStatus =
  | 'NONE_REQUIRED'
  | 'UNPAID'
  | 'DEPOSIT_PAID'
  | 'FULLY_PAID'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED'
  | 'FORFEITED'
  | 'SETTLED';

export type PaymentRail = 'WALLET' | 'CARD' | 'APPLE_PAY' | 'CASH' | 'LINK';
export type Tier = 'NONE' | 'SILVER' | 'GOLD' | 'VIP' | 'ROYAL';
export type RequirementKind = 'NONE' | 'DEPOSIT' | 'FULL';
export type ActorKind = 'CUSTOMER' | 'STAFF' | 'MANAGER' | 'SYSTEM';
export type OfferBadge = 'EARLIEST' | 'SMART_PICK' | 'OVERLAP' | 'FLUSH';

/**
 * ONE WORD, TWO SPELLINGS, and sending the wrong one is a 400.
 *
 * `quote()` shouts its channel; `availability()`, `placeHold()` and
 * `confirm()` do not. That is the server's contract, not a bug to work
 * around, so both types exist and TypeScript will stop you crossing them.
 */
export type QuoteChannel = 'DESK' | 'ONLINE';
export type BookingChannel = 'desk' | 'online';

/* ------------------------------------------------------------------ *
 * Resources
 * ------------------------------------------------------------------ */

export interface CatalogueItem {
  id: string;
  name: string;
  skill: string;
  requiredLevel: number;
  durationMin: number;
  resourceType: string;
  /** Colour work leaves the chair free while it develops. */
  processing?: { fromMin: number; toMin: number };
}

export interface Person {
  id: string;
  name: string;
}

export interface Offer {
  startMin: MinuteOfDay;
  /** The same minute as a clock label, ready to render: "10:10". */
  start: string;
  endMin: MinuteOfDay;
  end: string;
  /** Everyone who could take this start. */
  staff: Person[];
}

export interface RankedOffer extends Offer {
  assignedTo: Person;
  badges: OfferBadge[];
  score: number;
  fragmentation: number;
  deltaCapacity: number;
  /** Plain English, so an offer row can explain itself. */
  why: string[];
}

export interface Availability {
  branchId: string;
  tradingDay: TradingDay;
  isToday: boolean;
  channel: string;
  grainMin: number;
  durationMin: number;
  count: number;
  /** The three to show first. */
  topOffers: RankedOffer[];
  /** Everything feasible, for a chip grid. */
  offers: Offer[];
  eligible: Person[];
  /**
   * WHY SOMEONE IS NOT OFFERED. An empty day with an empty `refusals` is a
   * bug worth reporting; an empty day with reasons is an answer worth
   * showing the customer.
   */
  refusals: { id: string; name: string; reason: string }[];
  closureReason?: string;
  computeMs: number;
}

export interface QuoteLine {
  label: string;
  amountMinor: Minor;
  negative: boolean;
  note?: string;
}

export interface Quote {
  branchId: string;
  tradingDay: TradingDay;
  startMin: MinuteOfDay;
  channel: QuoteChannel;
  tier: Tier;
  /** After any package expanded, in chain order. */
  serviceIds: string[];
  packages: { packageId: string; name: string; serviceIds: string[] }[];
  durationMin: number;

  subtotalMinor: Minor;
  subtotal: string;
  addOnMinor: Minor;
  bundleDiscountMinor: Minor;
  bundleDiscount: string;
  tierDiscountMinor: Minor;
  tierDiscount: string;
  /** What VAT is actually charged on. */
  discountedSubtotalMinor: Minor;
  discountedSubtotal: string;
  vatMinor: Minor;
  vat: string;
  totalMinor: Minor;
  total: string;

  /** The deposit, computed on the PRE-discount total. Send this to confirm(). */
  depositMinor: Minor;
  deposit: string;
  dueAtCheckoutMinor: Minor;
  dueAtCheckout: string;
  requirementSource: string;

  /** False inside the last two hours: do not offer the "pay by link" rail. */
  linkAvailable: boolean;
  linkUnavailableReason: string | null;
  linkExpiresAt: string | null;

  requirement: {
    kind: RequirementKind;
    source: string;
    clampNote?: string;
    /** Every rung, fired or not: the answer to "why was I charged this". */
    trace: { rung: string; evaluation: string; fired: boolean }[];
  };

  quote: QuoteLine[];
}

export interface Hold {
  holdId: string;
  /** ISO instant. Drive the countdown from THIS, not from expiresInSeconds. */
  expiresAt: string;
  expiresInSeconds: number;
  /** "14:58", already formatted for the first paint. */
  countdown: string;
  staff: Person;
  startMin: MinuteOfDay;
  start: string;
  endMin: MinuteOfDay;
  end: string;
  durationMin: number;
  /** Opaque. Proves the calendar had not moved when the hold was taken. */
  feasibilityToken: string;
}

export interface ConfirmedBooking {
  code: string;
  bookingId: string;
  status: BookingStatus;
  paymentStatus: PaymentStatus;
  start: string;
  end: string;
  durationMin: number;
  /** Net, exclusive of VAT. */
  totalNetMinor: Minor;
  totalNet: string;
  vatMinor: Minor;
  vat: string;
  /** Inclusive of VAT: the number on the receipt. */
  totalMinor: Minor;
  total: string;
  depositMinor: Minor;
  deposit: string;
  dueAtCheckoutMinor: Minor;
  dueAtCheckout: string;
  requirementSource: string | null;
  quote: QuoteLine[];
  /** True when this Idempotency-Key was seen before. Nothing was charged twice. */
  replayed: boolean;
}

export interface BookingDetail {
  bookingId: string;
  code: string;
  branchId: string;
  customerId: string;
  status: BookingStatus;
  paymentStatus: PaymentStatus;
  tradingDay: TradingDay;
  start: string;
  end: string;
  startMin: MinuteOfDay;
  durationMin: number;
  /** True instants, for a calendar view. */
  startAt: string;
  endAt: string;
  priceMinor: Minor;
  price: string;
  depositMinor: Minor;
  deposit: string;
  requirementSource: string | null;
  channel: string;
  moveCount: number;
  overbooked: boolean;
  overbookReason: string | null;
  linkExpiresAt: string | null;
  tenantId: string | null;
  createdAt: string;
  items: {
    position: number;
    serviceId: string;
    serviceName: string;
    staffId: string | null;
    resourceType: string;
    requiredSkill: string;
    priceMinor: Minor;
    durationMin: number;
  }[];
  /** The money, append-only, oldest first. */
  ledger: {
    entryType: string;
    amountMinor: Minor;
    rail: string | null;
    at: string;
  }[];
  history: {
    from: string | null;
    to: BookingStatus;
    reason: string | null;
    actorKind: ActorKind;
    at: string;
  }[];
}

export interface Receipt {
  subtotal: string;
  tierDiscount: string;
  promo: string;
  promoCode: string | null;
  promoPercent: number;
  base: string;
  tip: string;
  vat: string;
  depositApplied: string;
  loyaltyRedeem: string;
  due: string;
  credit: string;
  taxExempt: boolean;
}

export interface LifecycleResult {
  code: string;
  bookingId: string;
  from: BookingStatus;
  to: BookingStatus;
  paymentStatus: PaymentStatus | 'UNCHANGED';
  refund?: string;
  kept?: string;
  lateCancel?: boolean;
  /** The sentence to read to the customer. */
  explanation?: string;
  /** Present on settle. */
  receipt?: Receipt;
}

export interface PaymentLink {
  bookingId: string;
  code: string;
  status: BookingStatus;
  outstandingMinor: Minor;
  outstanding: string;
  expiresAt: string;
  expiresInSeconds: number;
  /** The half-time nudge, so the caller can schedule a reminder. */
  remindAt: string;
  cappedBy: 'SIX_HOURS' | 'START_MINUS_TWO';
  explanation: string;
}

export interface Health {
  status: 'ok' | 'degraded';
  database: string;
  databaseLatencyMs: number | null;
  uptimeSeconds: number;
  customerAuth?: {
    status: string;
    address: string;
    latencyMs: number | null;
    error?: string;
  };
}

/* ------------------------------------------------------------------ *
 * Requests
 * ------------------------------------------------------------------ */

export interface AvailabilityQuery {
  day: TradingDay;
  /** Service ids in the order the customer picked them. */
  services: string[];
  branch?: string;
  channel?: BookingChannel;
  /** Ask for one professional only. */
  staff?: string;
  /** Window, minutes from midnight. Defaults to the whole trading day. */
  from?: MinuteOfDay;
  to?: MinuteOfDay;
  /** Testing only: pretend the branch clock reads this minute. */
  now?: MinuteOfDay;
}

export interface QuoteRequest {
  day: TradingDay;
  serviceIds: string[];
  customerId: string;
  branchId?: string;
  /** SHOUTED here. See QuoteChannel. */
  channel?: QuoteChannel;
  /** Only the peak-window rung reads it, but it must still be plausible. */
  startMin?: MinuteOfDay;
}

export interface PlaceHoldRequest {
  day: TradingDay;
  services: string[];
  startMin: MinuteOfDay;
  branch?: string;
  /** Omit for "any available professional". */
  staffId?: string;
  customerId?: string;
  /** lower case here. See BookingChannel. */
  channel?: BookingChannel;
}

export interface ConfirmRequest {
  holdId: string;
  day: TradingDay;
  services: string[];
  branch?: string;
  customerId?: string;
  channel?: BookingChannel;
  /**
   * What was captured, in fils — normally `quote.depositMinor`.
   *
   * amountMinor AND rail travel together: send one without the other and the
   * server records no payment at all, leaving the booking unpaid with no
   * error to tell you. Omit both only when the requirement was NONE.
   */
  amountMinor?: Minor;
  rail?: PaymentRail;
  /** The gateway's own id for the capture. Must be unique: reusing one is a 409. */
  gatewayRef?: string;
}

export interface SettleRequest {
  /** Retail sold at the register, in fils. */
  retailMinor?: Minor;
  tipPercent?: number;
  tipMinor?: Minor;
  loyaltyRedeemMinor?: Minor;
  promo?: { code: string; percent?: number };
  taxExemptReason?: string;
  rail?: string;
  reason?: string;
}

export interface LifecycleRequest {
  reason?: string;
  /** Cancel only. */
  initiatedBy?: 'CUSTOMER' | 'SALON';
  /** No-show only: waives the fee by rule. */
  vipStandingReservation?: boolean;
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/**
 * Every failure the API reports. `status` is the HTTP code, `message` is the
 * server's sentence — written to be shown to a human, so prefer it over
 * inventing your own copy.
 */
export class BookingApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
    readonly method: string,
    readonly path: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 400. `details` carries class-validator's per-field messages. */
export class ValidationError extends BookingApiError {
  get details(): string[] {
    const m = (this.body as { message?: unknown } | null)?.message;
    return Array.isArray(m) ? m.map(String) : [this.message];
  }
}

/** 401. No token, expired token, or a signature that does not verify. */
export class UnauthorizedError extends BookingApiError {}

/** 403. A customer token on a desk-only route. Signing in again cannot help. */
export class ForbiddenError extends BookingApiError {}

/** 404. */
export class NotFoundError extends BookingApiError {}

/**
 * 409. Someone else took the slot, or the payment reference is already
 * recorded. Nothing was charged. Re-run availability() and offer new times.
 */
export class ConflictError extends BookingApiError {}

/**
 * 410. The hold is gone — expired or released. Nothing was charged, and the
 * slot may well still be free: re-run availability() and hold again.
 */
export class HoldExpiredError extends BookingApiError {}

/** 422. The request was understood and refused for a stated reason. */
export class UnprocessableError extends BookingApiError {}

/**
 * 503. A dependency this API needs is down — customer authentication, in
 * practice. Staff tokens keep working; retry later rather than reporting a
 * booking fault.
 */
export class DependencyUnavailableError extends BookingApiError {}

/** The request never produced a response: offline, DNS, CORS, timeout. */
export class NetworkError extends BookingApiError {
  constructor(message: string, method: string, path: string, cause?: unknown) {
    super(0, message, cause ?? null, method, path);
  }
}

function errorFor(
  status: number,
  message: string,
  body: unknown,
  method: string,
  path: string,
): BookingApiError {
  const args = [status, message, body, method, path] as const;
  switch (status) {
    case 400:
      return new ValidationError(...args);
    case 401:
      return new UnauthorizedError(...args);
    case 403:
      return new ForbiddenError(...args);
    case 404:
      return new NotFoundError(...args);
    case 409:
      return new ConflictError(...args);
    case 410:
      return new HoldExpiredError(...args);
    case 422:
      return new UnprocessableError(...args);
    case 503:
      return new DependencyUnavailableError(...args);
    default:
      return new BookingApiError(...args);
  }
}

/** Narrowing helper: the hold died, so start again from availability. */
export const isHoldExpired = (e: unknown): e is HoldExpiredError =>
  e instanceof HoldExpiredError;

/** Narrowing helper: someone else got there first. Nothing was charged. */
export const isConflict = (e: unknown): e is ConflictError =>
  e instanceof ConflictError;

/* ------------------------------------------------------------------ *
 * Client
 * ------------------------------------------------------------------ */

export interface BookingClientOptions {
  /** Origin only, no /v1: "http://localhost:3099". */
  baseUrl: string;
  /**
   * A token, or a function returning one — sync or async. The function form
   * is what you want with refresh tokens: it is called before every request,
   * so a refreshed token is picked up without rebuilding the client.
   */
  token?:
    | string
    | (() => string | null | undefined | Promise<string | null | undefined>);
  /** Defaults to the global fetch. Pass one in for tests or for node-fetch. */
  fetch?: typeof globalThis.fetch;
  /** Applied wherever a request omits `branch`. */
  defaultBranch?: string;
  /** Abort a request that takes longer than this. Default 20s, 0 disables. */
  timeoutMs?: number;
}

export class BookingClient {
  private readonly baseUrl: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly defaultBranch?: string;
  private readonly timeoutMs: number;
  private readonly token: BookingClientOptions['token'];

  constructor(options: BookingClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.defaultBranch = options.defaultBranch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.token = options.token;
  }

  /* ---------- open routes: no token needed ---------- */

  /** Liveness and dependencies. Not under /v1. */
  health(): Promise<Health> {
    return this.request<Health>('GET', '/health');
  }

  /** Every bookable service and its id. Start here. */
  catalogue(branch?: string): Promise<CatalogueItem[]> {
    return this.request<CatalogueItem[]>('GET', '/v1/availability/catalogue', {
      query: { branch: branch ?? this.defaultBranch },
    });
  }

  /**
   * Which starts the salon can actually deliver.
   *
   * `services` is sent comma separated, in the order given: the chain is
   * booked in that order and the arithmetic depends on it.
   */
  availability(q: AvailabilityQuery): Promise<Availability> {
    return this.request<Availability>('GET', '/v1/availability', {
      query: {
        branch: q.branch ?? this.defaultBranch,
        day: q.day,
        services: q.services.join(','),
        channel: q.channel,
        staff: q.staff,
        from: q.from,
        to: q.to,
        now: q.now,
      },
    });
  }

  /* ---------- the booking flow: token required ---------- */

  /** Price a basket without booking it. Returns the deposit and the full trace. */
  quote(input: QuoteRequest): Promise<Quote> {
    return this.request<Quote>('POST', '/v1/bookings/quote', {
      body: {
        branchId: input.branchId ?? this.defaultBranch,
        day: input.day,
        serviceIds: input.serviceIds,
        customerId: input.customerId,
        channel: input.channel ?? 'DESK',
        startMin: input.startMin,
      },
    });
  }

  /**
   * Reserve the slot for 15 minutes while the customer pays.
   *
   * Throws ConflictError when the slot or the last chair went first.
   */
  placeHold(input: PlaceHoldRequest): Promise<Hold> {
    return this.request<Hold>('POST', '/v1/holds', {
      body: {
        branch: input.branch ?? this.defaultBranch,
        day: input.day,
        services: input.services,
        startMin: input.startMin,
        staffId: input.staffId,
        customerId: input.customerId,
        channel: input.channel ?? 'desk',
      },
    });
  }

  /** Give the slot back. Capacity returns immediately. */
  releaseHold(holdId: string): Promise<{ released: boolean }> {
    return this.request<{ released: boolean }>(
      'DELETE',
      `/v1/holds/${encodeURIComponent(holdId)}`,
    );
  }

  /**
   * Turn a hold into a booking. Nine writes, one commit.
   *
   * ALWAYS SEND AN IDEMPOTENCY KEY, and reuse the SAME one when retrying:
   * that is what makes a lost response safe to retry instead of a second
   * charge. One is generated per call if you do not pass one — fine for the
   * first attempt, useless for a retry, so hold on to it yourself if you
   * intend to retry.
   *
   * Throws HoldExpiredError (410) if the hold died, ConflictError (409) if
   * the slot went or the gateway reference is already recorded. Neither
   * charges anything.
   */
  confirm(
    input: ConfirmRequest,
    opts: { idempotencyKey?: string } = {},
  ): Promise<ConfirmedBooking> {
    return this.request<ConfirmedBooking>('POST', '/v1/bookings', {
      body: {
        holdId: input.holdId,
        branch: input.branch ?? this.defaultBranch,
        day: input.day,
        services: input.services,
        customerId: input.customerId,
        channel: input.channel ?? 'desk',
        amountMinor: input.amountMinor,
        rail: input.rail,
        gatewayRef: input.gatewayRef,
      },
      headers: {
        'Idempotency-Key': opts.idempotencyKey ?? newIdempotencyKey(),
      },
    });
  }

  /** One booking with its items, ledger and history. */
  getBooking(bookingId: string): Promise<BookingDetail> {
    return this.request<BookingDetail>(
      'GET',
      `/v1/bookings/${encodeURIComponent(bookingId)}`,
    );
  }

  /** Send the customer a payment link and open the window. */
  paymentLink(bookingId: string): Promise<PaymentLink> {
    return this.request<PaymentLink>(
      'POST',
      `/v1/bookings/${encodeURIComponent(bookingId)}/payment-link`,
    );
  }

  /* ---------- lifecycle ---------- */

  checkIn(id: string, body: LifecycleRequest = {}): Promise<LifecycleResult> {
    return this.transition(id, 'check-in', body);
  }

  start(id: string, body: LifecycleRequest = {}): Promise<LifecycleResult> {
    return this.transition(id, 'start', body);
  }

  complete(id: string, body: LifecycleRequest = {}): Promise<LifecycleResult> {
    return this.transition(id, 'complete', body);
  }

  /** Paid at the register. The response carries the receipt. */
  settle(id: string, body: SettleRequest = {}): Promise<LifecycleResult> {
    return this.transition(id, 'settle', body);
  }

  /** The money outcome depends on how close the start is, and is returned. */
  cancel(id: string, body: LifecycleRequest = {}): Promise<LifecycleResult> {
    return this.transition(id, 'cancel', body);
  }

  noShow(id: string, body: LifecycleRequest = {}): Promise<LifecycleResult> {
    return this.transition(id, 'no-show', body);
  }

  private transition(
    id: string,
    action: string,
    body: LifecycleRequest | SettleRequest,
  ): Promise<LifecycleResult> {
    return this.request<LifecycleResult>(
      'POST',
      `/v1/bookings/${encodeURIComponent(id)}/${action}`,
      { body },
    );
  }

  /* ---------- plumbing ---------- */

  private async request<T>(
    method: string,
    path: string,
    init: {
      query?: Record<string, string | number | boolean | undefined>;
      body?: object;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    const url = this.baseUrl + path + queryString(init.query);

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...init.headers,
    };
    const token = await this.resolveToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';

    // The server runs whitelist + forbidNonWhitelisted: an unknown property
    // is a 400, and an explicit `undefined` serialises to nothing, so strip
    // them rather than sending nulls the DTOs would reject.
    const payload =
      init.body === undefined
        ? undefined
        : JSON.stringify(withoutUndefined(init.body));

    const controller = this.timeoutMs > 0 ? new AbortController() : null;
    const timer =
      controller === null
        ? null
        : setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.doFetch(url, {
        method,
        headers,
        body: payload,
        signal: controller?.signal,
      });
    } catch (cause) {
      const aborted = (cause as { name?: string })?.name === 'AbortError';
      throw new NetworkError(
        aborted
          ? `${method} ${path} timed out after ${this.timeoutMs}ms`
          : `${method} ${path} could not reach ${this.baseUrl}. Offline, or blocked by CORS.`,
        method,
        path,
        cause,
      );
    } finally {
      if (timer !== null) clearTimeout(timer);
    }

    const text = await response.text();
    const body: unknown = text.length === 0 ? null : safeJson(text);

    if (!response.ok) {
      throw errorFor(
        response.status,
        messageOf(body, response),
        body,
        method,
        path,
      );
    }
    return body as T;
  }

  private async resolveToken(): Promise<string | null> {
    if (typeof this.token === 'function') return (await this.token()) ?? null;
    return this.token ?? null;
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * A fresh Idempotency-Key. Keep it for the lifetime of ONE booking attempt:
 * the same key replays the original booking, a new key books again.
 */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `idem-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

/**
 * Seconds left on a hold, from its `expiresAt`.
 *
 * Use this for the countdown rather than decrementing `expiresInSeconds`:
 * that number was true when the response was built, and a slow render, a
 * backgrounded tab or a sleeping laptop all make it a lie.
 */
export function secondsLeft(
  hold: Pick<Hold, 'expiresAt'>,
  now = Date.now(),
): number {
  return Math.max(0, Math.floor((Date.parse(hold.expiresAt) - now) / 1000));
}

/** 898 -> "14:58". */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 610 -> "10:10". The server sends these too; this is for times you compute. */
export function formatMinute(minuteOfDay: MinuteOfDay): string {
  const m = Math.max(0, Math.floor(minuteOfDay));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 24000 -> "AED 240.00". Prefer the server's formatted twin when there is one. */
export function formatMoney(minor: Minor, currency = 'AED'): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(Math.round(minor));
  return `${sign}${currency} ${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function queryString(
  query?: Record<string, string | number | boolean | undefined>,
): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.append(key, String(value));
  }
  const s = params.toString();
  return s.length > 0 ? `?${s}` : '';
}

function withoutUndefined(body: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).filter(([, v]) => v !== undefined),
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function messageOf(body: unknown, response: Response): string {
  const m = (body as { message?: unknown } | null)?.message;
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.map(String).join('; ');
  return `${response.status} ${response.statusText}`;
}
