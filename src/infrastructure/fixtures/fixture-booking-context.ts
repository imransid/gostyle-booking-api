import { Injectable } from '@nestjs/common';
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
  },
  {
    id: 'blow-dry',
    name: 'Signature blow-dry',
    skill: 'hair',
    requiredLevel: 2,
    durationMin: 45,
    resourceType: 'styling',
    claims: STYLING,
  },
  {
    id: 'fringe-trim',
    name: 'Fringe trim',
    skill: 'hair',
    requiredLevel: 1,
    durationMin: 20,
    resourceType: 'styling',
    claims: STYLING,
  },
  {
    id: 'hair-colour',
    name: 'Hair color and style',
    skill: 'color',
    requiredLevel: 2,
    durationMin: 100,
    resourceType: 'color',
    claims: COLOUR,
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
    processing: { fromMin: 60, toMin: 105 },
    releasesChairDuringProcessing: true,
  },
  {
    id: 'keratin',
    name: 'Keratin treatment',
    skill: 'color',
    requiredLevel: 3,
    durationMin: 120,
    resourceType: 'styling',
    claims: STYLING,
  },
  {
    id: 'gel-manicure',
    name: 'Gel manicure',
    skill: 'nail',
    requiredLevel: 2,
    durationMin: 60,
    resourceType: 'nail',
    claims: NAIL,
  },
  {
    id: 'mani-pedi',
    name: 'Mani-pedi combo',
    skill: 'nail',
    requiredLevel: 2,
    durationMin: 95,
    resourceType: 'nail',
    claims: NAIL,
  },
  {
    id: 'luxury-facial',
    name: 'Luxury facial',
    skill: 'facial',
    requiredLevel: 2,
    durationMin: 75,
    resourceType: 'room',
    claims: ROOM,
  },
  {
    id: 'brow-lamination',
    name: 'Brow lamination',
    skill: 'brow',
    requiredLevel: 2,
    durationMin: 45,
    resourceType: 'brow',
    claims: BROW,
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
@Injectable()
export class FixtureBookingContext implements BookingContextReader {
  loadServices(
    _branchId: string,
    serviceIds: readonly string[],
  ): Promise<Service[]> {
    const found = serviceIds
      .map((id) => SERVICES.find((s) => s.id === id))
      .filter((s): s is Service => s !== undefined);
    return Promise.resolve(found);
  }

  loadDay(_branchId: string, tradingDay: string): Promise<DayContext> {
    // Sunday is a closed day, so the closure path is demonstrable.
    if (new Date(`${tradingDay}T00:00:00Z`).getUTCDay() === 0) {
      return Promise.resolve({
        professionals: [],
        staffBookings: new Map(),
        resources: RESOURCES,
        occupations: [],
        closureReason: 'Branch closed on Sundays',
      });
    }

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

      occupations.push({
        resourceType: b.resourceType,
        startMin: b.startMin,
        endMin: b.startMin + b.durationMin,
      });
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
