#!/usr/bin/env node
/**
 * QA suite. Behaviour, edge cases, and the things that must FAIL.
 *
 *   JWT_ACCESS_SECRET=... node scripts/qa-suite.mjs
 *   BASE=http://host:port JWT_ACCESS_SECRET=... node scripts/qa-suite.mjs
 *   ... SLOW=yes    node scripts/qa-suite.mjs   # include the 15-minute waits
 *   ... ONLY=RACES  node scripts/qa-suite.mjs   # one group
 *   ... CLEANUP=no  node scripts/qa-suite.mjs   # leave the rows behind
 *
 * This is NOT scripts/proof-endpoints.mjs. That one asks "does every endpoint
 * respond". This one asks "does it respond CORRECTLY when two clients race,
 * when the money has a remainder, when the caller asks for something that
 * must be refused, and when a timer fires". Every refusal case asserts the
 * status code AND that the message is useful: a 500, or a body whose message
 * is 'Internal server error', is a FAIL even when a failure was what we
 * wanted, because 'it broke' is not the same as 'it said no'.
 *
 * FOUR VERDICTS, and only one of them is good.
 *
 *   PASS    the assertion held
 *   FAIL    it did not
 *   BLOCKED the case could not run, and the reason is a product gap worth
 *           reading -- not a flaky test. These are findings.
 *   SKIP    deliberately not run this invocation (SLOW, ONLY)
 *
 * WRITES AGAINST A REAL DATABASE. Holds, bookings, groups and waitlist rows
 * are created for real. Everything is tagged X-Tenant-Id: qa-<run> so the
 * rows are identifiable, most of it lands on a random day 30-90 days out so
 * it cannot collide with a live diary, and teardown releases holds and
 * cancels bookings at the end. Cancelled is as clean as HTTP gets: there is
 * no DELETE for a booking, by design.
 */

import jwt from 'jsonwebtoken';
import { createHmac, randomUUID } from 'node:crypto';

const BASE = process.env.BASE ?? 'http://156.67.214.42:3851';
const SECRET = process.env.JWT_ACCESS_SECRET;
const WEBHOOK_SECRET =
  process.env.PAYMENT_WEBHOOK_SECRET ?? 'simulated-webhook-secret';
const SLOW = (process.env.SLOW ?? 'no').toLowerCase() === 'yes';
const CLEANUP = (process.env.CLEANUP ?? 'yes').toLowerCase() !== 'no';
const ONLY = process.env.ONLY ?? null;

const RUN = randomUUID().slice(0, 8);
const TENANT = `qa-${RUN}`;

/**
 * A real customer token, if one is to hand.
 *
 * Only this can prove the role refusals. Staff and manager are interchangeable
 * in every transition in the table (ANY_STAFF = ['staff','manager']), so
 * "A customer may not POS payment." is unreachable from a staff token no
 * matter how the roles claim is spelled.
 */
const CUSTOMER_TOKEN = process.env.CUSTOMER_TOKEN ?? null;

/** Without the staff secret only the AUTH group can run. It still says a lot. */
const AUTH_ONLY = !SECRET;

/**
 * A day far enough out that lead time is moot, and a DIFFERENT one each run.
 *
 * Same reasoning as proof-endpoints.mjs: this script really books, so a fixed
 * day would leave the diary fuller every run until the group planner could no
 * longer fit a party and the script failed itself for it.
 */
const DAY =
  process.env.DAY ??
  new Date(Date.now() + (30 + Math.floor(Math.random() * 60)) * 86400000)
    .toISOString()
    .slice(0, 10);

const staffToken = (claims, secret = SECRET, opts = {}) =>
  jwt.sign(
    {
      branchId: '11111111-1111-1111-1111-111111111111',
      tenantId: TENANT,
      ...claims,
    },
    secret,
    { issuer: 'gostyle-api', expiresIn: '2h', ...opts },
  );

const MANAGER = SECRET
  ? staffToken({ sub: '22222222-2222-2222-2222-222222222222', roles: ['branch_manager'] })
  : null;

const STAFF = SECRET
  ? staffToken({ sub: '33333333-3333-3333-3333-333333333333', roles: ['stylist'] })
  : null;

// --------------------------------------------------------------- the harness

const results = [];
let group = '';

