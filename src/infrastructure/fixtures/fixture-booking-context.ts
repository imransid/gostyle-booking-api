import type { ServicePackage } from '@domain/booking/package';
import { Injectable } from '@nestjs/common';
import { toUuid } from '../persistence/hold.repository';
import type {
  BookingContextReader,
  DayContext,
} from '@application/ports/booking-context.port';
import type { Professional, Service } from '@domain/availability/feasible';
import type {
  StaffBooking,
  BufferClaims,
} from '@domain/availability/staff-mask';
import type {
  ChairOccupation,
  ResourceType,
} from '@domain/availability/capacity';
import { occupationsFor } from '@domain/availability/capacity';

// Table 6.2, per resource class.
const COLOUR: BufferClaims = { preMin: 10, postMin: 20 };
const STYLING: BufferClaims = { preMin: 5, postMin: 10 };
const WASH: BufferClaims = { preMin: 5, postMin: 5 };
const NAIL: BufferClaims = { preMin: 5, postMin: 10 };
const BROW: BufferClaims = { preMin: 0, postMin: 5 };
const ROOM: BufferClaims = { preMin: 10, postMin: 15 };

// Table 6.1.
const SERVICES: readonly Service[] = [
  {
    id: 'haircut-finish',
    name: 'Haircut and finish',
    skill: 'hair',
    requiredLevel: 2,
    durationMin: 45,
    resourceType: 'styling',
    claims: STYLING,
    depositPercent: null,
    depositFixedFils: null,
  },
  {
    id: 'blow-dry',
    name: 'Signature blow-dry',
    skill: 'hair',
    requiredLevel: 2,
    durationMin: 45,
    resourceType: 'styling',
    claims: STYLING,
    depositPercent: null,
    depositFixedFils: null,
  },
  {
    id: 'fringe-trim',
    name: 'Fringe trim',
    skill: 'hair',
    requiredLevel: 1,
    durationMin: 20,
    resourceType: 'styling',
    claims: STYLING,
    depositPercent: null,
    depositFixedFils: null,
  },
  {
    id: 'hair-colour',
    name: 'Hair color and style',
    skill: 'color',
    requiredLevel: 2,
    durationMin: 100,
    resourceType: 'color',
    claims: COLOUR,
    depositPercent: 50,
    depositFixedFils: null,
    processing: { fromMin: 45, toMin: 75 },
    releasesChairDuringProcessing: true,
  },
  {
    id: 'full-colour',
    name: 'Full color and gloss',
    skill: 'color',
    requiredLevel: 2,
    durationMin: 125,
    resourceType: 'color',
    claims: COLOUR,
    depositPercent: 50,
    depositFixedFils: null,
    processing: { fromMin: 45, toMin: 85 },
    releasesChairDuringProcessing: true,
  },
  {
    id: 'balayage',
    name: 'Balayage',
    skill: 'color',
    requiredLevel: 3,
    durationMin: 150,
    resourceType: 'color',
    claims: COLOUR,
    depositPercent: 50,
    depositFixedFils: null,
    processing: { fromMin: 60, toMin: 105 },
    releasesChairDuringProcessing: true,
  },
  {
    id: 'keratin',
    name: 'Keratin treatment',
    // A styling chair means a hair skill. It was 'color', which wrongly
    // demanded a colourist for a service that never touches a colour station.
    skill: 'hair',
    requiredLevel: 3,
    durationMin: 120,
    resourceType: 'styling',
    claims: STYLING,
    depositPercent: 50,
    depositFixedFils: 40000,
  },
  {
    id: 'gel-manicure',
    name: 'Gel manicure',
    skill: 'nail',
    requiredLevel: 2,
    durationMin: 60,
    resourceType: 'nail',
    claims: NAIL,
    depositPercent: 20,
    depositFixedFils: null,
  },
  {
    id: 'mani-pedi',
    name: 'Mani-pedi combo',
    skill: 'nail',
    requiredLevel: 2,
    durationMin: 95,
    resourceType: 'nail',
    claims: NAIL,
    depositPercent: 20,
    depositFixedFils: null,
  },
  {
    id: 'luxury-facial',
    name: 'Luxury facial',
    skill: 'facial',
    requiredLevel: 2,
    durationMin: 75,
    resourceType: 'room',
    claims: ROOM,
    depositPercent: 20,
    depositFixedFils: null,
  },
  {
    id: 'brow-lamination',
    name: 'Brow lamination',
    skill: 'brow',
    requiredLevel: 2,
    durationMin: 45,
    resourceType: 'brow',
    claims: BROW,
    depositPercent: 20,
    depositFixedFils: 10000,
  },
  {
    // Table 6.1. Massage is its own skill family, and nobody on the current
    // roster holds it, so this service correctly offers nothing until a
    // therapist is rostered. That is the right answer, not a bug.
    id: 'hot-stone',
    name: 'Hot stone massage',
    skill: 'massage',
    requiredLevel: 2,
    durationMin: 75,
    resourceType: 'room',
    claims: ROOM,
    depositPercent: 20,
    depositFixedFils: 15000,
  },
  {
    id: 'hair-wash',
    name: 'Wash and condition',
    skill: 'hair',
    requiredLevel: 1,
    durationMin: 15,
    resourceType: 'wash',
    claims: WASH,
  },
];

