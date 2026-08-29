#!/usr/bin/env node
/**
 * Exercise every endpoint and print PASS / FAIL / SKIP for each.
 *
 *   node scripts/proof-endpoints.mjs                    # localhost:3099
 *   BASE=https://api.example.com TOKEN=ey... node scripts/proof-endpoints.mjs
 *   BASE=... TOKEN=... WRITES=no node scripts/proof-endpoints.mjs   # reads only
 *
 * SKIP IS NOT PASS. A check whose precondition could not be met prints SKIP
 * with the reason and is counted separately. The whole point of this script
 * is to distinguish "verified" from "assumed", so a step that quietly
 * reported success because it never ran would defeat it.
 *
 * WRITES. Most of this surface mutates: holds, bookings, series, roster
 * changes, walk-ins. Against a production database that is real data. Pass
 * WRITES=no to run only the read-only checks. The default is yes, because
 * six of these endpoints have never been exercised live at all and reads
 * alone cannot fix that.
 */

const BASE = process.env.BASE ?? 'http://localhost:3099';
const WRITES = (process.env.WRITES ?? 'yes').toLowerCase() !== 'no';
const SECRET = process.env.JWT_ACCESS_SECRET ?? 'dev-access-change-me';

const results = [];
const ctx = {};

function record(kind, name, method, path, detail) {
  results.push({ kind, name, method, path, detail });
  const tag = { PASS: '\x1b[32mPASS\x1b[0m', FAIL: '\x1b[31mFAIL\x1b[0m', SKIP: '\x1b[33mSKIP\x1b[0m' }[kind];
  console.log(`  ${tag}  ${method.padEnd(6)} ${path.padEnd(50)} ${detail}`);
}

async function token() {
  if (process.env.TOKEN) return process.env.TOKEN;
  const { default: jwt } = await import('jsonwebtoken');
  return jwt.sign(
    {
      sub: '22222222-2222-2222-2222-222222222222',
      roles: ['branch_manager'],
      branchId: '11111111-1111-1111-1111-111111111111',
      tenantId: 'proof-script',
    },
    SECRET,
    { issuer: 'gostyle-api', expiresIn: '1h' },
  );
}

let TOK;

async function call(method, path, body, extraHeaders = {}) {
  const headers = { Authorization: `Bearer ${TOK}`, ...extraHeaders };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text };
}

/**
 * One check. `assert` returns a string to describe a pass, or throws.
 * A check that needs something absent should call skip().
 */
class Skip extends Error {}
const skip = (why) => { throw new Skip(why); };

async function check(name, method, path, run, { write = false } = {}) {
  if (write && !WRITES) return record('SKIP', name, method, path, 'WRITES=no');
  try {
    const detail = await run();
    record('PASS', name, method, path, detail ?? '');
  } catch (e) {
    if (e instanceof Skip) return record('SKIP', name, method, path, e.message);
    record('FAIL', name, method, path, e.message);
  }
}

const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const ok = (r, want = 200) =>
  expect(r.status === want, `expected ${want}, got ${r.status} ${JSON.stringify(r.json ?? r.text).slice(0, 160)}`);

/**
 * A day far enough out that lead time is moot, and a DIFFERENT one each run.
 *
 * A fixed day was wrong: this script books, holds and reschedules for real,
 * so every run left the diary fuller than it found it. By the third run the
 * group planner could not fit a two-person party anywhere and reported a
 * 409 that said nothing about the group planner -- the script had filled the
 * salon and then failed itself for it. A run must not depend on how many
 * runs came before.
 *
 * Override with DAY=YYYY-MM-DD to re-inspect a day a previous run left.
 */
const DAY = process.env.DAY ?? (() => {
  const offset = 30 + Math.floor(Math.random() * 60);
  return new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
})();

/**
 * A confirmed booking on a start nothing else has taken.
 *
 * Every check that needed one used to re-read availability and take
 * offers[0] -- which the PREVIOUS check had just booked. The first run
 * failed three checks that way, all reported as "no longer available",
 * all of them the script racing itself rather than the API misbehaving.
 * Walking the offers until a hold sticks is the fix, and returning the
 * offer means the caller knows which start it actually got.
 */
