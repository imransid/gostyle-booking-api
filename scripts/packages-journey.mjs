#!/usr/bin/env node
/**
 * Packages, proven on the running system (CLAUDE.md 5).
 *
 * Unit tests prove the arithmetic; this proves the wiring, the columns and
 * the platform call, end to end, against real Postgres and real gRPC. Every
 * step prints PASS or FAIL; a MUST FAIL step passes only when it is refused.
 * Exit code is the number of failures.
 *
 * THREE booking-api instances, all on THIS machine and one throwaway
 * database (never production -- see scripts/qa-suite.mjs, whose default
 * pointed at the live server and left test bookings there):
 *
 *   DEMO_API  the fixture's demo salon ("marina-walk") -- any instance
 *   DOWN_API  PACKAGES_FROM_PLATFORM on, its platform WITHOUT ListPackages
 *             (the local platform-api container predates it)
 *   REAL_API  PACKAGES_FROM_PLATFORM on, its platform WITH ListPackages
 *
 *   DEMO_API=http://localhost:3199 DOWN_API=http://localhost:3199 \
 *   REAL_API=http://localhost:3198 PROOF_DB=gostyle_booking_packages_proof \
 *   node scripts/packages-journey.mjs
 *
 * Each needs SERVICES_FROM_PLATFORM=true and SKILLS_UNVERIFIED=true; REAL_API
 * runs with STAFF_FROM_PLATFORM=false when its platform serves only the
 * services directory. Run it against a FRESH database: it books real slots.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required (see the header)`);
  return v;
};
const DEMO_API = env('DEMO_API');
const DOWN_API = env('DOWN_API');
const REAL_API = env('REAL_API');
const PROOF_DB = env('PROOF_DB');
for (const url of [DEMO_API, DOWN_API, REAL_API]) {
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) {
    throw new Error(`refusing ${url}: this journey runs on this machine only`);
  }
}
if (!/proof|test/.test(PROOF_DB)) {
  throw new Error(`refusing database ${PROOF_DB}: use a throwaway one`);
}

const SECRET =
  process.env.JWT_ACCESS_SECRET ??
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .find((l) => l.startsWith('JWT_ACCESS_SECRET='))
    ?.slice('JWT_ACCESS_SECRET='.length)
    .replace(/^"|"$/g, '');

const TENANT = '11111111-1111-1111-1111-111111111111';
const REAL_BRANCH = '22222222-2222-2222-2222-222222222222';
const GROOM = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';
const CUT = '66666666-6666-6666-6666-666666666660';
const DAY = process.env.DAY ?? '2026-10-27';

const desk = (branchId) =>
  jwt.sign(
    {
      sub: '99999999-9999-9999-9999-999999999990',
      sid: 'packages-journey',
      tenantId: TENANT,
      roles: ['OWNER'],
      branchId,
    },
    SECRET,
    { issuer: 'gostyle-api', expiresIn: '30m' },
  );
const DEMO_DESK = desk('marina-walk');
const REAL_DESK = desk(REAL_BRANCH);

async function call(base, token, method, path, body) {
  const res = await fetch(`${base}/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Tenant-Id': TENANT,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

function sql(query) {
  return execFileSync(
    'psql',
    ['-h', 'localhost', '-U', 'postgres', '-d', PROOF_DB, '-XAtq', '-F', '|', '-c', query],
    { encoding: 'utf8' },
  ).trim();
}

let failures = 0;
let n = 0;
function check(title, ok, detail = '') {
  n += 1;
  const word = ok ? 'PASS' : 'FAIL';
  if (!ok) failures += 1;
  console.log(`${word}  ${String(n).padStart(2)}. ${title}${detail ? `\n          ${detail}` : ''}`);
}
const section = (t) => console.log(`\n=== ${t} ===`);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

// ------------------------------------------------------------- the demo salon
section('A. The demo salon, at the desk: Colour and finish, AED 560 for AED 620 of parts');

const list = await call(DEMO_API, DEMO_DESK, 'GET', '/packages');
const cf = list.body?.packages?.find((p) => p.packageId === 'colour-and-finish');
check(
  'GET /v1/packages lists it at its price, the parts carrying it',
  list.status === 200 &&
    cf?.priceMinor === 56000 &&
    cf?.savingMinor === 6000 &&
    sum(cf.parts.map((p) => p.priceMinor)) === 56000,
  `status ${list.status}, price ${cf?.priceMinor}, parts ${cf?.parts?.map((p) => p.priceMinor).join(' + ')}`,
);

const quote = await call(DEMO_API, DEMO_DESK, 'POST', '/bookings/quote', {
  day: DAY,
  serviceIds: ['colour-and-finish'],
  customerId: 'dana',
  channel: 'DESK',
  startMin: 610,
});
check(
  'quote: AED 560 net, VAT 28, AED 588, no bundle line',
  quote.status === 201 &&
    quote.body.subtotalMinor === 56000 &&
    quote.body.vatMinor === 2800 &&
    quote.body.totalMinor === 58800 &&
    quote.body.bundleDiscountMinor === 0 &&
    !quote.body.quote.some((l) => l.label === 'Bundle discount'),
  `status ${quote.status}, ${quote.body?.subtotalMinor} + ${quote.body?.vatMinor} = ${quote.body?.totalMinor}, deposit ${quote.body?.depositMinor}`,
);

const hold = await call(DEMO_API, DEMO_DESK, 'POST', '/holds', {
  branch: 'marina-walk',
  day: DAY,
  services: ['colour-and-finish'],
  // 10:10: the demo salon's first free start for a colour (10:00 is not).
  startMin: 610,
  customerId: 'dana',
});
const holdTypes = hold.body?.holdId
  ? sql(`SELECT string_agg(resource_type, ',' ORDER BY start_minute) FROM resource_reservation WHERE hold_id = '${hold.body.holdId}'`)
  : '';
// A station per stretch of the chain: the colour's (its processing band
// splits it in two) and then the blow-dry's styling chair.
const perPart = (types) =>
  types.split(',').includes('color') && types.endsWith('styling');
check(
  'hold: a station per part (colour, then styling), not one for the whole visit',
  hold.status === 201 && perPart(holdTypes),
  `status ${hold.status}, stations [${holdTypes}]`,
);

const deposit = quote.body?.depositMinor ?? 0;
const confirm = await call(DEMO_API, DEMO_DESK, 'POST', '/bookings', {
  holdId: hold.body?.holdId,
  branch: 'marina-walk',
  day: DAY,
  services: ['colour-and-finish'],
  customerId: 'dana',
  channel: 'desk',
  ...(deposit > 0 ? { amountMinor: deposit, rail: 'CASH' } : {}),
});
const bookingId = confirm.body?.bookingId;
check(
  'confirm: the booking is AED 588 with VAT',
  confirm.status === 201 && confirm.body.totalMinor === 58800,
  `status ${confirm.status}, total ${confirm.body?.totalMinor}, ${confirm.body?.paymentStatus}`,
);

const drawer = bookingId
  ? await call(DEMO_API, DEMO_DESK, 'GET', `/bookings/${bookingId}`)
  : { status: 0, body: {} };
check(
  'the desk drawer: price AED 560 and the package named',
  drawer.status === 200 &&
    drawer.body.priceMinor === 56000 &&
    drawer.body.packages?.[0]?.name === 'Colour and finish' &&
    drawer.body.packages?.[0]?.priceMinor === 56000,
  `price ${drawer.body?.priceMinor}, packages ${JSON.stringify(drawer.body?.packages?.map((p) => [p.name, p.priceMinor]))}`,
);

const rows = bookingId
  ? sql(`SELECT b.price_fils, b.net_fils, b.tax_fils, b.discount_fils,
            (SELECT sum(price_fils) FROM booking_item WHERE booking_id = b.id),
            (SELECT count(*) FROM booking_item WHERE booking_id = b.id AND package_name = 'Colour and finish' AND package_id IS NOT NULL)
       FROM booking b WHERE b.id = '${bookingId}'`)
  : '';
check(
  'stored: price_fils 56000, the items add up to it, both carry the package',
  rows === '56000|56000|2800|0|56000|2',
  `price|net|tax|discount|sum(items)|items with the package = ${rows}`,
);

const refused = await call(DEMO_API, DEMO_DESK, 'POST', '/bookings/quote', {
  day: DAY,
  serviceIds: ['no-such-package'],
  customerId: 'dana',
  channel: 'DESK',
  startMin: 600,
});
check(
  'MUST FAIL: an id that is neither a service nor a package',
  refused.status === 404,
  `status ${refused.status}: ${refused.body?.message}`,
);

// ------------------------------------------------------------------ walk-in
section('B. A walk-in asking for the package');

const join = await call(DEMO_API, DEMO_DESK, 'POST', '/walk-ins', {
  tradingDay: DAY,
  guestName: 'Proof Walker',
  serviceIds: ['colour-and-finish'],
  joinedMin: 700,
});
const walkInId = join.body?.id;
check(
  'join: answers with the parts, as documented',
  join.status === 201 &&
    JSON.stringify(join.body.serviceIds) === '["full-colour","blow-dry"]',
  `status ${join.status}, ${JSON.stringify(join.body?.serviceIds)}`,
);
const stored = walkInId
  ? sql(`SELECT array_to_string(service_ids, ',') FROM walk_in_entry WHERE id = '${walkInId}'`)
  : '';
check('stored: the queue keeps the package itself', stored === 'colour-and-finish', `service_ids = {${stored}}`);

const queue = await call(DEMO_API, DEMO_DESK, 'GET', `/walk-ins?tradingDay=${DAY}`);
const qrow = queue.body?.rows?.find((r) => r.id === walkInId);
const option = qrow?.options?.find((o) => o.startMin >= 720) ?? qrow?.options?.[0];
check(
  'the queue still finds them a start, expanding the package',
  queue.status === 200 && option !== undefined,
  `status ${queue.status}, ${qrow?.options?.length ?? 0} option(s)`,
);

const seat = option
  ? await call(DEMO_API, DEMO_DESK, 'POST', `/walk-ins/${walkInId}/seat`, {
      startMin: option.startMin,
      staffId: option.staffId,
    })
  : { status: 0, body: {} };
const seatTypes = seat.body?.holdId
  ? sql(`SELECT string_agg(resource_type, ',' ORDER BY start_minute) FROM resource_reservation WHERE hold_id = '${seat.body.holdId}'`)
  : '';
check(
  'seat: hands the desk the package, and holds exactly what an ordinary hold does',
  seat.status === 201 &&
    JSON.stringify(seat.body.serviceIds) === '["colour-and-finish"]' &&
    seatTypes === holdTypes,
  `status ${seat.status}, ${JSON.stringify(seat.body?.serviceIds)}, stations [${seatTypes}] vs the hold's [${holdTypes}]`,
);

const wq = seat.body?.holdId
  ? await call(DEMO_API, DEMO_DESK, 'POST', '/bookings/quote', {
      day: DAY,
      serviceIds: seat.body.serviceIds,
      customerId: 'dana',
      channel: 'DESK',
      startMin: option.startMin,
    })
  : { body: {} };
const wconfirm = seat.body?.holdId
  ? await call(DEMO_API, DEMO_DESK, 'POST', '/bookings', {
      holdId: seat.body.holdId,
      branch: 'marina-walk',
      day: DAY,
      services: seat.body.serviceIds,
      channel: 'desk',
      ...((wq.body?.depositMinor ?? 0) > 0
        ? { amountMinor: wq.body.depositMinor, rail: 'CASH' }
        : {}),
    })
  : { status: 0, body: {} };
const wprice = wconfirm.body?.bookingId
  ? sql(`SELECT price_fils FROM booking WHERE id = '${wconfirm.body.bookingId}'`)
  : '';
check(
  "the desk confirms what the seat handed it: the package's price, not the parts'",
  wconfirm.status === 201 && wprice === '56000',
  `status ${wconfirm.status}, price_fils ${wprice}`,
);

// -------------------------------------------------------------------- party
section('C. A party, one member on the package');

const ghold = await call(DEMO_API, DEMO_DESK, 'POST', '/groups/holds', {
  day: DAY,
  targetMin: 900,
  mode: 'TOGETHER',
  arrangement: 'ORGANIZER',
  participants: [
    { label: 'Dana', serviceIds: ['colour-and-finish'] },
    { label: 'Guest', serviceIds: ['blow-dry'], guestName: 'Guest' },
  ],
});
check(
  'group hold: a member may hold a package',
  ghold.status === 201 && typeof ghold.body.holdId === 'string',
  `status ${ghold.status}: ${ghold.status === 201 ? ghold.body.lanes.map((l) => `${l.label} ${l.start}-${l.end}`).join(', ') : JSON.stringify(ghold.body).slice(0, 200)}`,
);
const gconfirm = ghold.body?.holdId
  ? await call(DEMO_API, DEMO_DESK, 'POST', `/groups/${ghold.body.groupId}/confirm`, {
      holdId: ghold.body.holdId,
      participants: [
        { label: 'Dana', serviceIds: ['colour-and-finish'] },
        { label: 'Guest', serviceIds: ['blow-dry'] },
      ],
    })
  : { status: 0, body: {} };
const lanePrice = ghold.body?.groupId
  ? sql(`SELECT string_agg(price_fils::text, ',' ORDER BY start_minute, price_fils DESC) FROM booking WHERE group_id = '${ghold.body.groupId}'`)
  : '';
check(
  "group confirm: the member's lane is the package's price",
  gconfirm.status === 201 && lanePrice.split(',').includes('56000'),
  `status ${gconfirm.status}, lane prices ${lanePrice}`,
);

const ghold2 = await call(DEMO_API, DEMO_DESK, 'POST', '/groups/holds', {
  day: DAY,
  targetMin: 1080,
  mode: 'TOGETHER',
  arrangement: 'ORGANIZER',
  participants: [
    { label: 'Dana', serviceIds: ['blow-dry'] },
    { label: 'Guest', serviceIds: ['blow-dry'], guestName: 'Guest' },
  ],
});
const gbad = ghold2.body?.holdId
  ? await call(DEMO_API, DEMO_DESK, 'POST', `/groups/${ghold2.body.groupId}/confirm`, {
      holdId: ghold2.body.holdId,
      participants: [
        { label: 'Dana', serviceIds: ['blow-dry', 'no-such-service'] },
        { label: 'Guest', serviceIds: ['blow-dry'] },
      ],
    })
  : { status: 0, body: {} };
check(
  'MUST FAIL: group confirm with an unknown service (it was silently left out of the price)',
  gbad.status === 422,
  `status ${gbad.status}: ${gbad.body?.message}`,
);

// ---------------------------------------------------- the platform is down
section('D. A real branch whose platform has no ListPackages (an older release)');

const plain = await call(DOWN_API, REAL_DESK, 'POST', '/bookings/quote', {
  day: DAY,
  serviceIds: [CUT],
  customerId: 'dana',
  channel: 'DESK',
  startMin: 600,
});
check(
  'a plain haircut still prices: it never asks for the package list',
  plain.status === 201 && plain.body.subtotalMinor > 0,
  `status ${plain.status}, subtotal ${plain.body?.subtotalMinor}`,
);
const pkgDown = await call(DOWN_API, REAL_DESK, 'POST', '/bookings/quote', {
  day: DAY,
  serviceIds: [GROOM],
  customerId: 'dana',
  channel: 'DESK',
  startMin: 600,
});
check(
  'MUST FAIL: a platform with no ListPackages sells no packages -- "not sold here", not an outage',
  pkgDown.status === 404,
  `status ${pkgDown.status}: ${pkgDown.body?.code} ${pkgDown.body?.message ?? ''}`,
);

// ---------------------------------------------- the platform has packages
section('E. A real branch, packages from the platform: Groom and Go, AED 370');

const rlist = await call(REAL_API, REAL_DESK, 'GET', '/packages');
check(
  'GET /v1/packages: what the platform sells, and no demo packages',
  rlist.status === 200 &&
    rlist.body.packages.length === 1 &&
    rlist.body.packages[0].packageId === GROOM &&
    rlist.body.packages[0].priceMinor === 37000,
  `status ${rlist.status}, ${JSON.stringify(rlist.body?.packages?.map((p) => [p.name, p.priceMinor]))}`,
);
const demoHere = await call(REAL_API, REAL_DESK, 'POST', '/bookings/quote', {
  day: DAY,
  serviceIds: ['colour-and-finish'],
  customerId: 'dana',
  channel: 'DESK',
  startMin: 600,
});
check(
  'MUST FAIL: a demo package at a real branch',
  demoHere.status === 404,
  `status ${demoHere.status}: ${demoHere.body?.message}`,
);
const rquote = await call(REAL_API, REAL_DESK, 'POST', '/bookings/quote', {
  day: DAY,
  serviceIds: [GROOM],
  customerId: 'dana',
  channel: 'DESK',
  startMin: 660,
});
check(
  'quote: AED 370 net, VAT 18.50, AED 388.50',
  rquote.status === 201 &&
    rquote.body.subtotalMinor === 37000 &&
    rquote.body.totalMinor === 38850,
  `status ${rquote.status}, ${rquote.body?.subtotalMinor} -> ${rquote.body?.totalMinor}`,
);
const rhold = await call(REAL_API, REAL_DESK, 'POST', '/holds', {
  branch: REAL_BRANCH,
  day: DAY,
  services: [GROOM],
  startMin: 660,
  customerId: 'dana',
});
const rdeposit = rquote.body?.depositMinor ?? 0;
const rconfirm = rhold.body?.holdId
  ? await call(REAL_API, REAL_DESK, 'POST', '/bookings', {
      holdId: rhold.body.holdId,
      branch: REAL_BRANCH,
      day: DAY,
      services: [GROOM],
      customerId: 'dana',
      channel: 'desk',
      ...(rdeposit > 0 ? { amountMinor: rdeposit, rail: 'CASH' } : {}),
    })
  : { status: 0, body: {} };
const rrows = rconfirm.body?.bookingId
  ? sql(`SELECT b.price_fils, (SELECT count(*) FROM booking_item WHERE booking_id = b.id AND package_id = '${GROOM}' AND package_name = 'Groom and Go')
       FROM booking b WHERE b.id = '${rconfirm.body.bookingId}'`)
  : '';
check(
  'hold and confirm: AED 370 stored, both parts carrying Groom and Go',
  rhold.status === 201 && rconfirm.status === 201 && rrows === '37000|2',
  `hold ${rhold.status}, confirm ${rconfirm.status}${rconfirm.status !== 201 ? ` ${JSON.stringify(rconfirm.body).slice(0, 160)}` : ''}, price|parts = ${rrows}`,
);

// ------------------------------------------------------------------ the app
section("F. The app's price check (a desk token stands in for a customer's)");

const mq = await call(DEMO_API, DEMO_DESK, 'POST', '/mobile-booking/quote', {
  salon_id: 'marina-walk',
  date: DAY,
  start_time: `${DAY}T10:00:00+06:00`,
  services: [{ id: 'colour-and-finish' }],
});
if (mq.status === 401 || mq.status === 403) {
  console.log(`SKIP      the mobile routes want a customer token here (${mq.status})`);
} else {
  check(
    'POST /v1/mobile-booking/quote: the line at the package price, AED 588',
    mq.status === 200 &&
      mq.body.services?.[0]?.amount === 560 &&
      mq.body.amount_without_tax === 560 &&
      mq.body.total === 588,
    `status ${mq.status}, services ${JSON.stringify(mq.body?.services)}, total ${mq.body?.total}`,
  );
}

// ----------------------------------------------------------------- the till
// Optional (TILL=1): check-in opens 30 minutes before the start, so this one
// books TODAY at the demo salon's next free start and takes it to the till.
if (process.env.TILL === '1') {
  section('G. The till: what the register actually charges for the package');
  const zone = { timeZone: 'Asia/Dhaka' };
  const today = new Date().toLocaleDateString('en-CA', zone);
  const [h, m] = new Date()
    .toLocaleTimeString('en-GB', { ...zone, hour12: false })
    .split(':')
    .map(Number);
  const from = Math.ceil((h * 60 + m + 5) / 5) * 5;
  let held = null;
  let at = from;
  for (; at <= from + 25 && held === null; at += 5) {
    const r = await call(DEMO_API, DEMO_DESK, 'POST', '/holds', {
      branch: 'marina-walk',
      day: today,
      services: ['colour-and-finish'],
      startMin: at,
      customerId: 'dana',
    });
    if (r.status === 201) held = { ...r.body, at };
  }
  const tq = held
    ? await call(DEMO_API, DEMO_DESK, 'POST', '/bookings/quote', {
        day: today,
        serviceIds: ['colour-and-finish'],
        customerId: 'dana',
        channel: 'DESK',
        startMin: held.at,
      })
    : { body: {} };
  const tc = held
    ? await call(DEMO_API, DEMO_DESK, 'POST', '/bookings', {
        holdId: held.holdId,
        branch: 'marina-walk',
        day: today,
        services: ['colour-and-finish'],
        customerId: 'dana',
        channel: 'desk',
        ...((tq.body.depositMinor ?? 0) > 0
          ? { amountMinor: tq.body.depositMinor, rail: 'CASH' }
          : {}),
      })
    : { status: 0, body: {} };
  let settled = { body: {} };
  if (tc.status === 201) {
    for (const step of ['check-in', 'start', 'complete']) {
      await call(DEMO_API, DEMO_DESK, 'POST', `/bookings/${tc.body.bookingId}/${step}`, {});
    }
    settled = await call(DEMO_API, DEMO_DESK, 'POST', `/bookings/${tc.body.bookingId}/settle`, {});
  }
  const r = settled.body?.receipt;
  check(
    "settle: the receipt is the package's price, and the balance is what confirm said was due",
    r?.base === 'AED 560.00' &&
      r?.vat === 'AED 28.00' &&
      settled.body?.to === 'SETTLED' &&
      r?.due ===
        `AED ${((tc.body.dueAtCheckoutMinor ?? -1) / 100).toFixed(2)}`,
    r
      ? `base ${r.base}, VAT ${r.vat}, deposit applied ${r.depositApplied}, due ${r.due} (confirm said ${tc.body.dueAtCheckoutMinor})`
      : `no receipt: hold ${held ? 'ok' : 'none free'}, confirm ${tc.status}`,
  );
}

console.log(`\n${n - failures} of ${n} passed${failures ? `, ${failures} FAILED` : ''}.`);
process.exit(failures);
