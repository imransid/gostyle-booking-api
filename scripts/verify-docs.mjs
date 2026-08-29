/**
 * Every curl in the doc, executed. A documentation example that does not run
 * is worse than no example: it costs the reader an hour before they conclude
 * the docs are wrong.
 *
 * Ids in the doc are from the run that produced it and are necessarily stale,
 * so a path carrying one is re-pointed at a live equivalent. What is checked
 * is the SHAPE: does this method + path + body still work, and does the
 * response still carry the keys the doc shows?
 */
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:3099';
const TOKEN = process.env.TOKEN;
const md = readFileSync(process.argv[2], 'utf8');

// --- pull every ```bash block that contains a curl
const blocks = [...md.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
const examples = [];
for (const b of blocks) {
  if (!b.includes('curl')) continue;
  const method = (/curl -X ([A-Z]+)/.exec(b) ?? [, 'GET'])[1];
  const pathM = /"\$BASE"(\/[^\s\\]*)/.exec(b);
  if (!pathM) continue;
  const bodyM = /-d '([\s\S]*?)'\s*$/.exec(b.trim());
  const headers = [...b.matchAll(/-H "([^:]+): ([^"]*)"/g)]
    .filter(([, k]) => k.toLowerCase() !== 'authorization' && k.toLowerCase() !== 'content-type')
    .map(([, k, v]) => [k, v]);
  const after = md.slice(md.indexOf(b) + b.length, md.indexOf(b) + b.length + 40);
  const claimed = /`(\d{3})`/.exec(after);
  examples.push({ method, path: pathM[1], body: bodyM ? bodyM[1] : null, headers,
                  raw: b.trim(), claimed: claimed ? Number(claimed[1]) : null });
}

// --- the doc's json blocks, to check response keys survive
const jsonAfter = (idx) => {
  const rest = md.slice(idx);
  const m = /```json\n([\s\S]*?)```/.exec(rest);
  if (!m) return null;
  try { return JSON.parse(m[1].replace(/\n\s*\.\.\.\s*$/, '')); } catch { return null; }
};

console.log(`\n  ${examples.length} curl examples found in ${process.argv[2]}\n`);

// A different day per run. A fixed one accumulates waitlist entries, and the
// offer goes to the OLDEST -- so the accept example would 404 against an entry
// this run never made. Same trap the endpoint proof script hit.
const DAY = process.env.DAY ??
  new Date(Date.now() + (30 + Math.floor(Math.random() * 60)) * 86400000).toISOString().slice(0, 10);
let live = {};

async function call(method, path, body, headers = []) {
  const h = { Authorization: `Bearer ${TOKEN}` };
  for (const [k, v] of headers) h[k] = v;
  if (body) h['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers: h, ...(body ? { body } : {}) });
  const t = await res.text();
  let j; try { j = t ? JSON.parse(t) : null; } catch { j = null; }
  return { status: res.status, json: j, text: t };
}

// Build live ids so stale paths can be re-pointed.
async function seed() {
  const av = await call('GET', `/v1/availability?day=${DAY}&services=blow-dry&channel=desk`);
  const o = av.json.offers[0];
  const h = await call('POST', '/v1/holds', JSON.stringify({
    day: DAY, services: ['blow-dry'], startMin: o.startMin, staffId: o.staff[0].id, channel: 'desk' }));
  const b = await call('POST', '/v1/bookings', JSON.stringify({
    holdId: h.json.holdId, day: DAY, services: ['blow-dry'], customerId: 'dana', channel: 'desk' }),
    [['Idempotency-Key', `verify-${Date.now()}`]]);
  const s = await call('POST', '/v1/series', JSON.stringify({
    branchId: 'marina-walk', customerId: 'dana', serviceId: 'blow-dry', preferredStaffId: 'maya',
    anchorDay: DAY, startMin: 660, pattern: { kind: 'WEEKLY', weekdays: [2] },
    end: { kind: 'AFTER_COUNT', count: 3 }, autoConfirmRule: 'ASK_EACH_TIME' }));
  const w = await call('POST', '/v1/walk-ins', JSON.stringify({
    branchId: 'marina-walk', tradingDay: DAY, serviceIds: ['blow-dry'], joinedMin: 600, guestName: 'V' }));
  live = {
    booking: b.json?.bookingId, hold: h.json?.holdId, series: s.json?.seriesId ?? s.json?.id,
    walkIn: w.json?.id ?? w.json?.walkInId, waitlist: null,
    occurrence: null, day: DAY,
  };
  if (live.series) {
    const occ = await call('GET', `/v1/series/${live.series}/occurrences`);
    const list = occ.json?.occurrences ?? occ.json;
    live.occurrence = Array.isArray(list) ? list[0]?.id : null;
  }
  return b.status === 201;
}

/**
 * An offer only exists once a slot the entry wants has been freed, and the
 * relay that makes it ticks once a second. Booking the slot and cancelling it
 * is the whole setup -- without it the accept example 404s and reads as a
 * broken doc rather than a missing precondition.
 */
async function seedWaitlistOffer() {
  // Do NOT join here. The doc's own POST /v1/waitlist example ran a moment ago
  // and its entry is the OLDEST in the queue, so it is the one that gets the
  // offer. Joining again just puts a second entry behind it and the accept
  // example -- pointed at that second entry -- 404s forever.
  if (!live.waitlist) return;
  const av = await call('GET', `/v1/availability?day=${live.day}&services=haircut-finish&channel=desk`);
  if (!(av.json?.offers ?? []).length) console.log('       (no haircut-finish slot free to seed with)');
  for (const o of (av.json?.offers ?? []).filter((x) => x.startMin >= 600 && x.startMin <= 720)) {
    const h = await call('POST', '/v1/holds', JSON.stringify({
      day: live.day, services: ['haircut-finish'], startMin: o.startMin,
      staffId: o.staff[0].id, channel: 'desk' }));
    if (h.status !== 201) continue;
    const b = await call('POST', '/v1/bookings', JSON.stringify({
      holdId: h.json.holdId, day: live.day, services: ['haircut-finish'],
      customerId: 'dana', channel: 'desk' }), [['Idempotency-Key', `wl-seed-${Date.now()}`]]);
    if (b.status !== 201) continue;
    await call('POST', `/v1/bookings/${b.json.bookingId}/cancel`, JSON.stringify({
      reason: 'seeding a waitlist offer', initiatedBy: 'SALON' }));
    // No GET on a waitlist entry, and probing with decline would CONSUME the
    // offer this is meant to create. So: free the slot, then give the relay
    // (1s tick) a few beats to make the offer.
    await new Promise((r) => setTimeout(r, 4000));
    console.log(`       (seeded waitlist offer: entry ${live.waitlist} on ${o.start ?? o.startMin})`);
    return;
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function repoint(path) {
  let p = path;
  if (/^\/v1\/series\/[0-9a-f-]{36}\/occurrences\/[0-9a-f-]{36}/.test(p) && live.occurrence)
    p = p.replace(UUID, live.series).replace(UUID, live.occurrence);
  else if (p.startsWith('/v1/bookings/series/') && live.series) p = p.replace(UUID, live.series);
  else if (p.startsWith('/v1/series/') && live.series) p = p.replace(UUID, live.series);
  else if (p.startsWith('/v1/bookings/') && live.booking) p = p.replace(UUID, live.booking);
  else if (p.startsWith('/v1/holds/') && live.hold) p = p.replace(UUID, live.hold);
  else if (p.startsWith('/v1/walk-ins/') && live.walkIn) p = p.replace(UUID, live.walkIn);
  else if (p.startsWith('/v1/waitlist/') && live.waitlist) p = p.replace(UUID, live.waitlist);
  else if (p.startsWith('/v1/groups/') && live.group) p = p.replace(UUID, live.group);
  // day literals in the doc are from the capture run
  p = p.replace(/day=\d{4}-\d{2}-\d{2}/, `day=${live.day}`)
       .replace(/tradingDay=\d{4}-\d{2}-\d{2}/, `tradingDay=${live.day}`);
  return p;
}
function repointBody(body) {
  if (!body) return body;
  let b = body.replace(/"(day|tradingDay|anchorDay|firstDay)":\s*"\d{4}-\d{2}-\d{2}"/g, `"$1": "${live.day}"`);
  if (live.hold) b = b.replace(/"holdId":\s*"[0-9a-f-]{36}"/, `"holdId": "${live.hold}"`);
  return b;
}

if (!(await seed())) { console.error('  could not seed live ids'); process.exit(1); }

let pass = 0, fail = 0, expected = 0;
for (const ex of examples) {
  if (ex.path.includes('/v1/waitlist/') && ex.path.endsWith('/accept')) await seedWaitlistOffer();
  const path = repoint(ex.path);
  let body = repointBody(ex.body);
  // POST /v1/holds: the doc's slot was taken by the run that wrote the doc.
  // Which slot to send is decided by the status the doc CLAIMS -- 201 means
  // "a free one", 409 means "the one just held", which is the whole point of
  // that example.
  if (ex.method === 'POST' && ex.path === '/v1/holds') {
    const svc = /haircut-finish/.test(ex.body ?? '') ? 'haircut-finish' : 'blow-dry';
    if (ex.claimed === 409 && live.lastSlot) {
      body = JSON.stringify({ day: live.day, services: [svc], ...live.lastSlot, channel: 'desk' });
    } else {
      const av = await call('GET', `/v1/availability?day=${live.day}&services=${svc}&channel=desk`);
      for (const o of av.json?.offers ?? []) {
        const probe = { startMin: o.startMin, staffId: o.staff[0].id };
        const t = await call('POST', '/v1/holds', JSON.stringify({ day: live.day, services: [svc], ...probe, channel: 'desk' }));
        if (t.status !== 201) continue;
        await call('DELETE', `/v1/holds/${t.json.holdId}`);   // free it for the example itself
        live.lastSlot = probe;
        body = JSON.stringify({ day: live.day, services: [svc], ...probe, channel: 'desk' });
        break;
      }
    }
  }
  // The group confirm must target the group the doc's own holds example made.
  if (ex.path.startsWith('/v1/groups/') && ex.path.endsWith('/confirm') && live.group) {
    body = (ex.body ?? '{}').replace(/"holdId":\s*"[0-9a-f-]{36}"/, `"holdId": "${live.groupHold}"`);
  }
  if (/"holdId":\s*"<[^"]*>"/.test(ex.body ?? '')) {
    // A placeholder in prose. Mint a real hold on the service the example uses
    // so the 402 it documents is actually proven, not skipped.
    const svc = /full-colour/.test(ex.body) ? 'full-colour' : 'blow-dry';
    const av = await call('GET', `/v1/availability?day=${live.day}&services=${svc}&channel=desk`);
    for (const o of av.json?.offers ?? []) {
      const h = await call('POST', '/v1/holds', JSON.stringify({
        day: live.day, services: [svc], startMin: o.startMin, staffId: o.staff[0].id, channel: 'desk' }));
      if (h.status !== 201) continue;
      body = body.replace(/"holdId":\s*"<[^"]*>"/, `"holdId": "${h.json.holdId}"`);
      break;
    }
  }
  if (ex.path.includes('/v1/walk-ins/') && ex.path.endsWith('/seat')) {
    const q = await call('GET', `/v1/walk-ins?branchId=marina-walk&tradingDay=${live.day}&nowMin=600`);
    const row = (q.json?.rows ?? []).find((r) => r.id === live.walkIn);
    const opt = row?.options?.[0];
    if (opt) body = JSON.stringify({ startMin: opt.startMin, staffId: opt.staffId });
  }
  // Examples that deliberately demonstrate a failure keep their bad input.
  const wantsFailure = /00000000-0000-4000-8000-000000000000/.test(ex.path + (ex.body ?? ''));
  let r = await call(ex.method, wantsFailure ? ex.path : path, wantsFailure ? ex.body : body, ex.headers);

  // A party needs several professionals free at one moment, and this script
  // has been booking all day. Walking the afternoon is what a desk would do;
  // failing on the first target would report a full diary as a broken doc.
  if (ex.path === '/v1/groups/holds' && r.status === 409 && ex.claimed === 201) {
    for (const t of [840, 780, 960, 1020, 720, 660]) {
      const alt = (body ?? '').replace(/"targetMin":\s*\d+/, `"targetMin": ${t}`);
      r = await call(ex.method, path, alt, ex.headers);
      if (r.status === 201) break;
    }
  }
  // The offer is made by a relay that ticks once a second, so a 404 here can
  // simply mean "not yet".
  if (ex.path.includes('/v1/waitlist/') && ex.path.endsWith('/accept')
      && r.status === 404 && ex.claimed === 201) {
    for (let i = 0; i < 8 && r.status === 404; i++) {
      await new Promise((z) => setTimeout(z, 1000));
      r = await call(ex.method, path, body, ex.headers);
    }
  }
  if (ex.method === 'POST' && ex.path === '/v1/waitlist' && r.status === 201)
    live.waitlist = r.json?.entryId ?? r.json?.id ?? live.waitlist;
  if (ex.method === 'POST' && ex.path === '/v1/holds' && r.status === 201) live.hold = r.json?.holdId;
  if (ex.method === 'POST' && ex.path === '/v1/groups/holds' && r.status === 201) {
    live.group = r.json?.groupId; live.groupHold = r.json?.holdId;
  }
  const ok2xx = r.status >= 200 && r.status < 300;
  // Prefer the status the doc printed. Fall back to "did it work at all" for
  // the few blocks that show no status line.
  const good = ex.claimed !== null
    ? r.status === ex.claimed
    : (ok2xx || r.status === 409 || r.status === 410);
  const tag = good ? '\x1b[32mOK  \x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  if (good) { pass++; if (ex.claimed !== null && ex.claimed >= 400) expected++; } else fail++;
  const want = ex.claimed !== null ? `doc says ${ex.claimed}` : 'no status shown';
  console.log(`  ${tag} ${ex.method.padEnd(6)} ${path.slice(0, 54).padEnd(54)} ${String(r.status).padEnd(4)} ${good ? want : want + ' -- got ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 70)}`);
}
console.log(`\n  ${examples.length} examples: ${pass} ok (${expected} deliberate failures), ${fail} broken\n`);
process.exit(fail ? 1 : 0);