const PROFESSIONALS: readonly Professional[] = [
  {
    id: 'anya',
    name: 'Anya V.',
    skills: new Map([
      ['color', 3],
      ['hair', 3],
    ]),
    shift: { startMin: 600, endMin: 1140 },
    overlapAllowed: true,
    bookingsToday: 2,
  },
  {
    id: 'maya',
    name: 'Maya E.',
    skills: new Map([
      ['color', 2],
      ['hair', 3],
    ]),
    shift: { startMin: 660, endMin: 1260 },
    overlapAllowed: true,
    bookingsToday: 3,
  },
  {
    id: 'reem',
    name: 'Reem S.',
    skills: new Map([['hair', 2]]),
    shift: { startMin: 600, endMin: 1080 },
    overlapAllowed: false,
    bookingsToday: 1,
  },
  {
    id: 'lina',
    name: 'Lina K.',
    skills: new Map([
      ['nail', 3],
      ['brow', 2],
    ]),
    shift: { startMin: 720, endMin: 1320 },
    overlapAllowed: false,
    bookingsToday: 4,
  },
  {
    id: 'sara',
    name: 'Sara K.',
    skills: new Map([
      ['facial', 3],
      ['brow', 3],
    ]),
    shift: { startMin: 600, endMin: 840 },
    overlapAllowed: false,
    bookingsToday: 0,
  },
  {
    id: 'tara',
    name: 'Tara N.',
    skills: new Map([['hair', 1]]),
    shift: { startMin: 600, endMin: 1320 },
    overlapAllowed: false,
    bookingsToday: 0,
  },
];

// Table 7.3. S4 is out of service.
const RESOURCES: readonly ResourceType[] = [
  { id: 'styling', units: 4, outOfService: 1, changeoverMin: 0 },
  { id: 'color', units: 2, outOfService: 0, changeoverMin: 5 },
  { id: 'wash', units: 2, outOfService: 0, changeoverMin: 0 },
  { id: 'nail', units: 3, outOfService: 0, changeoverMin: 0 },
  { id: 'brow', units: 1, outOfService: 0, changeoverMin: 0 },
  { id: 'room', units: 2, outOfService: 0, changeoverMin: 10 },
];

interface SeedBooking {
  readonly staffId: string;
  readonly startMin: number;
  readonly durationMin: number;
  readonly resourceType: string;
  readonly claims: BufferClaims;
  readonly processing?: { fromMin: number; toMin: number };
}

// A believably busy Friday, so the output is not just "every 5 minutes".
const DIARY: readonly SeedBooking[] = [
  {
    staffId: 'anya',
    startMin: 660,
    durationMin: 125,
    resourceType: 'color',
    claims: COLOUR,
    processing: { fromMin: 45, toMin: 85 },
  },
  {
    staffId: 'anya',
    startMin: 900,
    durationMin: 100,
    resourceType: 'color',
    claims: COLOUR,
    processing: { fromMin: 45, toMin: 75 },
  },
  {
    staffId: 'maya',
    startMin: 720,
    durationMin: 45,
    resourceType: 'styling',
    claims: STYLING,
  },
  {
    staffId: 'maya',
    startMin: 840,
    durationMin: 45,
    resourceType: 'styling',
    claims: STYLING,
  },
  {
    staffId: 'maya',
    startMin: 960,
    durationMin: 125,
    resourceType: 'color',
    claims: COLOUR,
    processing: { fromMin: 45, toMin: 85 },
  },
  {
    staffId: 'reem',
    startMin: 780,
    durationMin: 45,
    resourceType: 'styling',
    claims: STYLING,
  },
  {
    staffId: 'lina',
    startMin: 780,
    durationMin: 60,
    resourceType: 'nail',
    claims: NAIL,
  },
  {
    staffId: 'lina',
    startMin: 900,
    durationMin: 95,
    resourceType: 'nail',
    claims: NAIL,
  },
  {
    staffId: 'lina',
    startMin: 1020,
    durationMin: 60,
    resourceType: 'nail',
    claims: NAIL,
  },
  {
    staffId: 'lina',
    startMin: 1140,
    durationMin: 45,
    resourceType: 'brow',
    claims: BROW,
  },
  {
    staffId: 'sara',
    startMin: 660,
    durationMin: 75,
    resourceType: 'room',
    claims: ROOM,
  },
];