const C = {
  pass: '\x1b[32mPASS\x1b[0m',
  fail: '\x1b[31mFAIL\x1b[0m',
  block: '\x1b[35mBLOCK\x1b[0m',
  skip: '\x1b[33mSKIP\x1b[0m',
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

class Blocked extends Error {}
class Skipped extends Error {}
const blocked = (why) => {
  throw new Blocked(why);
};
const skipped = (why) => {
  throw new Skipped(why);
};

async function testCase(id, title, fn) {
  if (ONLY && group !== ONLY) {
    results.push({ group, id, title, kind: 'SKIP', detail: `ONLY=${ONLY}` });
    return;
  }
  let kind, detail;
  try {
    detail = (await fn()) ?? '';
    kind = 'PASS';
  } catch (e) {
    if (e instanceof Blocked) {
      kind = 'BLOCKED';
      detail = e.message;
    } else if (e instanceof Skipped) {
      kind = 'SKIP';
      detail = e.message;
    } else {
      kind = 'FAIL';
      detail = e.message;
    }
  }
  results.push({ group, id, title, kind, detail });
  const tag = { PASS: C.pass, FAIL: C.fail, BLOCKED: C.block, SKIP: C.skip }[
    kind
  ];
  console.log(`  ${tag}  ${id.padEnd(8)} ${title}`);
  if (detail) console.log(`        ${C.dim(String(detail).slice(0, 300))}`);
}

function heading(name) {
  group = name;
  console.log(`\n\x1b[1m── ${name} ${'─'.repeat(Math.max(0, 60 - name.length))}\x1b[0m`);
}

const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

/** The message, however the four error shapes chose to carry it. */
function messageOf(r) {
  const m = r.json?.message;
  if (m === undefined || m === null) return '';
  return Array.isArray(m) ? m.join('; ') : String(m);
}

/**
 * A refusal is only good if it SAYS something.
 *
 * The whole point of the REFUSALS group is that the caller can act on the
 * answer. A 500, or Nest's bare 'Internal server error', means the server
 * fell over on the way to refusing -- which is a different bug, and a worse
 * one, than the refusal we were testing for.
 */
function expectRefusal(r, wantStatus, mustMention) {
  const msg = messageOf(r);
  expect(
    r.status !== 500,
    `500 Internal server error -- it broke rather than refusing. body=${JSON.stringify(r.json)}`,
  );
  const wanted = Array.isArray(wantStatus) ? wantStatus : [wantStatus];
  expect(
    wanted.includes(r.status),
    `expected ${wanted.join(' or ')}, got ${r.status} -- ${msg || JSON.stringify(r.json)}`,
  );
  expect(msg.length > 0, `${r.status} with an empty message`);
  expect(
    msg !== 'Internal server error',
    `${r.status} whose message is the stock 'Internal server error'`,
  );
  if (mustMention) {
    const needles = Array.isArray(mustMention) ? mustMention : [mustMention];
    expect(
      needles.some((n) => msg.toLowerCase().includes(n.toLowerCase())),
      `message does not mention ${needles.join('/')}: "${msg}"`,
    );
  }
  return msg;
}

// ------------------------------------------------------------------ the wire

async function call(method, path, body, opts = {}) {
  const headers = {
    'X-Tenant-Id': TENANT,
    ...(opts.token === null
      ? {}
      : { Authorization: `Bearer ${opts.token ?? MANAGER}` }),
    ...(opts.headers ?? {}),
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method,
    headers,
    ...(body !== undefined
      ? { body: opts.raw ?? JSON.stringify(body) }
      : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* leave null; the caller can read .text */
  }
  return { status: res.status, json, text };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ teardown

const created = { holds: [], bookings: [], groups: [], waitlist: [] };
const trackHold = (id) => (id && created.holds.push(id), id);
const trackBooking = (id) => (id && created.bookings.push(id), id);

// ------------------------------------------------------------------- helpers

async function availability(day, services, extra = '') {
  return call(
    'GET',
    `/v1/availability?day=${day}&services=${services.join(',')}&channel=desk${extra}`,
    undefined,
    { token: null },
  );
}

/**
 * Walk the offers until a hold actually sticks.
 *
 * Taking offers[0] every time meant each case raced the case before it and
 * reported the collision as a product bug. Walking is the fix, and returning
 * the offer means the caller knows which start it got.
 */
async function placeHold(day, services, opts = {}) {
  const a = await availability(day, services);
  if (a.status !== 200) blocked(`availability ${a.status}: ${messageOf(a)}`);
  const offers = a.json?.offers ?? [];
  if (offers.length === 0) blocked(`no feasible start for ${services} on ${day}`);

  for (const offer of offers) {
    for (const staff of offer.staff ?? []) {
      const r = await call('POST', '/v1/holds', {
        day,
        services,
        startMin: offer.startMin,
        staffId: staff.id,
        channel: 'desk',
        ...(opts.customerId ? { customerId: opts.customerId } : {}),
      });
      if (r.status === 201) {
        trackHold(r.json.holdId);
        return { hold: r.json, offer, staffId: staff.id };
      }
      if (r.status !== 409) {
        blocked(`hold ${r.status}: ${messageOf(r)}`);
      }
    }
  }
  blocked(`every offer on ${day} was taken while holding`);
}

async function quoteFor(day, serviceIds, customerId, startMin) {
  const r = await call('POST', '/v1/bookings/quote', {
    day,
    serviceIds,
    customerId,
    channel: 'DESK',
    ...(startMin !== undefined ? { startMin } : {}),
  });
  if (r.status !== 201) blocked(`quote ${r.status}: ${messageOf(r)}`);
  return r.json;
}

/** A confirmed booking on a start nothing else has taken. */
async function freshBooking(day, services, opts = {}) {
  const { hold, offer, staffId } = await placeHold(day, services, opts);
  const body = {
    holdId: hold.holdId,
    day,
    services,
    channel: 'desk',
    ...(opts.customerId ? { customerId: opts.customerId } : {}),
    ...(opts.amountMinor !== undefined
      ? { amountMinor: opts.amountMinor, rail: opts.rail ?? 'CARD' }
      : {}),
  };
  const r = await call('POST', '/v1/bookings', body, {
    headers: opts.idempotencyKey
      ? { 'Idempotency-Key': opts.idempotencyKey }
      : {},
  });
  if (r.status !== 201) {
    blocked(`confirm ${r.status}: ${messageOf(r)}`);
  }
  trackBooking(r.json.bookingId);
  return { booking: r.json, offer, staffId, holdId: hold.holdId };
}

/** Deposit sized off the server's own requirement, so it is never an underpay. */
async function bookingWithDeposit(day, services, customerId = 'dana') {
  const q = await quoteFor(day, services, customerId);
  return freshBooking(day, services, {
    customerId,
    amountMinor: Math.max(1, q.depositMinor),
    rail: 'CARD',
  });
}

const lifecycle = (id, action, body = {}) =>
  call('POST', `/v1/bookings/${id}/${action}`, body);

const readBooking = (id) => call('GET', `/v1/bookings/${id}`);

function signedWebhook(payload) {
  const raw = JSON.stringify(payload);
  return call('POST', '/v1/webhooks/payments', payload, {
    token: null,
    raw,
    headers: { 'x-signature': createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex') },
  });
}

const AED = (s) => Math.round(parseFloat(String(s).replace(/[^0-9.]/g, '')) * 100);

// ============================================================ 0. AUTH

/**
 * The guard's own refusal ladder, and the one route that must not 500.
 *
 * Every token below is DELIBERATELY not valid. The point is that a bad
 * credential is refused cleanly with a 401 that says which kind of bad it
 * was -- the taxonomy MOBILE.md publishes and a client branches on. Nothing
 * here tries to get IN; a case that authenticated would be the failure.
 */
async function auth() {
  heading('AUTH');

  const probe = (token) =>
    call('GET', '/v1/bookings/settings', undefined, { token });

  await testCase('AUTH-1', 'No bearer token is refused', async () => {
    const r = await probe(null);
    const msg = expectRefusal(r, 401, 'Missing bearer token');
    return `401: "${msg}"`;
  });

  await testCase('AUTH-2', 'A non-JWT bearer value is refused', async () => {
    const r = await probe('this-is-not-a-jwt');
    const msg = expectRefusal(r, 401, 'Malformed token');
    return `401: "${msg}"`;
  });

  await testCase('AUTH-3', 'A token with no known issuer or audience is refused', async () => {
    // Signed correctly, but claiming neither iss=gostyle-api nor
    // aud=gostyle-consumer, so the verifier cannot pick a path.
    const t = jwt.sign({ sub: 'qa' }, 'irrelevant-secret', { expiresIn: '5m' });
    const r = await probe(t);
    const msg = expectRefusal(r, 401, 'Unknown token issuer');
    return `401: "${msg}"`;
  });

  await testCase('AUTH-4', 'A staff token signed with the wrong secret is refused', async () => {
    const t = staffToken({ sub: 'qa', roles: ['branch_manager'] }, `wrong-${randomUUID()}`);
    const r = await probe(t);
    const msg = expectRefusal(r, 401, 'Invalid token');
    return `401: "${msg}"`;
  });

  await testCase('AUTH-5', 'An expired staff token says so, distinctly', async () => {
    // 'Token expired' and 'Invalid token' are different strings on purpose:
    // one means sign in again, the other means something is wrong.
    //
    // This needs the REAL secret. jwt.verify checks the signature before the
    // expiry, so a token signed with a wrong secret reports 'Invalid token'
    // whether or not it has also expired -- the expiry branch is never
    // reached and the case would fail for the wrong reason.
    if (AUTH_ONLY) blocked('needs the real JWT_ACCESS_SECRET: signature is checked before expiry');
    const t = staffToken({ sub: 'qa', roles: ['branch_manager'] }, SECRET, { expiresIn: '-5m' });
    const r = await probe(t);
    const msg = expectRefusal(r, 401);
    expect(
      /expired/i.test(msg),
      `an expired token reported "${msg}"; a client cannot tell "sign in again" ` +
        'from "something is broken"',
    );
    return `401: "${msg}"`;
  });

  await testCase('AUTH-6', 'A customer token does not 500', async () => {
    if (!CUSTOMER_TOKEN) blocked('no CUSTOMER_TOKEN supplied');
    const r = await probe(CUSTOMER_TOKEN);
    expect(
      r.status !== 500,
      `500 Internal server error. The customer path has NO local signature check ` +
        `(token-verifier.service.ts routes aud=gostyle-consumer straight to ` +
        `AuthService.verifyToken, which awaits a gRPC call and deliberately lets ` +
        `a thrown error propagate). A 500 here means the consumer-auth gRPC rail ` +
        `is unreachable, not that this token is bad -- its validity was never ` +
        `assessed. Every mobile customer sees this on every route. See FINDING-6.`,
    );
    expect(
      [200, 401, 403].includes(r.status),
      `unexpected ${r.status}: ${messageOf(r)}`,
    );
    return `${r.status}: ${messageOf(r) || 'authenticated'}`;
  });

  await testCase('AUTH-7', 'A customer may not settle, check in, start or complete', async () => {
    if (!CUSTOMER_TOKEN) blocked('no CUSTOMER_TOKEN supplied');
    const alive = await probe(CUSTOMER_TOKEN);
    if (alive.status === 500) blocked('the consumer-auth rail is down (AUTH-6)');
    if (AUTH_ONLY) blocked('needs a staff token to create the booking to probe');

    const { booking } = await freshBooking(DAY, ['fringe-trim']);
    const refusals = [];
    for (const route of ['check-in', 'start', 'complete', 'settle', 'no-show']) {
      const r = await call('POST', `/v1/bookings/${booking.bookingId}/${route}`,
        { reason: 'QA role probe' }, { token: CUSTOMER_TOKEN });
      if (r.status !== 403) {
        refusals.push(`${route} -> ${r.status} "${messageOf(r)}" (expected 403)`);
      } else if (!/may not/i.test(messageOf(r))) {
        refusals.push(`${route} -> 403 but the message names no actor: "${messageOf(r)}"`);
      }
    }
    expect(refusals.length === 0, refusals.join('; '));
    return 'all five staff-only routes refused a customer token with a 403';
  });

  await testCase('AUTH-8', 'Health is honest about the auth rail', async () => {
    const h = await call('GET', '/health', undefined, { token: null });
    expect(h.status === 200, `health ${h.status}`);
    if (!CUSTOMER_TOKEN) skipped('no CUSTOMER_TOKEN to establish whether the rail is down');
    const c = await probe(CUSTOMER_TOKEN);
    if (c.status !== 500) return `rail is up; health says ${h.json.status}`;
    throw new Error(
      `health reports status "${h.json.status}" (database ${h.json.database}) while ` +
        'every customer token 500s. HealthController checks Postgres and the outbox ' +
        'only -- it never touches the consumer-auth gRPC channel -- so Docker Swarm ' +
        'keeps routing to a container whose entire mobile auth rail is dead. See FINDING-7.',
    );
  });
}

// =========================================================== 1. RACES

async function races() {
  heading('RACES');

  await testCase('RACE-1', 'Two clients hold the same slot simultaneously', async () => {
    const a = await availability(DAY, ['gel-manicure']);
    const offer = (a.json?.offers ?? []).find((o) => (o.staff ?? []).length > 0);
    if (!offer) blocked('no offer with a concrete professional');
    const staffId = offer.staff[0].id;
    const body = {
      day: DAY,
      services: ['gel-manicure'],
      startMin: offer.startMin,
      staffId,
      channel: 'desk',
    };

    // Same professional, same minute, fired together. Without pinning staffId
    // the engine would hand the two callers different people, which is
    // correct behaviour and not a race at all.
    const [x, y] = await Promise.all([
      call('POST', '/v1/holds', body),
      call('POST', '/v1/holds', body),
    ]);
    for (const r of [x, y]) if (r.status === 201) trackHold(r.json.holdId);

    const won = [x, y].filter((r) => r.status === 201);
    const lost = [x, y].filter((r) => r.status !== 201);
    expect(
      won.length === 1,
      `${won.length} of 2 holds succeeded on one professional at one minute -- ` +
        `${won.length === 2 ? 'THE SLOT WAS DOUBLE-HELD' : 'neither could hold a slot availability had just offered'}`,
    );
    expectRefusal(lost[0], 409);
    return `one 201, one ${lost[0].status}: "${messageOf(lost[0])}"`;
  });

  await testCase('RACE-2', 'Confirm the same hold twice, concurrently', async () => {
    const { hold } = await placeHold(DAY, ['fringe-trim']);
    const body = { holdId: hold.holdId, day: DAY, services: ['fringe-trim'], channel: 'desk' };
    const [x, y] = await Promise.all([
      call('POST', '/v1/bookings', body),
      call('POST', '/v1/bookings', body),
    ]);
    for (const r of [x, y]) if (r.status === 201) trackBooking(r.json.bookingId);

    const won = [x, y].filter((r) => r.status === 201);
    const codes = new Set(won.map((r) => r.json.bookingId));
    expect(
      codes.size <= 1,
      `ONE HOLD BECAME TWO BOOKINGS: ${won.map((r) => r.json.code).join(' and ')}`,
    );
    expect(won.length >= 1, `neither confirm succeeded (${x.status}, ${y.status})`);

    // Two shapes are both correct here, and which one you get is a matter of
    // lock scheduling. The loser either replays the winner's booking, or
    // fails its `SELECT ... FOR UPDATE` on a hold the winner has already
    // deleted and gets a 410. What must never happen is two bookings.
    if (won.length === 2) {
      return `both replayed the same booking ${won[0].json.code}`;
    }
    const lost = [x, y].find((r) => r.status !== 201);
    expectRefusal(lost, [409, 410]);
    return `one booking ${won[0].json.code}, loser ${lost.status}: "${messageOf(lost)}"`;
  });

  await testCase('RACE-3', 'Confirm the same hold twice, sequentially, with NO key', async () => {
    // THE CONTRACT CHANGED HERE. A confirm that carries no Idempotency-Key
    // now derives one from the holdId, because a hold can only ever produce
    // one booking. So the second call is a replay: it returns the FIRST
    // booking rather than either creating a second one or refusing with 410.
    // Sending no header is the common case, so this is the path that matters.
    const { hold } = await placeHold(DAY, ['fringe-trim']);
    const body = { holdId: hold.holdId, day: DAY, services: ['fringe-trim'], channel: 'desk' };

    const first = await call('POST', '/v1/bookings', body);
    expect(first.status === 201, `first confirm ${first.status}: ${messageOf(first)}`);
    trackBooking(first.json.bookingId);

    const second = await call('POST', '/v1/bookings', body);
    expect(
      second.status === 201,
      `second confirm ${second.status} "${messageOf(second)}" -- expected the first ` +
        'booking back. A 410 here means the derived-key replay did not engage.',
    );
    expect(
      second.json.bookingId === first.json.bookingId,
      `THE HOLD CONFIRMED TWICE: ${first.json.code} and ${second.json.code}`,
    );
    expect(
      second.json.replayed === true,
      `the replay is not flagged: replayed=${second.json.replayed}`,
    );

    // A replay must be the WHOLE answer, not the partial row the repository
    // writes inside the transaction before the handler overwrites it.
    for (const k of ['totalMinor', 'vatMinor', 'depositMinor', 'dueAtCheckoutMinor']) {
      expect(
        typeof second.json[k] === 'number',
        `the replayed body is missing ${k} -- it is the partial ConfirmedBooking ` +
          'shape, not a BookingView. See FINDING-8.',
      );
    }
    return `both calls returned ${first.json.code}, second flagged replayed`;
  });

  await testCase('RACE-4', 'Idempotency-Key replay returns the first booking', async () => {
    const { hold } = await placeHold(DAY, ['fringe-trim']);
    const key = `qa-${RUN}-${randomUUID()}`;
    const body = { holdId: hold.holdId, day: DAY, services: ['fringe-trim'], channel: 'desk' };
    const first = await call('POST', '/v1/bookings', body, { headers: { 'Idempotency-Key': key } });
    expect(first.status === 201, `first ${first.status}: ${messageOf(first)}`);
    trackBooking(first.json.bookingId);
    const replay = await call('POST', '/v1/bookings', body, { headers: { 'Idempotency-Key': key } });
    expect(
      replay.status === 201 && replay.json?.bookingId === first.json.bookingId,
      `replay returned ${replay.status} ${replay.json?.code ?? messageOf(replay)}, ` +
        `expected the original ${first.json.code}`,
    );
    return `both calls returned ${first.json.code}`;
  });

  await testCase('RACE-5', 'Two cancels of one booking in the same second', async () => {
    const { booking } = await freshBooking(DAY, ['fringe-trim']);
    const body = { reason: 'QA concurrent cancel', initiatedBy: 'SALON' };
    const [x, y] = await Promise.all([
      lifecycle(booking.bookingId, 'cancel', body),
      lifecycle(booking.bookingId, 'cancel', body),
    ]);
    const won = [x, y].filter((r) => r.status === 201);
    expect(
      won.length === 1,
      won.length === 2
        ? 'BOTH CANCELS APPLIED -- the money outcome was computed twice against the same ledger'
        : `neither cancel succeeded (${x.status}, ${y.status})`,
    );
    const lost = [x, y].find((r) => r.status !== 201);
    expectRefusal(lost, 409, 'cannot become cancelled');
    return `one 201, one ${lost.status}: "${messageOf(lost)}"`;
  });

  await testCase('RACE-6', 'Two participants cancelling a group in the same second', async () => {
    const g = await groupOf(2);
    blocked(
      `group ${g.groupId} confirmed as ${g.bookings.map((b) => b.code).join(', ')}, ` +
        'but POST /v1/groups/:id/confirm returns booking CODES and every lifecycle ' +
        'route keys on a uuid. There is no code->id lookup, no GET /v1/groups/:id ' +
        'and no booking list endpoint, so a participant cannot be cancelled over ' +
        'HTTP at all. See FINDING-1.',
    );
  });

  await testCase('RACE-7', 'The same webhook delivered twice, sequentially', async () => {
    const { booking } = await bookingWithDeposit(DAY, ['gel-manicure']);
    const link = await call('POST', `/v1/bookings/${booking.bookingId}/payment-link`);
    if (link.status !== 201) blocked(`payment-link ${link.status}: ${messageOf(link)}`);

    const intentId = `sim_qa_${randomUUID()}`;
    const payload = {
      intentId,
      bookingCode: booking.code,
      kind: 'CAPTURED',
      amountMinor: link.json.outstandingMinor,
      rail: 'card',
    };
    const first = await signedWebhook(payload);
    if (first.status === 401) {
      blocked('signature rejected -- PAYMENT_WEBHOOK_SECRET does not match the server');
    }
    expect(first.status === 200, `first delivery ${first.status}: ${messageOf(first)}`);
    expect(first.json.replayed === false, `first delivery already flagged replayed`);

    const second = await signedWebhook(payload);
    expect(second.status === 200, `retry ${second.status}: ${messageOf(second)}`);
    expect(
      second.json.replayed === true && second.json.outcome === 'ALREADY_PROCESSED',
      `retry was reprocessed: outcome=${second.json.outcome} replayed=${second.json.replayed}`,
    );

    // The ledger is where a double-charge would actually show up.
    const detail = await readBooking(booking.bookingId);
    const captures = (detail.json.ledger ?? []).filter((l) => l.entryType === 'captured');
    expect(
      captures.length <= 2,
      `${captures.length} 'captured' ledger rows after one deposit and one webhook`,
    );
    return `first ${first.json.outcome}, retry ${second.json.outcome}, ${captures.length} capture row(s)`;
  });

  await testCase('RACE-8', 'The same webhook delivered twice, concurrently', async () => {
    const { booking } = await bookingWithDeposit(DAY, ['gel-manicure']);
    const link = await call('POST', `/v1/bookings/${booking.bookingId}/payment-link`);
    if (link.status !== 201) blocked(`payment-link ${link.status}: ${messageOf(link)}`);

    const payload = {
      intentId: `sim_qa_${randomUUID()}`,
      bookingCode: booking.code,
      kind: 'CAPTURED',
      amountMinor: link.json.outstandingMinor,
      rail: 'card',
    };
    const [x, y] = await Promise.all([signedWebhook(payload), signedWebhook(payload)]);
    if (x.status === 401 || y.status === 401) {
      blocked('signature rejected -- PAYMENT_WEBHOOK_SECRET does not match the server');
    }
    expect(x.status === 200 && y.status === 200, `statuses ${x.status}, ${y.status}`);

    const detail = await readBooking(booking.bookingId);
    const captures = (detail.json.ledger ?? []).filter((l) => l.entryType === 'captured');
    expect(
      captures.length <= 2,
      `CONCURRENT DELIVERY DOUBLE-CHARGED: ${captures.length} 'captured' rows`,
    );
    const outcomes = [x.json.outcome, y.json.outcome].sort().join('+');
    return `outcomes ${outcomes}, ${captures.length} capture row(s)`;
  });
}

/**
 * A confirmed party. Returns groupId + the confirm response's bookings.
 *
 * EVERY LANE NEEDS ITS OWN PROFESSIONAL, so the party can only be as large
 * as the eligible pool. An earlier version gave participant 1 a gel-manicure
 * at a hard-coded 11:00 and the planner refused the whole party, correctly:
 * only Lina does nails and her first nail slot is 12:05. The refusal was
 * right and the test was wrong. So: all-hair services, which four of the six
 * professionals can take, and a target read off real availability rather
 * than guessed.
 *
 * Prices matter too. MON-5 needs a total that does not divide evenly, and
 * every fixture price is a multiple of 1000 -- so a remainder is only
 * reachable on a 3-way split whose net total in thousands is not a multiple
 * of 3. 16000 + 16000 + 14000 = 46000 is.
 */
const GROUP_SERVICES = ['haircut-finish', 'haircut-finish', 'blow-dry',
  'fringe-trim', 'haircut-finish', 'blow-dry', 'fringe-trim', 'haircut-finish'];

async function groupOf(n, opts = {}) {
  const participants = Array.from({ length: n }, (_, i) => ({
    label: `QA${i + 1}`,
    serviceIds: [GROUP_SERVICES[i]],
    guestName: `QA Guest ${i + 1}`,
  }));

  // A start where at least n professionals can take the longest lane. Below
  // that the planner cannot give every participant their own, and the 409 it
  // returns is correct rather than interesting.
  const a = await availability(DAY, ['haircut-finish']);
  if (a.status !== 200) blocked(`availability ${a.status}: ${messageOf(a)}`);
  const wide = (a.json.offers ?? []).find((o) => (o.staff ?? []).length >= n);
  if (!wide) {
    const best = Math.max(0, ...(a.json.offers ?? []).map((o) => (o.staff ?? []).length));
    blocked(`no start on ${DAY} has ${n} free professionals at once (best is ${best})`);
  }

  const held = await call('POST', '/v1/groups/holds', {
    branchId: 'marina-walk',
    day: DAY,
    targetMin: wide.startMin,
    mode: 'TOGETHER',
    arrangement: opts.arrangement ?? 'SPLIT',
    participants,
  });
  if (held.status !== 201) blocked(`group hold ${held.status}: ${messageOf(held)}`);
  created.groups.push(held.json.groupId);
  trackHold(held.json.holdId);

  const done = await call('POST', `/v1/groups/${held.json.groupId}/confirm`, {
    holdId: held.json.holdId,
    participants,
  });
  if (done.status !== 201) blocked(`group confirm ${done.status}: ${messageOf(done)}`);
  return { groupId: held.json.groupId, holdId: held.json.holdId, ...done.json };
}

// ======================================================== 2. REFUSALS

async function refusals() {
  heading('REFUSALS');

  await testCase('REF-1', 'Book a slot that is already taken', async () => {
    const { offer, staffId } = await placeHold(DAY, ['gel-manicure']);
    const again = await call('POST', '/v1/holds', {
      day: DAY,
      services: ['gel-manicure'],
      startMin: offer.startMin,
      staffId,
      channel: 'desk',
    });
    if (again.status === 201) {
      trackHold(again.json.holdId);
      throw new Error('THE SAME PROFESSIONAL WAS HELD TWICE AT ONE MINUTE');
    }
    const msg = expectRefusal(again, 409);
    return `409: "${msg}"`;
  });

  await testCase('REF-2a', 'Confirm a hold that never existed', async () => {
    const r = await call('POST', '/v1/bookings', {
      holdId: randomUUID(),
      day: DAY,
      services: ['fringe-trim'],
      channel: 'desk',
    });
    const msg = expectRefusal(r, 410, ['no longer exists', 'expired']);
    return `410: "${msg}"`;
  });

  await testCase('REF-2b', 'Confirm a genuinely expired hold', async () => {
    if (!SLOW) skipped('needs a 15-minute wait for HOLD_TTL_MS; run with SLOW=yes');
    const { hold } = await placeHold(DAY, ['fringe-trim']);
    const waitMs = hold.expiresInSeconds * 1000 + 45_000;
    console.log(`        ${C.dim(`waiting ${Math.round(waitMs / 1000)}s for the hold to lapse`)}`);
    await sleep(waitMs);
    const r = await call('POST', '/v1/bookings', {
      holdId: hold.holdId,
      day: DAY,
      services: ['fringe-trim'],
      channel: 'desk',
    });
    const msg = expectRefusal(r, 410, ['expired', 'no longer exists']);
    return `410 after TTL: "${msg}"`;
  });

  await testCase('REF-3', 'Underpay a deposit', async () => {
    // rania is the VIP a manager flagged for a deposit, so a requirement
    // definitely fires and there is something to underpay.
    const q = await quoteFor(DAY, ['balayage'], 'rania');
    if (q.depositMinor <= 1) blocked(`no deposit required for this basket (${q.requirementSource})`);
    const { hold } = await placeHold(DAY, ['balayage'], { customerId: 'rania' });
    const r = await call('POST', '/v1/bookings', {
      holdId: hold.holdId,
      day: DAY,
      services: ['balayage'],
      customerId: 'rania',
      channel: 'desk',
      amountMinor: 1,
      rail: 'CARD',
    });
    if (r.status === 201) {
      trackBooking(r.json.bookingId);
      throw new Error(`A ${q.deposit} deposit was satisfied by 1 fil`);
    }
    const msg = expectRefusal(r, 402, 'required');
    expect(
      typeof r.json.requiredMinor === 'number' && typeof r.json.tenderedMinor === 'number',
      `402 body is missing requiredMinor/tenderedMinor: ${JSON.stringify(r.json).slice(0, 200)}`,
    );
    expect(
      r.json.requiredMinor === q.depositMinor,
      `402 says ${r.json.requiredMinor} required, the quote said ${q.depositMinor}`,
    );
    expect(r.json.tenderedMinor === 1, `402 says tendered ${r.json.tenderedMinor}, sent 1`);
    return `402 required=${r.json.requiredMinor} tendered=1, trace ${r.json.requirement?.trace?.length ?? 0} rungs: "${msg}"`;
  });

  await testCase('REF-4', 'Cancel an already-cancelled booking', async () => {
    const { booking } = await freshBooking(DAY, ['fringe-trim']);
    const first = await lifecycle(booking.bookingId, 'cancel', {
      reason: 'QA first cancel',
      initiatedBy: 'SALON',
    });
    expect(first.status === 201, `first cancel ${first.status}: ${messageOf(first)}`);
    const second = await lifecycle(booking.bookingId, 'cancel', {
      reason: 'QA second cancel',
      initiatedBy: 'SALON',
    });
    const msg = expectRefusal(second, 409, 'cancelled booking cannot become cancelled');
    return `409: "${msg}"`;
  });

  await testCase('REF-5a', 'Hold before trading opens (startMin 599)', async () => {
    const r = await call('POST', '/v1/holds', {
      day: DAY, services: ['fringe-trim'], startMin: 599, channel: 'desk',
    });
    const msg = expectRefusal(r, 400, 'startMin');
    return `400: "${msg}"`;
  });

  await testCase('REF-5b', 'Hold after trading closes (startMin 1321)', async () => {
    const r = await call('POST', '/v1/holds', {
      day: DAY, services: ['fringe-trim'], startMin: 1321, channel: 'desk',
    });
    const msg = expectRefusal(r, 400, 'startMin');
    return `400: "${msg}"`;
  });

  await testCase('REF-5c', 'Hold exactly at close (startMin 1320)', async () => {
    // The DTO's @Max is 1320 but grid.ts treats the day as [600, 1320), so
    // 1320 passes validation and must then be refused by the engine. A 500
    // here would mean the boundary is only half-defended.
    const r = await call('POST', '/v1/holds', {
      day: DAY, services: ['fringe-trim'], startMin: 1320, channel: 'desk',
    });
    if (r.status === 201) {
      trackHold(r.json.holdId);
      throw new Error('a hold was placed at 22:00, the minute the day ends');
    }
    const msg = expectRefusal(r, [400, 409, 422]);
    return `${r.status}: "${msg}"`;
  });

  await testCase('REF-6', 'A group of 1', async () => {
    const r = await call('POST', '/v1/groups/holds', {
      branchId: 'marina-walk', day: DAY, targetMin: 660,
      mode: 'TOGETHER', arrangement: 'SPLIT',
      participants: [{ label: 'Solo', serviceIds: ['fringe-trim'], guestName: 'Solo' }],
    });
    const msg = expectRefusal(r, [400, 422], ['at least 2', 'at least two', 'participants']);
    return `${r.status}: "${msg}"`;
  });

  await testCase('REF-7', 'A group of 9', async () => {
    const participants = Array.from({ length: 9 }, (_, i) => ({
      label: `P${i}`, serviceIds: ['fringe-trim'], guestName: `G${i}`,
    }));
    const r = await call('POST', '/v1/groups/holds', {
      branchId: 'marina-walk', day: DAY, targetMin: 660,
      mode: 'TOGETHER', arrangement: 'SPLIT', participants,
    });
    const msg = expectRefusal(r, [400, 422], ['8', 'eight', 'participants']);
    return `${r.status}: "${msg}"`;
  });

  await testCase('REF-8a', 'Quote says a link is impossible inside 2 hours', async () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const startMin = now.getUTCHours() * 60 + now.getUTCMinutes() + 240 + 60; // +4h branch, +1h
    if (startMin < 600 || startMin > 1319) {
      blocked(`a start one hour from now is ${startMin}, outside trading hours in Asia/Dubai`);
    }
    const q = await quoteFor(today, ['gel-manicure'], 'dana', startMin);
    expect(
      q.linkAvailable === false,
      `linkAvailable is true for a start ~1h away (startMin ${startMin})`,
    );
    expect(
      typeof q.linkUnavailableReason === 'string' && q.linkUnavailableReason.length > 0,
      'linkAvailable false with no linkUnavailableReason',
    );
    return `linkAvailable=false: "${q.linkUnavailableReason}"`;
  });

  await testCase('REF-8b', 'Payment-link route refuses inside 2 hours', async () => {
    // Anywhere inside two hours closes the window; the exact offset is
    // irrelevant, so search the whole range for one that is free and fits.
    const b = await nearBooking(20, 115, { amountMinor: 1000 });
    const r = await call('POST', `/v1/bookings/${b.booking.bookingId}/payment-link`);
    const msg = expectRefusal(r, [409, 422], ['too close', 'window shut', 'link']);
    return `${r.status}: "${msg}"`;
  });

  await testCase('REF-9', 'Reschedule into a slot that does not exist', async () => {
    const { booking } = await freshBooking(DAY, ['fringe-trim']);
    const r = await lifecycle(booking.bookingId, 'reschedule', {
      holdId: randomUUID(),
      day: DAY,
      reason: 'QA reschedule onto a hold that was never placed',
    });
    const msg = expectRefusal(r, [404, 409, 410], ['slot', 'hold', 'went']);
    return `${r.status}: "${msg}"`;
  });
}

/** Branch-local minute-of-day and trading day, `offsetMin` from now. */
function branchClock(offsetMin) {
  const t = new Date(Date.now() + offsetMin * 60_000 + 4 * 3600_000); // Asia/Dubai, UTC+4
  return {
    day: t.toISOString().slice(0, 10),
    startMin: Math.floor((t.getUTCHours() * 60 + t.getUTCMinutes()) / 5) * 5,
  };
}

const DURATION = { 'fringe-trim': 20, 'hair-wash': 15, 'gel-manicure': 60 };

/**
 * A confirmed booking on a real clock position, past or future.
 *
 * `GET /v1/availability` applies a lead-time mask and will not offer a start
 * that has already passed. `POST /v1/holds` does not: PlaceHoldDto has no
 * `now` field, so place-hold.handler.ts:102 passes `nowMin: 0` and the mask
 * is inert. That inconsistency is FINDING-4; here it is also the only lever
 * that lets the timer cases put a booking where a timer will find it, so the
 * eligible staff are read with ?now=0 and the hold is placed directly.
 */
async function clockBooking(loMin, hiMin, opts = {}) {
  const service = opts.service ?? 'fringe-trim';
  const nowMin = branchClock(0).startMin;
  const tried = [];

  // Walk the whole range, latest first. Two different things can rule an
  // offset out -- it runs past close, or the diary is full at that minute --
  // and neither is worth failing the case over while another offset in the
  // range would serve. Giving up on the first candidate was a test bug that
  // reported two correct refusals as blockers.
  for (let off = hiMin; off >= loMin; off -= 5) {
    const { day, startMin } = branchClock(off);
    if (startMin < 600 || startMin + DURATION[service] > 1320) continue;

    const a = await availability(day, [service], `&from=${startMin}&to=${Math.min(1320, startMin + 5)}&now=0`);
    if (a.status !== 200) blocked(`availability ${a.status}: ${messageOf(a)}`);
    const offer = (a.json.offers ?? []).find((o) => o.startMin === startMin);
    if (!offer) { tried.push(`${startMin}:nobody-free`); continue; }

    for (const staff of offer.staff ?? []) {
      const h = await call('POST', '/v1/holds', {
        day, services: [service], startMin, staffId: staff.id, channel: 'desk',
      });
      if (h.status !== 201) continue;
      trackHold(h.json.holdId);
      const c = await call('POST', '/v1/bookings', {
        holdId: h.json.holdId, day, services: [service], channel: 'desk',
        ...(opts.amountMinor !== undefined
          ? { amountMinor: opts.amountMinor, rail: 'CARD' }
          : {}),
      });
      if (c.status !== 201) blocked(`confirm ${c.status}: ${messageOf(c)}`);
      trackBooking(c.json.bookingId);
      return { booking: c.json, day, startMin, offsetMin: off };
    }
    tried.push(`${startMin}:all-refused`);
  }

  // Nothing in the range worked. Say which constraint bit, and when a run
  // would have to start for this case to be forceable at all.
  const latestNow = 1320 - DURATION[service] - loMin;
  const clock = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
  blocked(
    tried.length === 0
      ? `no start between +${loMin} and +${hiMin} minutes fits before the 22:00 close. ` +
          `Branch-local now is ${clock(nowMin)}; this case needs the run to start before ${clock(latestNow)}.`
      : `every start between +${loMin} and +${hiMin} minutes was unavailable ` +
          `(${tried.join(', ')}). The diary is full at that hour.`,
  );
}

const nearBooking = (lo, hi, opts) => clockBooking(lo, hi, opts);
const pastBooking = (min, opts) => clockBooking(-min, -min, opts);


// ========================================================== 3. MONEY

async function money() {
  heading('MONEY');

  await testCase('MON-1', 'Gold discount is 10% of services', async () => {
    const gold = await quoteFor(DAY, ['balayage'], 'nour');   // 72000
    const plain = await quoteFor(DAY, ['balayage'], 'dana');
    expect(gold.tier === 'GOLD', `nour came back as ${gold.tier}, expected GOLD`);
    expect(plain.tierDiscountMinor === 0, `a NONE-tier customer got ${plain.tierDiscountMinor} off`);
    const want = Math.round((gold.subtotalMinor * 10) / 100);
    expect(
      gold.tierDiscountMinor === want,
      `tierDiscount ${gold.tierDiscountMinor}, expected 10% of ${gold.subtotalMinor} = ${want}`,
    );
    return `subtotal ${gold.subtotalMinor} -> discount ${gold.tierDiscountMinor}`;
  });

  await testCase('MON-2', 'Gold discount never touches retail', async () => {
    const svc = ['gel-manicure']; // 18000
    const b = await bookingWithDeposit(DAY, svc, 'nour');
    await walkToCompleted(b.booking.bookingId);
    const retail = 50000;
    const r = await lifecycle(b.booking.bookingId, 'settle', {
      retailMinor: retail, rail: 'card',
    });
    expect(r.status === 201, `settle ${r.status}: ${messageOf(r)}`);
    const rc = r.json.receipt;
    const serviceSubtotal = AED(rc.subtotal) - retail;
    const wantDiscount = Math.round((serviceSubtotal * 10) / 100);
    expect(
      AED(rc.tierDiscount) === wantDiscount,
      `tierDiscount ${rc.tierDiscount} on a ${rc.subtotal} subtotal that includes ${retail} fils of retail; ` +
        `10% of services alone is ${wantDiscount} fils`,
    );
    return `subtotal ${rc.subtotal} (incl ${retail} retail), discount ${rc.tierDiscount} = 10% of services only`;
  });

  await testCase('MON-3', 'VAT is 5% of the discounted subtotal', async () => {
    for (const customerId of ['nour', 'dana']) {
      const q = await quoteFor(DAY, ['balayage', 'gel-manicure'], customerId);
      const want = Math.round((q.discountedSubtotalMinor * 5) / 100);
      expect(
        q.vatMinor === want,
        `${customerId}: VAT ${q.vatMinor}, expected 5% of the DISCOUNTED ${q.discountedSubtotalMinor} = ${want} ` +
          `(5% of the gross ${q.subtotalMinor} would be ${Math.round((q.subtotalMinor * 5) / 100)})`,
      );
      expect(
        q.totalMinor === q.discountedSubtotalMinor + q.vatMinor,
        `${customerId}: total ${q.totalMinor} != discounted ${q.discountedSubtotalMinor} + VAT ${q.vatMinor}`,
      );
    }
    return 'VAT on the discounted base for both a GOLD and a NONE customer';
  });

  await testCase('MON-4', 'Deposit is on the PRE-discount total', async () => {
    const basket = ['balayage'];
    const gold = await quoteFor(DAY, basket, 'nour');
    const plain = await quoteFor(DAY, basket, 'dana');
    expect(gold.tierDiscountMinor > 0, 'the GOLD customer got no discount, so this proves nothing');
    expect(
      gold.depositMinor === plain.depositMinor,
      `GOLD deposit ${gold.depositMinor} != NONE deposit ${plain.depositMinor} on the same basket -- ` +
        'the tier discount reached the deposit',
    );
    expect(
      gold.totalMinor < plain.totalMinor,
      'the GOLD total is not lower, so the discount did not apply at all',
    );
    return `same deposit ${gold.depositMinor} both tiers; totals ${gold.totalMinor} vs ${plain.totalMinor}`;
  });

  await testCase('MON-5', 'Split-equally: remainder to the earliest share, nothing lost', async () => {
    // Three lanes over a total that does not divide by three is what exposes
    // a naive divide: 3 x floor(total/3) loses fils, and only the
    // largest-remainder allocation sums back to the whole.
    const g = await groupOf(3, { arrangement: 'SPLIT' });
    const shares = g.bookings.map((b) => AED(b.share));
    const sum = shares.reduce((a, b) => a + b, 0);
    const detail = shares.map((s, i) => `${g.bookings[i].label}=${s}`).join(' ');

    expect(shares.every((s) => Number.isInteger(s)), `a share is not whole fils: ${detail}`);

    // NOTHING LOST is the real assertion: the parts must sum back to the
    // whole. The party is three hair services whose net is 46000; whether
    // the split runs on the net or the VAT-inclusive figure is the server's
    // business, so accept either total and refuse anything else.
    const net = 16000 + 16000 + 14000;
    const withVat = net + Math.round((net * 5) / 100);
    expect(
      sum === net || sum === withVat,
      `shares sum to ${sum}, which is neither the net ${net} nor the VAT-inclusive ` +
        `${withVat} -- fils were created or destroyed in the split: ${detail}`,
    );

    const spread = Math.max(...shares) - Math.min(...shares);
    expect(spread <= 1, `shares differ by ${spread} fils, more than a rounding remainder: ${detail}`);

    if (spread === 1) {
      expect(
        shares[0] === Math.max(...shares),
        `the extra fil went to ${g.bookings[shares.indexOf(Math.max(...shares))].label}, ` +
          `not the earliest share (${g.bookings[0].label}): ${detail}`,
      );
      return `${detail}, sum ${sum} = the whole, extra fil on the earliest share`;
    }
    return `${detail}, sum ${sum} = the whole; ${sum} divides evenly by 3 so no remainder arose`;
  });

  await testCase('MON-6', 'The ledger sums to zero after settlement', async () => {
    const b = await bookingWithDeposit(DAY, ['luxury-facial'], 'dana');
    await walkToCompleted(b.booking.bookingId);
    const r = await lifecycle(b.booking.bookingId, 'settle', { rail: 'card' });
    expect(r.status === 201, `settle ${r.status}: ${messageOf(r)}`);

    const detail = await readBooking(b.booking.bookingId);
    expect(detail.json.status === 'SETTLED', `status is ${detail.json.status}`);
    const ledger = detail.json.ledger ?? [];
    const sum = ledger.reduce((a, l) => a + l.amountMinor, 0);
    const shown = ledger.map((l) => `${l.entryType} ${l.amountMinor}`).join(', ');
    expect(
      sum === 0,
      `ledger sums to ${sum}, not 0 -- the deposit was not fully consumed at the till: [${shown}]`,
    );
    return `[${shown}] = 0`;
  });

  await testCase('MON-7', 'Refund lands: cancel more than 24h out', async () => {
    const b = await bookingWithDeposit(DAY, ['gel-manicure'], 'dana');
    const captured = b.booking.depositMinor;
    if (captured === 0) blocked('nothing was captured, so there is no refund to check');
    const r = await lifecycle(b.booking.bookingId, 'cancel', {
      reason: 'QA refund band', initiatedBy: 'CUSTOMER',
    });
    expect(r.status === 201, `cancel ${r.status}: ${messageOf(r)}`);
    expect(
      AED(r.json.refund) === captured && AED(r.json.kept) === 0,
      `refund ${r.json.refund} kept ${r.json.kept} against ${captured} fils captured, ` +
        `more than 24h out -- expected a full refund`,
    );
    expect(r.json.lateCancel === false, 'a cancel 30+ days out was flagged lateCancel');
    expect(
      AED(r.json.refund) + AED(r.json.kept) === captured,
      'refund + kept != captured -- money was invented or destroyed',
    );
    expect(r.json.paymentStatus === 'REFUNDED', `paymentStatus ${r.json.paymentStatus}`);
    return `${r.json.refund} refunded, ${r.json.kept} kept, of ${captured} fils`;
  });

  await testCase('MON-8', 'Forfeit lands: a no-show keeps the deposit', async () => {
    const b = await bookingWithDeposit(DAY, ['gel-manicure'], 'dana');
    const captured = b.booking.depositMinor;
    if (captured === 0) blocked('nothing was captured, so there is nothing to forfeit');
    const r = await lifecycle(b.booking.bookingId, 'no-show', {
      reason: 'QA forfeit band',
    });
    expect(r.status === 201, `no-show ${r.status}: ${messageOf(r)}`);
    expect(
      AED(r.json.kept) === captured && AED(r.json.refund) === 0,
      `kept ${r.json.kept} refund ${r.json.refund} against ${captured} captured -- expected a full forfeit`,
    );
    expect(
      AED(r.json.refund) + AED(r.json.kept) === captured,
      'refund + kept != captured',
    );
    expect(r.json.paymentStatus === 'FORFEITED', `paymentStatus ${r.json.paymentStatus}`);
    return `${r.json.kept} forfeited of ${captured} fils, "${r.json.explanation}"`;
  });

  await testCase('MON-9', 'A VIP standing reservation waives the no-show fee', async () => {
    const b = await bookingWithDeposit(DAY, ['gel-manicure'], 'rania');
    const captured = b.booking.depositMinor;
    if (captured === 0) blocked('nothing was captured');
    const r = await lifecycle(b.booking.bookingId, 'no-show', {
      reason: 'QA VIP waiver', vipStandingReservation: true,
    });
    expect(r.status === 201, `no-show ${r.status}: ${messageOf(r)}`);
    expect(
      AED(r.json.refund) === captured && AED(r.json.kept) === 0,
      `VIP waiver refunded ${r.json.refund} kept ${r.json.kept} of ${captured}`,
    );
    expect(
      AED(r.json.refund) + AED(r.json.kept) === captured,
      'refund + kept != captured',
    );
    return `${r.json.refund} waived of ${captured} fils`;
  });
}

/** confirmed -> checked_in -> in_service -> completed. */
async function walkToCompleted(id) {
  for (const step of ['check-in', 'start', 'complete']) {
    const r = await lifecycle(id, step, { reason: `QA ${step}` });
    if (r.status !== 201) blocked(`${step} ${r.status}: ${messageOf(r)}`);
  }
}

// ========================================================= 4. TIMERS

async function timers() {
  heading('TIMERS');

  await testCase('TIM-1', 'Auto no-show fires at start + 30', async () => {
    // The sweeper looks for confirmed bookings with start_at <= now - 30min,
    // every 60s. A booking placed on a start that is already 35 minutes past
    // is the only way to force that without touching the clock.
    const b = await pastBooking(35);
    console.log(`        ${C.dim('waiting up to 150s for the 60s no-show sweep')}`);
    const before = b.booking.status;
    for (let i = 0; i < 15; i++) {
      await sleep(10_000);
      const d = await readBooking(b.booking.bookingId);
      if (d.json.status === 'NO_SHOW') {
        const h = (d.json.history ?? []).find((x) => x.to === 'NO_SHOW');
        return `${before} -> NO_SHOW after ~${(i + 1) * 10}s, actor ${h?.actor ?? '?'}, reason "${h?.reason ?? ''}"`;
      }
    }
    const d = await readBooking(b.booking.bookingId);
    throw new Error(
      `still ${d.json.status} 150s after a start ${35} minutes in the past; ` +
        'the sweeper runs every 60s so two windows have passed',
    );
  });

  await testCase('TIM-2', 'A payment link expires and the booking follows', async () => {
    // linkWindow = min(now+6h, start-2h). A start ~2h10m out gives a window
    // of about ten minutes, which the 60s link sweeper will close.
    // The window is start - 2h - now, so the offset must clear 120 to leave
    // a window at all, and stay small so the wait is bearable. 123-135 gives
    // three to fifteen minutes.
    const b = await nearBooking(123, 140, { amountMinor: 1000 });
    const link = await call('POST', `/v1/bookings/${b.booking.bookingId}/payment-link`);
    if (link.status !== 201) blocked(`payment-link ${link.status}: ${messageOf(link)}`);
    const secs = link.json.expiresInSeconds;
    expect(secs > 0, `link already closed: expiresInSeconds ${secs}`);
    expect(
      link.json.cappedBy === 'START_MINUS_TWO',
      `cappedBy ${link.json.cappedBy}, expected START_MINUS_TWO for a start 2h10m out`,
    );
    if (secs > 900) {
      blocked(`the link window is ${secs}s; too long to wait out in a QA run`);
    }
    console.log(`        ${C.dim(`waiting ${secs + 90}s for the window to close and the 60s sweep`)}`);
    await sleep((secs + 90) * 1000);
    const d = await readBooking(b.booking.bookingId);
    expect(
      d.json.status === 'EXPIRED',
      `status is ${d.json.status} after the link window closed; expected EXPIRED`,
    );
    return `PENDING_PAYMENT -> EXPIRED after a ${secs}s window capped by ${link.json.cappedBy}`;
  });

  await testCase('TIM-3', 'A waitlist offer lapses', async () => {
    if (!SLOW) skipped('the offer TTL is 15 minutes; run with SLOW=yes');
    const join = await call('POST', '/v1/waitlist', {
      branchId: 'marina-walk', serviceId: 'gel-manicure', day: DAY,
      windowFromMin: 600, windowToMin: 1320, customerId: 'dana',
    });
    if (join.status !== 201) blocked(`waitlist join ${join.status}: ${messageOf(join)}`);
    created.waitlist.push(join.json.entryId);

    // An offer is only made when a booking frees a slot, so free one.
    const b = await freshBooking(DAY, ['gel-manicure']);
    const cancel = await lifecycle(b.booking.bookingId, 'cancel', {
      reason: 'QA free a slot to trigger a waitlist offer', initiatedBy: 'SALON',
    });
    expect(cancel.status === 201, `cancel ${cancel.status}: ${messageOf(cancel)}`);

    // There is no read endpoint for a waitlist entry, so the only observable
    // is what accept says: a live offer accepts, a lapsed one 404s.
    await sleep(5000);
    const early = await call('POST', `/v1/waitlist/${join.json.entryId}/accept`);
    if (early.status !== 201) {
      blocked(
        `no offer was made within 5s of freeing a slot (accept said ${early.status} ` +
          `"${messageOf(early)}"), so there is no offer to lapse`,
      );
    }
    blocked(
      'the offer was accepted immediately, which consumes it -- lapsing needs an ' +
        'offer left alone for 15 minutes AND a way to observe it, and there is no ' +
        'GET /v1/waitlist/:id. See FINDING-2.',
    );
  });

  await testCase('TIM-4', 'A hold expires and the capacity returns', async () => {
    if (!SLOW) skipped('HOLD_TTL_MS is 15 minutes; run with SLOW=yes');
    const { hold, offer, staffId } = await placeHold(DAY, ['gel-manicure']);
    expect(
      hold.expiresInSeconds > 840 && hold.expiresInSeconds <= 900,
      `expiresInSeconds ${hold.expiresInSeconds}, expected ~900`,
    );
    const waitMs = hold.expiresInSeconds * 1000 + 60_000; // + one sweep
    console.log(`        ${C.dim(`waiting ${Math.round(waitMs / 1000)}s for the TTL and the 30s sweep`)}`);
    await sleep(waitMs);
    const retake = await call('POST', '/v1/holds', {
      day: DAY, services: ['gel-manicure'], startMin: offer.startMin, staffId, channel: 'desk',
    });
    expect(
      retake.status === 201,
      `the slot was still blocked ${Math.round(waitMs / 1000)}s after the hold lapsed: ` +
        `${retake.status} "${messageOf(retake)}"`,
    );
    trackHold(retake.json.holdId);
    return `slot re-held at ${offer.start} after the TTL lapsed`;
  });
}

// ================================================== 5. STATE MACHINE

/**
 * Every route, and the statuses it is legal from. Anything else must be a
 * 409 naming both ends, never a 500 and never a silent success.
 */
const ROUTES = {
  'check-in': ['CONFIRMED'],
  start: ['CHECKED_IN'],
  complete: ['IN_SERVICE'],
  settle: ['COMPLETED'],
  cancel: ['PENDING_PAYMENT', 'CONFIRMED', 'CHECKED_IN'],
  'no-show': ['CONFIRMED', 'CHECKED_IN'],
};

async function stateMachine() {
  heading('STATE MACHINE');

  /** One booking parked in each status, reused by every probe below. */
  const parked = {};

  await testCase('ST-0', 'Park a booking in each reachable status', async () => {
    const mk = async (svc) => (await freshBooking(DAY, [svc])).booking.bookingId;

    parked.CONFIRMED = await mk('fringe-trim');

    parked.CHECKED_IN = await mk('fringe-trim');
    await lifecycle(parked.CHECKED_IN, 'check-in', { reason: 'QA' });

    parked.IN_SERVICE = await mk('fringe-trim');
    await lifecycle(parked.IN_SERVICE, 'check-in', { reason: 'QA' });
    await lifecycle(parked.IN_SERVICE, 'start', { reason: 'QA' });

    parked.COMPLETED = await mk('fringe-trim');
    await walkToCompleted(parked.COMPLETED);

    parked.SETTLED = await mk('fringe-trim');
    await walkToCompleted(parked.SETTLED);
    await lifecycle(parked.SETTLED, 'settle', { rail: 'card' });

    parked.CANCELLED = await mk('fringe-trim');
    await lifecycle(parked.CANCELLED, 'cancel', { reason: 'QA park', initiatedBy: 'SALON' });

    parked.NO_SHOW = await mk('fringe-trim');
    await lifecycle(parked.NO_SHOW, 'no-show', { reason: 'QA park' });

    const verified = [];
    for (const [want, id] of Object.entries(parked)) {
      const d = await readBooking(id);
      expect(d.json?.status === want, `parked ${want} is actually ${d.json?.status}`);
      verified.push(want);
    }
    return verified.join(', ');
  });

  await testCase('ST-1', 'Every illegal transition is refused', async () => {
    if (!parked.CONFIRMED) blocked('ST-0 did not park any bookings');
    const bad = [];
    let checked = 0;

    for (const [route, legalFrom] of Object.entries(ROUTES)) {
      for (const [status, id] of Object.entries(parked)) {
        if (legalFrom.includes(status)) continue;
        checked += 1;
        const r = await lifecycle(id, route, { reason: `QA illegal ${status}->${route}` });
        if (r.status === 201) {
          bad.push(`${status} --${route}--> ACCEPTED (now ${r.json?.to})`);
          continue;
        }
        if (r.status === 500) {
          bad.push(`${status} --${route}--> 500 Internal server error (broke, did not refuse)`);
          continue;
        }
        if (r.status !== 409) {
          bad.push(`${status} --${route}--> ${r.status} "${messageOf(r)}" (expected 409)`);
          continue;
        }
        const msg = messageOf(r);
        if (!/cannot become|cannot be/i.test(msg)) {
          bad.push(`${status} --${route}--> 409 but the message names nothing: "${msg}"`);
        }
      }
    }
    expect(bad.length === 0, `${bad.length} of ${checked} illegal transitions mishandled:\n        ` + bad.join('\n        '));
    return `${checked} illegal transitions, all refused with a 409 naming both ends`;
  });

  await testCase('ST-2', 'Terminal states stay terminal', async () => {
    if (!parked.SETTLED) blocked('ST-0 did not park any bookings');
    const bad = [];
    for (const status of ['SETTLED', 'CANCELLED', 'NO_SHOW']) {
      for (const route of Object.keys(ROUTES)) {
        const r = await lifecycle(parked[status], route, { reason: 'QA terminal probe' });
        if (r.status === 201) bad.push(`${status} moved via ${route}`);
      }
      const resched = await lifecycle(parked[status], 'reschedule', {
        holdId: randomUUID(), day: DAY, reason: 'QA terminal reschedule',
      });
      if (resched.status === 201) bad.push(`${status} was rescheduled`);
      if (resched.status === 500) bad.push(`${status} reschedule returned 500`);
    }
    expect(bad.length === 0, bad.join('; '));
    return 'settled, cancelled and no_show refused every route including reschedule';
  });

  await testCase('ST-3', 'Check-in has no arrival-window gate', async () => {
    // domain/booking/lifecycle.ts exports canCheckIn() with a too_early
    // verdict at start - 30. Nothing calls it. If that is deliberate the
    // case documents it; if not, this is the proof.
    const { booking } = await freshBooking(DAY, ['fringe-trim']);
    const r = await lifecycle(booking.bookingId, 'check-in', { reason: 'QA far-future check-in' });
    expect(
      r.status === 201,
      `check-in ${r.status}: ${messageOf(r)} -- if this now refuses, the gate was wired and this case is stale`,
    );
    throw new Error(
      `a booking on ${DAY} was checked in today. canCheckIn()'s too_early verdict ` +
        '(start - 30 min) is never called by any handler. See FINDING-3.',
    );
  });

  await testCase('ST-4', 'Group status derives from its participants', async () => {
    const g = await groupOf(2);
    const again = await call('POST', `/v1/groups/${g.groupId}/confirm`, {
      holdId: g.holdId,
      participants: g.bookings.map((b) => ({ label: b.label, serviceIds: ['fringe-trim'] })),
    });
    const msg = expectRefusal(again, [409, 410]);
    expect(
      /CONFIRMED/.test(msg),
      `a re-confirm of a confirmed party said "${msg}", which does not name the derived status`,
    );
    blocked(
      `derivation is observable only as CONFIRMED here ("${msg}"). Watching it fall to ` +
        'PARTIALLY_CONFIRMED and CANCELLED needs participants to leave, and a ' +
        'participant cannot be cancelled over HTTP. See FINDING-1.',
    );
  });
}

// ======================================================== teardown

async function teardown() {
  heading('CLEANUP');
  if (!CLEANUP) {
    console.log(`  ${C.skip}  CLEANUP=no -- ${created.holds.length} holds and ${created.bookings.length} bookings left behind`);
    return;
  }

  let released = 0, cancelled = 0, already = 0, failed = 0;

  for (const id of created.holds) {
    const r = await call('DELETE', `/v1/holds/${id}`);
    if (r.status === 200 && r.json?.released) released += 1;
    else if (r.status === 200) already += 1;
    else failed += 1;
  }

  for (const id of created.bookings) {
    const r = await lifecycle(id, 'cancel', {
      reason: `QA teardown ${TENANT}`, initiatedBy: 'SALON',
    });
    if (r.status === 201) cancelled += 1;
    else if (r.status === 409) already += 1; // terminal already: settled, no_show, cancelled
    else failed += 1;
  }

  console.log(`  holds:    ${released} released, ${created.holds.length - released - failed} already gone`);
  console.log(`  bookings: ${cancelled} cancelled, ${already} already terminal, ${failed} could not be closed`);
  console.log(`  groups:   ${created.groups.length} left as rows -- no HTTP route can cancel a party`);
  console.log(`  ${C.dim(`every row carries X-Tenant-Id: ${TENANT} on ${DAY}`)}`);
}

// ============================================================ main

async function main() {
  console.log(`\n\x1b[1mQA suite\x1b[0m  ${BASE}`);
  console.log(`run ${RUN}   day ${DAY}   tenant ${TENANT}   slow=${SLOW}   cleanup=${CLEANUP}\n`);

  const health = await call('GET', '/health', undefined, { token: null });
  if (health.status !== 200) {
    console.error(`/health returned ${health.status}. Stopping.`);
    process.exit(2);
  }
  console.log(`health ok, uptime ${Math.round((health.json.uptimeSeconds ?? 0) / 3600)}h`);

  if (AUTH_ONLY) {
    console.log(
      '\nJWT_ACCESS_SECRET is not set, so only the AUTH group runs. The other 30\n' +
        'cases all need a staff token, and guessing a production secret is not\n' +
        'something this script does.',
    );
    await auth();
  } else {
    const ok = await call('GET', '/v1/bookings/settings');
    if (ok.status === 401) {
      console.error(`\nAuth preflight: ${messageOf(ok)}. JWT_ACCESS_SECRET does not match the server.`);
      process.exit(2);
    }
    console.log('staff auth ok\n');
    try {
      await auth();
      await races();
      await refusals();
      await money();
      await timers();
      await stateMachine();
    } finally {
      await teardown();
    }
  }

  const by = (k) => results.filter((r) => r.kind === k).length;
  console.log(`\n\x1b[1m── SUMMARY ${'─'.repeat(52)}\x1b[0m`);
  for (const g of [...new Set(results.map((r) => r.group))]) {
    const rows = results.filter((r) => r.group === g);
    const p = rows.filter((r) => r.kind === 'PASS').length;
    console.log(`  ${g.padEnd(16)} ${p}/${rows.length} pass` +
      (rows.some((r) => r.kind === 'FAIL') ? `  \x1b[31m${rows.filter((r) => r.kind === 'FAIL').length} FAIL\x1b[0m` : '') +
      (rows.some((r) => r.kind === 'BLOCKED') ? `  \x1b[35m${rows.filter((r) => r.kind === 'BLOCKED').length} blocked\x1b[0m` : ''));
  }
  console.log(`\n  ${by('PASS')} pass   ${by('FAIL')} fail   ${by('BLOCKED')} blocked   ${by('SKIP')} skip\n`);

  if (by('FAIL') > 0) {
    console.log('\x1b[1mFAILURES\x1b[0m');
    for (const r of results.filter((x) => x.kind === 'FAIL')) {
      console.log(`  ${r.id} ${r.title}\n    ${r.detail}`);
    }
    console.log('');
  }
  if (by('BLOCKED') > 0) {
    console.log('\x1b[1mBLOCKED (each one is a finding, not a flake)\x1b[0m');
    for (const r of results.filter((x) => x.kind === 'BLOCKED')) {
      console.log(`  ${r.id} ${r.title}\n    ${r.detail}`);
    }
    console.log('');
  }

  process.exit(by('FAIL') > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('\nSuite aborted:', e);
  process.exit(3);
});