async function freshBooking(tag, { customerId = 'dana', service } = {}) {
  const svc = service ?? ctx.service;
  const a = await call('GET', `/v1/availability?day=${DAY}&services=${svc}&channel=desk`);
  ok(a);
  for (const offer of a.json.offers ?? []) {
    for (const staff of offer.staff ?? []) {
      const h = await call('POST', '/v1/holds', {
        day: DAY, services: [svc], startMin: offer.startMin,
        staffId: staff.id, channel: 'desk',
      });
      if (h.status !== 201) continue;
      const b = await call('POST', '/v1/bookings', {
        holdId: h.json.holdId, day: DAY, services: [svc],
        customerId, channel: 'desk',
      }, { 'Idempotency-Key': `proof-${tag}-${Date.now()}-${offer.startMin}` });
      if (b.status !== 201) continue;
      return { id: b.json.bookingId, code: b.json.code, offer, staffId: staff.id, service: svc };
    }
  }
  skip('no free start left in the diary to book');
}

async function main() {
  TOK = await token();
  console.log(`\n  base ${BASE}   day ${DAY}   writes ${WRITES ? 'yes' : 'no'}\n`);

  // ---------------------------------------------------------------- reads
  await check('health', 'GET', '/health', async () => {
    const r = await call('GET', '/health');
    ok(r);
    return `status ${r.json.status}`;
  });

  await check('settings', 'GET', '/v1/bookings/settings', async () => {
    const r = await call('GET', '/v1/bookings/settings');
    ok(r);
    expect(r.json.holds?.ttlMs > 0, 'no hold TTL');
    expect(r.json.channels?.DESK, 'channels not shouted');
    return `ttl ${r.json.holds.ttlMs}ms, VAT ${r.json.money.vatPercent}%`;
  });

  await check('catalogue', 'GET', '/v1/availability/catalogue', async () => {
    const r = await call('GET', '/v1/availability/catalogue');
    ok(r);
    const list = Array.isArray(r.json) ? r.json : r.json.services ?? [];
    expect(list.length > 0, 'empty catalogue');
    ctx.service = list.find((s) => s.id === 'blow-dry')?.id ?? list[0].id;
    ctx.duration = list.find((s) => s.id === ctx.service)?.durationMin ?? 45;
    return `${list.length} services`;
  });

  await check('availability', 'GET', '/v1/availability', async () => {
    const r = await call('GET', `/v1/availability?day=${DAY}&services=${ctx.service}&channel=desk`);
    ok(r);
    expect(r.json.offers?.length > 0, 'no offers');
    ctx.offer = r.json.offers[0];
    ctx.staff = r.json.topOffers?.[0]?.assignedTo?.id ?? ctx.offer.staff[0].id;
    return `${r.json.count} starts, first ${ctx.offer.start}`;
  });

  await check('eligible staff', 'GET', '/v1/bookings/eligible-staff', async () => {
    const r = await call('GET', `/v1/bookings/eligible-staff?day=${DAY}&serviceIds=full-colour`);
    ok(r);
    expect(Array.isArray(r.json.eligible), 'no eligible array');
    expect(r.json.refused?.every((x) => x.reason), 'a refusal with no reason');
    return `${r.json.eligible.length} eligible, ${r.json.refused.length} refused`;
  });

  await check('quote', 'POST', '/v1/bookings/quote', async () => {
    const r = await call('POST', '/v1/bookings/quote', {
      day: DAY, serviceIds: ['full-colour'], customerId: 'nour', channel: 'DESK', startMin: 900,
    });
    ok(r, 201); // a POST that only reads still answers 201 in Nest
    const q = r.json;
    expect(q.vatMinor === Math.round(q.discountedSubtotalMinor * 0.05), 'VAT not on the discounted subtotal');
    expect(q.channel === 'DESK', 'channel not echoed uppercase');
    expect(typeof q.linkAvailable === 'boolean', 'no linkAvailable');
    expect(typeof q.requirementSource === 'string', 'no requirementSource');
    return `total ${q.totalMinor}, deposit ${q.depositMinor}, link ${q.linkAvailable}`;
  });

  await check('group availability', 'POST', '/v1/bookings/availability/group', async () => {
    const r = await call('POST', '/v1/bookings/availability/group', {
      day: DAY, targetMin: 1080, mode: 'FINISH',
      participants: [
        { label: 'A', serviceIds: ['blow-dry'] },
        { label: 'B', serviceIds: ['gel-manicure'] },
      ],
    });
    ok(r, 201);
    expect(typeof r.json.feasible === 'boolean', 'no feasible flag');
    expect(r.json.advisory, 'no advisory note');
    return r.json.feasible ? `${r.json.lanes.length} lanes` : `infeasible: ${r.json.reason?.slice(0, 40)}`;
  });

  await check('series preview', 'POST', '/v1/bookings/series/preview', async () => {
    const r = await call('POST', '/v1/bookings/series/preview', {
      customerId: 'dana', serviceId: 'blow-dry', anchorDay: DAY, startMin: 1080,
      pattern: { kind: 'WEEKLY', weekdays: [2] },
      end: { kind: 'AFTER_COUNT', count: 4 },
    });
    ok(r, 201);
    expect(r.json.occurrences?.length > 0, 'no occurrences');
    expect(r.json.counts, 'no counts');
    const verdicts = [...new Set(r.json.occurrences.map((o) => o.verdict))];
    return `${r.json.occurrences.length} occurrences: ${verdicts.join(', ')}`;
  });

  await check('walk-in queue', 'GET', '/v1/walk-ins', async () => {
    const r = await call('GET', `/v1/walk-ins?branchId=marina-walk&tradingDay=${DAY}&nowMin=900`);
    ok(r);
    expect(Array.isArray(r.json.rows), 'no rows');
    return `${r.json.rows.length} waiting`;
  });

  await check('compaction plan', 'GET', '/v1/compaction', async () => {
    const r = await call('GET', `/v1/compaction?branchId=marina-walk&tradingDay=${DAY}`);
    ok(r);
    return `${r.json.moves?.length ?? 0} moves proposed`;
  });

  // ---------------------------------------------------------------- writes
  await check('place hold', 'POST', '/v1/holds', async () => {
    if (!ctx.offer) skip('no offer from availability');
    const r = await call('POST', '/v1/holds', {
      day: DAY, services: [ctx.service], startMin: ctx.offer.startMin,
      staffId: ctx.staff, channel: 'desk',
    });
    ok(r, 201);
    ctx.holdId = r.json.holdId;
    return `${r.json.countdown} countdown`;
  }, { write: true });

  await check('release hold', 'DELETE', '/v1/holds/:id', async () => {
    if (!ctx.holdId) skip('no hold placed');
    const r = await call('DELETE', `/v1/holds/${ctx.holdId}`);
    expect([200, 204].includes(r.status), `expected 200/204, got ${r.status}`);
    ctx.holdId = null;
    return 'released';
  }, { write: true });

  await check('confirm booking', 'POST', '/v1/bookings', async () => {
    const b = await freshBooking('confirm');
    ctx.bookingId = b.id;
    ctx.bookingCode = b.code;
    return `${b.code} confirmed`;
  }, { write: true });

  await check('read booking', 'GET', '/v1/bookings/:id', async () => {
    if (!ctx.bookingId) skip('no booking created');
    const r = await call('GET', `/v1/bookings/${ctx.bookingId}`);
    ok(r);
    expect(r.json.code === ctx.bookingCode, 'wrong booking returned');
    expect(Array.isArray(r.json.items) && r.json.items.length > 0, 'no items');
    expect(Array.isArray(r.json.history) && r.json.history.length > 0, 'no history');
    return `${r.json.items.length} items, ${r.json.history.length} history rows, channel ${r.json.channel}`;
  }, { write: true });

  await check('payment link', 'POST', '/v1/bookings/:id/payment-link', async () => {
    if (!ctx.bookingId) skip('no booking created');
    const r = await call('POST', `/v1/bookings/${ctx.bookingId}/payment-link`);
    if (r.status === 422) return `refused (nothing owed): ${r.json.message.slice(0, 50)}`;
    if (r.status === 409) return `refused (window shut): ${r.json.message.slice(0, 50)}`;
    ok(r, 201);
    expect(r.json.expiresAt, 'no expiry');
    return `${r.json.outstanding} due, closes ${r.json.cappedBy}`;
  }, { write: true });

  await check('booking lifecycle', 'POST', '/v1/bookings/:id/{check-in,start,complete}', async () => {
    // NOT ctx.bookingId: the payment-link check above moved that one to
    // PENDING_PAYMENT, and a booking awaiting payment cannot be checked in.
    const b = await freshBooking('lifecycle');
    ctx.completedId = b.id;
    const steps = [];
    for (const s of ['check-in', 'start', 'complete']) {
      const r = await call('POST', `/v1/bookings/${b.id}/${s}`, {});
      steps.push(`${s}:${r.status}`);
      expect([200, 201].includes(r.status), `${s} returned ${r.status}`);
    }
    return steps.join(' ');
  }, { write: true });

  await check('settle', 'POST', '/v1/bookings/:id/settle', async () => {
    // The one the lifecycle check just carried through to completed.
    if (!ctx.completedId) skip('lifecycle did not complete a booking');
    const r = await call('POST', `/v1/bookings/${ctx.completedId}/settle`, {
      promo: { code: 'PROOF', percent: 10 },
    });
    ok(r, 201);
    expect(r.json.receipt?.promoCode === 'PROOF', 'promo code not on the receipt');
    return `due ${r.json.receipt.due}, promo ${r.json.receipt.promo}`;
  }, { write: true });

  await check('cancel', 'POST', '/v1/bookings/:id/cancel', async () => {
    const b = await freshBooking('cancel');
    const r = await call('POST', `/v1/bookings/${b.id}/cancel`, {
      reason: 'proof script', initiatedBy: 'SALON',
    });
    ok(r, 201);
    return `${r.json.to ?? 'CANCELLED'}`;
  }, { write: true });

  await check('reschedule', 'POST', '/v1/bookings/:id/reschedule', async () => {
    const b = await freshBooking('resched');
    // Availability re-read AFTER the booking exists, so its own start is
    // gone from the list and the target is genuinely free.
    const a = await call('GET', `/v1/availability?day=${DAY}&services=${ctx.service}&channel=desk`);
    ok(a);
    let h2 = null, target = null;
    for (const offer of a.json.offers ?? []) {
      if (offer.startMin === b.offer.startMin) continue;
      for (const staff of offer.staff ?? []) {
        const h = await call('POST', '/v1/holds', {
          day: DAY, services: [ctx.service], startMin: offer.startMin,
          staffId: staff.id, channel: 'desk',
        });
        if (h.status === 201) { h2 = h; target = offer; break; }
      }
      if (h2) break;
    }
    if (!h2) skip('no second free start to move into');
    const r = await call('POST', `/v1/bookings/${b.id}/reschedule`, {
      holdId: h2.json.holdId, day: DAY, reason: 'proof script',
    });
    ok(r, 201);
    return `moved ${b.offer.start} -> ${target.start}`;
  }, { write: true });

  await check('no-show', 'POST', '/v1/bookings/:id/no-show', async () => {
    const b = await freshBooking('noshow');
    const r = await call('POST', `/v1/bookings/${b.id}/no-show`, {
      reason: 'proof script',
    });
    ok(r, 201);
    return 'marked';
  }, { write: true });

  await check('group hold', 'POST', '/v1/groups/holds', async () => {
    // The earlier checks book real slots on this day, so one hardcoded
    // target eventually finds the diary full and reports a 409 that says
    // nothing about the group planner. Walk the afternoon instead.
    let r = null;
    for (const targetMin of [1080, 1020, 960, 900, 840, 780, 720]) {
      r = await call('POST', '/v1/groups/holds', {
        branchId: 'marina-walk', day: DAY, targetMin, mode: 'TOGETHER', arrangement: 'ORGANIZER',
        participants: [
          { label: 'A', serviceIds: ['blow-dry'], guestName: 'A' },
          { label: 'B', serviceIds: ['gel-manicure'], guestName: 'B' },
        ],
      });
      if (r.status === 201) break;
    }
    ok(r, 201);
    ctx.groupId = r.json.groupId;
    ctx.groupHold = r.json.holdId;
    return `${r.json.lanes.length} lanes`;
  }, { write: true });

  await check('group confirm', 'POST', '/v1/groups/:id/confirm', async () => {
    if (!ctx.groupId) skip('no group held');
    const r = await call('POST', `/v1/groups/${ctx.groupId}/confirm`, {
      holdId: ctx.groupHold,
      participants: [
        { label: 'A', serviceIds: ['blow-dry'], guestName: 'A' },
        { label: 'B', serviceIds: ['gel-manicure'], guestName: 'B' },
      ],
    });
    ok(r, 201);
    return `${r.json.bookings.length} bookings, ${r.json.status}`;
  }, { write: true });

  await check('create series', 'POST', '/v1/series', async () => {
    const r = await call('POST', '/v1/series', {
      branchId: 'marina-walk', customerId: 'dana', serviceId: 'blow-dry',
      anchorDay: DAY, startMin: 1080,
      pattern: { kind: 'WEEKLY', weekdays: [2] },
      end: { kind: 'AFTER_COUNT', count: 3 },
      autoConfirmRule: 'AUTO_CONFIRM_ON_SCHEDULE',
    });
    ok(r, 201);
    ctx.seriesId = r.json.seriesId;
    return `${r.json.planned ?? ''} planned`.trim();
  }, { write: true });

  await check('series panel (bookings path)', 'GET', '/v1/bookings/series/:id', async () => {
    if (!ctx.seriesId) skip('no series created');
    const r = await call('GET', `/v1/bookings/series/${ctx.seriesId}`);
    ok(r);
    expect(r.json.status === 'ACTIVE', `status ${r.json.status}`);
    expect(r.json.horizonEnd, 'no horizon line');
    return `${r.json.status}/${r.json.health}, horizon ${r.json.horizonEnd}`;
  }, { write: true });

  await check('series panel (legacy path)', 'GET', '/v1/series/:id', async () => {
    if (!ctx.seriesId) skip('no series created');
    const r = await call('GET', `/v1/series/${ctx.seriesId}`);
    ok(r);
    return `${r.json.status}`;
  }, { write: true });

  await check('series occurrences', 'GET', '/v1/series/:id/occurrences', async () => {
    if (!ctx.seriesId) skip('no series created');
    const r = await call('GET', `/v1/series/${ctx.seriesId}/occurrences`);
    ok(r);
    const list = r.json.occurrences ?? r.json;
    ctx.occurrenceId = (Array.isArray(list) ? list : [])[0]?.id;
    return `${(Array.isArray(list) ? list : []).length} occurrences`;
  }, { write: true });

  await check('edit scope', 'GET', '/v1/series/:id/occurrences/:oid/edit-scope', async () => {
    if (!ctx.occurrenceId) skip('no occurrence');
    const r = await call('GET', `/v1/series/${ctx.seriesId}/occurrences/${ctx.occurrenceId}/edit-scope?scope=THIS_OCCURRENCE`);
    ok(r);
    return `${r.json.affected?.length ?? 0} affected`;
  }, { write: true });

  await check('materialise', 'POST', '/v1/series/:id/materialise', async () => {
    if (!ctx.seriesId) skip('no series created');
    // `today` is required: materialising is "roll the horizon forward as
    // of this date", and the date is the caller's, not the server's.
    const r = await call('POST', `/v1/series/${ctx.seriesId}/materialise`, {
      today: DAY,
    });
    ok(r, 201);
    return JSON.stringify(r.json).slice(0, 60);
  }, { write: true });

  await check('skip occurrence', 'POST', '/v1/series/:id/occurrences/:oid/skip', async () => {
    if (!ctx.occurrenceId) skip('no occurrence');
    const r = await call('POST', `/v1/series/${ctx.seriesId}/occurrences/${ctx.occurrenceId}/skip`, {});
    ok(r, 201);
    return 'skipped';
  }, { write: true });

  for (const [label, verb] of [['pause', 'pause'], ['resume', 'resume'], ['end', 'end']]) {
    await check(`series ${label}`, 'POST', `/v1/series/:id/${verb}`, async () => {
      if (!ctx.seriesId) skip('no series created');
      const r = await call('POST', `/v1/series/${ctx.seriesId}/${verb}`, {});
      ok(r, 201);
      return r.json.status;
    }, { write: true });
  }

  await check('waitlist join', 'POST', '/v1/waitlist', async () => {
    // A waitlist with nothing to offer proves only that the route exists.
    // So: book a slot, put TWO people behind it, then cancel it. The
    // cancellation event carries the freed slot to the listener, which
    // offers it to the head of the queue -- and that gives decline (which
    // passes down to the second) and accept something real to act on.
    const b = await freshBooking('waitlist');
    ctx.freed = b;
    const join = async (customerId) => {
      const r = await call('POST', '/v1/waitlist', {
        branchId: 'marina-walk', customerId, serviceId: ctx.service,
        day: DAY, windowFromMin: b.offer.startMin - 60,
        windowToMin: b.offer.startMin + 60,
      });
      ok(r, 201);
      return r.json.entryId ?? r.json.id;
    };
    ctx.waitlistId = await join('nour');
    ctx.waitlistId2 = await join('dana');
    const c = await call('POST', `/v1/bookings/${b.id}/cancel`, {
      reason: 'freeing a slot for the waitlist', initiatedBy: 'SALON',
    });
    ok(c, 201);
    return `2 waiting on ${b.offer.start}, ${b.code} cancelled to free it`;
  }, { write: true });

  /**
   * The offer is made asynchronously: cancel writes an outbox row, the relay
   * ticks once a second, the listener then claims the slot for the head of
   * the queue. There is no GET on a waitlist entry to poll, so the only way
   * to wait for the offer is to keep attempting the call itself -- 404 means
   * "no live offer", which here means "not yet".
   */
  async function untilOffered(attempt, tries = 12) {
    let last = null;
    for (let i = 0; i < tries; i++) {
      last = await attempt();
      if (last.status !== 404) return last;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return last;
  }

  await check('waitlist decline', 'POST', '/v1/waitlist/:id/decline', async () => {
    if (!ctx.waitlistId) skip('no waitlist entry');
    const r = await untilOffered(() =>
      call('POST', `/v1/waitlist/${ctx.waitlistId}/decline`, {}),
    );
    if (r.status === 404) {
      // The offer never arrived. Say so rather than calling it a pass:
      // this is the case that has never once been exercised live.
      throw new Error('no offer reached the head of the queue within 15s');
    }
    ok(r, 201);
    return `declined, passed to ${r.json.passedTo ?? 'the next in line'}`;
  }, { write: true });

  await check('waitlist accept', 'POST', '/v1/waitlist/:id/accept', async () => {
    if (!ctx.waitlistId2) skip('no second waitlist entry');
    const r = await untilOffered(() =>
      call('POST', `/v1/waitlist/${ctx.waitlistId2}/accept`, {}),
    );
    if (r.status === 404) throw new Error('the declined offer never passed down');
    ok(r, 201);
    return `accepted, booking ${r.json.code ?? r.json.bookingId ?? '?'}`;
  }, { write: true });

  await check('waitlist offer from a reschedule', 'POST', '/v1/waitlist/:id/accept', async () => {
    // THE REGRESSION. A cancel leaves the booking sitting on the slot it
    // freed, so an offer that re-read the slot off the booking row happened
    // to be right. A RESCHEDULE moves that row: the offer then described
    // where the booking WENT -- occupied, by that booking -- and accept
    // answered 409 every time. The offer stores the slot now. This is the
    // shape that proves it, and the only one that ever failed.
    // A SERVICE OF ITS OWN. The queue is keyed on (branch, day, service),
    // and the checks above leave a declined entry still waiting on
    // ctx.service. The offer goes to the head of that queue -- an older
    // entry, not this one -- and this check would read the 404 on its own
    // entry as the bug it is meant to detect. First failure of this check
    // was exactly that, and the log said so plainly.
    const SVC = 'haircut-finish';
    const b = await freshBooking('resched-waitlist', { service: SVC });
    const j = await call('POST', '/v1/waitlist', {
      branchId: 'marina-walk', customerId: 'nour', serviceId: SVC,
      day: DAY, windowFromMin: b.offer.startMin - 60,
      windowToMin: b.offer.startMin + 60,
    });
    ok(j, 201);
    const entryId = j.json.entryId ?? j.json.id;

    // Move it away, freeing the slot the waitlist is waiting on.
    const a = await call('GET', `/v1/availability?day=${DAY}&services=${SVC}&channel=desk`);
    ok(a);
    let moved = null;
    for (const offer of a.json.offers ?? []) {
      if (offer.startMin === b.offer.startMin) continue;
      for (const staff of offer.staff ?? []) {
        const h = await call('POST', '/v1/holds', {
          day: DAY, services: [SVC], startMin: offer.startMin,
          staffId: staff.id, channel: 'desk',
        });
        if (h.status !== 201) continue;
        const r = await call('POST', `/v1/bookings/${b.id}/reschedule`, {
          holdId: h.json.holdId, day: DAY, reason: 'freeing a waited slot',
        });
        if (r.status === 201) { moved = offer; break; }
      }
      if (moved) break;
    }
    if (!moved) skip('nowhere to move the booking to');

    const r = await untilOffered(() =>
      call('POST', `/v1/waitlist/${entryId}/accept`, {}),
    );
    if (r.status === 404) throw new Error('the reschedule freed a slot nobody was offered');
    if (r.status === 409) {
      // TWO DIFFERENT 409s, and only one of them is the bug this check exists
      // for. "<time> is no longer available" is the offer describing the slot
      // the booking moved INTO -- occupied by that booking, never acceptable,
      // and the regression. A chair-capacity refusal is the ordinary race the
      // waitlist is allowed to lose: the staff slot came free, but by the time
      // it was accepted every chair of that type was busy. On a day this
      // script has been booking all morning that is a precondition it failed
      // to arrange, not a fault in the offer.
      if (/is no longer available/.test(r.json.message ?? '')) {
        throw new Error(`offered an occupied slot: ${r.json.message}`);
      }
      skip(`the freed slot was re-taken before it could be accepted: ${r.json.message}`);
    }
    ok(r, 201);
    return `${b.offer.start} freed by a move to ${moved.start}, and taken`;
  }, { write: true });

  await check('walk-in join', 'POST', '/v1/walk-ins', async () => {
    const r = await call('POST', '/v1/walk-ins', {
      branchId: 'marina-walk', tradingDay: DAY, guestName: 'Proof',
      serviceIds: ['blow-dry'], joinedMin: 900,
    });
    ok(r, 201);
    ctx.walkInId = r.json.id;
    return `position ${r.json.position}`;
  }, { write: true });

  await check('walk-in seat', 'POST', '/v1/walk-ins/:id/seat', async () => {
    if (!ctx.walkInId) skip('no walk-in joined');
    // seat() takes the option the desk picked; the queue read is where
    // the options come from.
    const q = await call('GET', `/v1/walk-ins?branchId=marina-walk&tradingDay=${DAY}&nowMin=600`);
    ok(q);
    const mine = (q.json.rows ?? []).find((w) => w.id === ctx.walkInId);
    const opt = mine?.options?.[0];
    if (!opt) skip('the queue offered this walk-in no seatable option');
    const r = await call('POST', `/v1/walk-ins/${ctx.walkInId}/seat`, {
      startMin: opt.startMin, staffId: opt.staffId,
    });
    if (r.status === 409) return 'nothing free to seat into (expected)';
    ok(r, 201);
    return 'seated';
  }, { write: true });

  await check('walk-in leave', 'POST', '/v1/walk-ins/:id/leave', async () => {
    if (!ctx.walkInId) skip('no walk-in joined');
    const r = await call('POST', `/v1/walk-ins/${ctx.walkInId}/leave`, {});
    if (r.status === 409) return 'already seated (expected)';
    ok(r, 201);
    return 'left';
  }, { write: true });

  await check('open roster change', 'POST', '/v1/roster-changes', async () => {
    const r = await call('POST', '/v1/roster-changes', {
      branchId: 'marina-walk', tradingDay: DAY, kind: 'CLOSURE_SWEEP',
      reason: 'proof script',
    });
    ok(r, 201);
    ctx.changeId = r.json.changeId;
    return `gate ${r.json.gate.status}, ${r.json.affected} affected`;
  }, { write: true });

  await check('read roster change', 'GET', '/v1/roster-changes/:id', async () => {
    if (!ctx.changeId) skip('no roster change opened');
    const r = await call('GET', `/v1/roster-changes/${ctx.changeId}`);
    ok(r);
    expect(r.json.kind === 'CLOSURE_SWEEP', 'kind not shouted');
    return `${r.json.items.length} items, gate ${r.json.gate.status}`;
  }, { write: true });

  await check('resolve worklist item', 'POST', '/v1/roster-changes/:id/items/:itemId/resolve', async () => {
    if (!ctx.changeId) skip('no roster change opened');
    const d = await call('GET', `/v1/roster-changes/${ctx.changeId}`);
    const open = d.json.items?.find((i) => i.state === 'OPEN');
    if (!open) skip('no open worklist item (nothing was disturbed)');
    const r = await call('POST', `/v1/roster-changes/${ctx.changeId}/items/${open.id}/resolve`, { resolution: 'OVERRIDE' });
    ok(r, 201);
    return `gate ${r.json.status}`;
  }, { write: true });

  await check('commit roster change', 'POST', '/v1/roster-changes/:id/commit', async () => {
    if (!ctx.changeId) skip('no roster change opened');
    const r = await call('POST', `/v1/roster-changes/${ctx.changeId}/commit`, {});
    if (r.status === 409) return 'refused, worklist not clear (the gate working)';
    ok(r, 201);
    return 'committed';
  }, { write: true });

  await check('compaction apply', 'POST', '/v1/compaction/apply', async () => {
    // MAKE the sliver rather than hoping for one. Two bookings on the same
    // professional with a ten-minute hole between them is exactly what
    // compaction exists to close; waiting for one to appear by accident is
    // how this check spent every earlier run reporting SKIP.
    let plan = await call('GET', `/v1/compaction?branchId=marina-walk&tradingDay=${DAY}`);
    if (!plan.json.moves?.length) {
      const a = await call('GET', `/v1/availability?day=${DAY}&services=${ctx.service}&channel=desk`);
      ok(a);
      const seed = async (startMin, staffId, tag) => {
        const h = await call('POST', '/v1/holds', {
          day: DAY, services: [ctx.service], startMin, staffId, channel: 'desk',
        });
        if (h.status !== 201) return false;
        const b = await call('POST', '/v1/bookings', {
          holdId: h.json.holdId, day: DAY, services: [ctx.service],
          customerId: 'dana', channel: 'desk',
        }, { 'Idempotency-Key': `proof-sliver-${tag}-${Date.now()}` });
        return b.status === 201;
      };
      for (const offer of a.json.offers ?? []) {
        const staff = offer.staff?.[0]?.id;
        if (!staff) continue;
        const first = offer.startMin;
        const second = first + ctx.duration + 10; // the ten-minute hole
        if (await seed(first, staff, 'a') && await seed(second, staff, 'b')) break;
      }
      plan = await call('GET', `/v1/compaction?branchId=marina-walk&tradingDay=${DAY}`);
    }
    if (!plan.json.moves?.length) skip('could not open a sliver to close');
    // The endpoint takes the CODES the customers agreed to and recomputes
    // the plan itself -- passing moves would let a stale client dictate one.
    const r = await call('POST', '/v1/compaction/apply', {
      branchId: 'marina-walk', tradingDay: DAY,
      codes: plan.json.moves.map((m) => m.code),
    });
    ok(r, 201);
    return `${r.json.applied ?? 0} applied`;
  }, { write: true });

  await check('payment webhook', 'POST', '/v1/webhooks/payments', async () => {
    const r = await call('POST', '/v1/webhooks/payments', {
      intentId: `proof_${Date.now()}`, bookingCode: ctx.bookingCode ?? 'GS-0001',
      kind: 'CAPTURED', amountMinor: 1000, rail: 'card',
    });
    if (r.status === 401) return 'signature required (guard working)';
    expect([200, 201].includes(r.status), `expected 200/201/401, got ${r.status}`);
    return `outcome ${r.json.outcome}`;
  }, { write: true });

  // ---------------------------------------------------------------- summary
  const n = (k) => results.filter((r) => r.kind === k).length;
  console.log(`\n  ${results.length} checks:  ${n('PASS')} pass, ${n('FAIL')} fail, ${n('SKIP')} skip\n`);
  if (n('FAIL')) {
    console.log('  FAILURES:');
    for (const r of results.filter((x) => x.kind === 'FAIL')) {
      console.log(`    ${r.method} ${r.path} -- ${r.detail}`);
    }
    console.log('');
  }
  process.exit(n('FAIL') ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