/**
 * A hard-coded branch, standing in for the catalogue, staff, shift and chair
 * services until the gRPC clients exist.
 *
 * Swapping this for the real thing changes ONE provider in the module. No
 * handler, controller or domain file is touched. That is the point of the port.
 */
/**
 * Every service, by slug AND by the uuid it is folded into.
 *
 * booking_item.service_id is a uuid column, so confirm writes toUuid(slug).
 * Anything reading a service id BACK out of the database therefore holds the
 * hash, not the slug, and a slug-keyed lookup misses.
 *
 * Resolving both here, once, is better than a toUuid call at each of the
 * dozen boundaries: every one of those is a place to forget, and forgetting
 * is silent. It all disappears when the catalogue speaks real uuids.
 */
/** The roster's slugs, so callers can turn a stored uuid back. */
export const STAFF_SLUGS: readonly string[] = PROFESSIONALS.map((p) => p.id);

const BY_ANY_ID: ReadonlyMap<string, Service> = new Map(
  SERVICES.flatMap((s) => [[s.id, s] as const, [toUuid(s.id), s] as const]),
);

@Injectable()
export class FixtureBookingContext implements BookingContextReader {
  loadServices(
    _branchId: string,
    serviceIds: readonly string[],
  ): Promise<Service[]> {
    const found = serviceIds
      .map((id) => BY_ANY_ID.get(id) ?? BY_ANY_ID.get(id.toLowerCase()))
      .filter((s): s is Service => s !== undefined);
    return Promise.resolve(found);
  }

  loadDay(_branchId: string, _tradingDay: string): Promise<DayContext> {
    // NO WEEKLY CLOSURE HERE.
    //
    // There was a Sunday closure, invented so the closure path would be
    // demonstrable. Nothing in the specification says the branch closes on
    // Sundays, and in the UAE Sunday is a working day: the weekend is Friday
    // and Saturday. So the rule was both unsourced AND backwards for the
    // market it serves.
    //
    // Real closures come from the roster service, which does not exist yet.
    // No closures is the honest answer until it does.

    const staffBookings = new Map<string, StaffBooking[]>();
    const occupations: ChairOccupation[] = [];

    for (const b of DIARY) {
      const list = staffBookings.get(b.staffId) ?? [];
      list.push({
        startMin: b.startMin,
        endMin: b.startMin + b.durationMin,
        claims: b.claims,
        ...(b.processing !== undefined ? { processing: b.processing } : {}),
      });
      staffBookings.set(b.staffId, list);

      // A colour with a hands-free band holds its station in TWO intervals,
      // not one. Pushing the whole duration made every colour station read as
      // busy through its own developing time, and slots that genuinely
      // existed were refused.
      occupations.push(
        ...occupationsFor({
          resourceType: b.resourceType,
          startMin: b.startMin,
          endMin: b.startMin + b.durationMin,
          ...(b.processing !== undefined ? { processing: b.processing } : {}),
          releasesChairDuringProcessing: b.processing !== undefined,
        }),
      );
    }

    return Promise.resolve({
      professionals: PROFESSIONALS,
      staffBookings,
      resources: RESOURCES,
      occupations,
    });
  }

  loadCatalogue(_branchId: string): Promise<Service[]> {
    return Promise.resolve([...SERVICES]);
  }
}

/**
 * The packages the branch merchandises.
 *
 * A pricing construct only. Each expands into the services above, and the
 * engine never learns a package was involved: the chain, skills, buffers,
 * chair demand and processing bands all come from the parts.
 *
 * Prices are net of VAT and below the sum of the parts, which is the whole
 * proposition. expandPackage refuses one that is not.
 */
export const PACKAGES: readonly ServicePackage[] = [
  {
    id: 'colour-and-finish',
    name: 'Colour and finish',
    serviceIds: ['full-colour', 'blow-dry'],
    // Parts: 48,000 + 14,000 = 62,000. Saves AED 60.
    priceFils: 56000,
  },
  {
    id: 'bridal-morning',
    name: 'Bridal morning',
    serviceIds: ['balayage', 'blow-dry', 'luxury-facial'],
    // Parts: 72,000 + 14,000 + 38,000 = 124,000. Saves AED 190.
    priceFils: 105000,
  },
  {
    id: 'hands-and-feet',
    name: 'Hands and feet',
    serviceIds: ['gel-manicure', 'mani-pedi'],
    // Parts: 18,000 + 22,000 = 40,000. Saves AED 40.
    priceFils: 36000,
  },
];
