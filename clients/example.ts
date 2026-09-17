/**
 * The whole single-booking flow, end to end, with the client.
 *
 *   BASE_URL=http://localhost:3099 TOKEN=<staff jwt> npx ts-node clients/example.ts
 *
 * Mint a dev staff token with the snippet in ../README.md ("Getting a
 * token"). Every step prints what the server actually answered, so this
 * doubles as a way to check an environment is wired correctly.
 */

import {
  BookingClient,
  ConflictError,
  DependencyUnavailableError,
  HoldExpiredError,
  UnauthorizedError,
  ValidationError,
  formatCountdown,
  newIdempotencyKey,
  secondsLeft,
} from './gostyle-booking-client';

const api = new BookingClient({
  baseUrl: process.env.BASE_URL ?? 'http://localhost:3099',
  token: process.env.TOKEN,
  defaultBranch: 'marina-walk',
});

/** A trading day far enough out that the roster is open. */
const DAY = process.env.DAY ?? '2027-05-13';
const CUSTOMER = process.env.CUSTOMER ?? 'dana';

async function main(): Promise<void> {
  // 1. WHAT CAN BE BOOKED. No token needed, so a landing page can call it.
  const catalogue = await api.catalogue();
  const service = catalogue.find((s) => s.id === 'full-colour') ?? catalogue[0];
  if (!service) throw new Error('the catalogue is empty');
  console.log(
    `service    ${service.id} — ${service.name}, ${service.durationMin}min`,
  );

  // 2. WHICH STARTS ARE REAL. Also open: no token.
  const availability = await api.availability({
    day: DAY,
    services: [service.id],
    channel: 'desk',
  });
  // topOffers is the ranked shortlist and carries assignedTo; offers is
  // everything feasible and only lists who COULD take it.
  const ranked = availability.topOffers[0];
  const offer = ranked ?? availability.offers[0];
  if (!offer) {
    // An empty day always says why. Show the reason, never a blank screen.
    console.log(
      'no offers:',
      availability.closureReason ?? availability.refusals,
    );
    return;
  }
  const professional = ranked?.assignedTo ?? offer.staff[0];
  console.log(
    `offer      ${offer.start}–${offer.end} with ${professional?.name ?? 'anyone free'}` +
      `  (${availability.count} feasible, computed in ${availability.computeMs}ms)`,
  );

  // 3. WHAT IT COSTS. Token from here on. Note the SHOUTED channel.
  const quote = await api.quote({
    day: DAY,
    serviceIds: [service.id],
    customerId: CUSTOMER,
    channel: 'DESK',
    startMin: offer.startMin,
  });
  console.log(
    `quote      ${quote.total} total, ${quote.deposit} deposit — ${quote.requirementSource}`,
  );

  // 4. RESERVE IT. Fifteen minutes on the clock from here.
  const hold = await api.placeHold({
    day: DAY,
    services: [service.id],
    startMin: offer.startMin,
    staffId: professional?.id, // omit for "any available professional"
    customerId: CUSTOMER,
    channel: 'desk',
  });
  console.log(
    `hold       ${hold.holdId}  expires in ${formatCountdown(secondsLeft(hold))}`,
  );

  // 5. TAKE THE DEPOSIT AND BOOK IT.
  //
  // The key is made ONCE, outside the call, so a retry can reuse it: that is
  // the difference between replaying the booking and charging twice.
  const idempotencyKey = newIdempotencyKey();
  const booking = await api.confirm(
    {
      holdId: hold.holdId,
      day: DAY,
      services: [service.id],
      customerId: CUSTOMER,
      channel: 'desk',
      amountMinor: quote.depositMinor, // fils, and always with a rail
      rail: 'CARD',
      gatewayRef: `pi_${Date.now()}`, // whatever the gateway returned; unique
    },
    { idempotencyKey },
  );
  console.log(
    `booked     ${booking.code}  ${booking.status} / ${booking.paymentStatus}` +
      `  due at checkout ${booking.dueAtCheckout}`,
  );

  // A retry with the same key returns the same booking, charging nothing.
  const retry = await api.confirm(
    {
      holdId: hold.holdId,
      day: DAY,
      services: [service.id],
      customerId: CUSTOMER,
      channel: 'desk',
      amountMinor: quote.depositMinor,
      rail: 'CARD',
    },
    { idempotencyKey },
  );
  console.log(`retry      ${retry.code}  replayed=${retry.replayed}`);

  // 6. THE DRAWER.
  const detail = await api.getBooking(booking.bookingId);
  console.log(
    `detail     ${detail.items.length} item(s), ${detail.ledger.length} ledger entr(ies), ` +
      `starts ${detail.startAt}`,
  );

  // 7. THE DAY ITSELF.
  await api.checkIn(booking.bookingId);
  await api.start(booking.bookingId);
  await api.complete(booking.bookingId);
  const settled = await api.settle(booking.bookingId, {
    rail: 'card',
    tipMinor: 5000,
  });
  console.log(
    `settled    tip ${settled.receipt?.tip}, deposit ${settled.receipt?.depositApplied}, ` +
      `due now ${settled.receipt?.due}`,
  );
}

main().catch((error: unknown) => {
  // EVERY BRANCH HERE MEANS NOTHING WAS CHARGED.
  if (error instanceof HoldExpiredError) {
    console.error('The hold died. Re-run availability and hold again.');
  } else if (error instanceof ConflictError) {
    console.error(`Someone got there first: ${error.message}`);
  } else if (error instanceof ValidationError) {
    console.error('The request was malformed:', error.details);
  } else if (error instanceof UnauthorizedError) {
    console.error('No usable token. Set TOKEN=<staff jwt>.');
  } else if (error instanceof DependencyUnavailableError) {
    console.error(`A dependency is down: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
