import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@infrastructure/persistence/prisma.service';
import {
  BRANCH_UTC_OFFSET_MIN,
  branchInstant,
  toUuid,
} from '@infrastructure/persistence/hold.repository';
import { TenantContext } from '@infrastructure/tenancy/tenant-context';
import { SlugIndex } from '@infrastructure/persistence/slug-uuid';
import { DEFAULT_BRANCH_ID } from '@infrastructure/tenancy/branch-context';
import {
  BOOKING_CONTEXT,
  type BookingContextReader,
} from '@application/ports/booking-context.port';
import { MobileContractError } from '@application/commands/mobile-booking.error';
import {
  filsToAed,
  railToMethod,
  toMobilePaymentStatus,
  toMobileStatus,
  toOffsetIso,
} from '@domain/booking/mobile-contract';
import { productMoney, productsOut } from '@domain/booking/mobile-products';
import { storedTotalFils } from '@domain/booking/stored-money';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who is asking, from the verified token. */
export interface GroupReader {
  readonly actorId: string;
  readonly actorKind: string;
  /** Null means every branch, which is what a company owner carries. */
  readonly actorBranchId: string | null;
}

/**
 * A mobile party, read back as ONE booking (docs/APP_GROUP_BOOKING_SPEC.md §6).
 *
 * Built only from what was stored: the lanes' own rows, their items, their
 * products and their ledger. No quote is asked for, so a service the
 * catalogue has since retired cannot make a party unreadable, and the figures
 * are the ones the party was sold at (group-money.ts decided them once).
 *
 * WHAT THE PARTY IS, when its lanes could disagree: the booker's own lane.
 * Paying and cancelling act on every lane together, so they only disagree
 * when the desk has changed one lane by hand; the booker's lane is then the
 * one the app's customer is actually holding.
 *
 * Names of accounts are not here. This service stores a guest's name and no
 * one else's; gostyle-customer-api owns the accounts and fills `name` in
 * from `user_id`. The create passes the names it was sent, so its answer is
 * complete without that round trip.
 */
@Injectable()
export class MobileGroupReadHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenants: TenantContext,
    @Inject(BOOKING_CONTEXT) private readonly context: BookingContextReader,
  ) {}

  /**
   * GET /v1/mobile-booking/group/:groupId.
   *
   * 404, NEVER 403, for a party the caller may not see: "no such party" and
   * "not yours" must look the same from outside, or the id space can be
   * walked. A desk party (`source` null) is 404 too: this route answers for
   * the parties the app made and no others.
   */
  async read(groupId: string, who: GroupReader): Promise<MobileGroupView> {
    const group = await this.load(groupId);
    if (group === null || !this.visible(group, who)) {
      throw MobileContractError.notFoundBooking();
    }
    return this.present(group, new Map());
  }

  /**
   * The same shape, for a party this request just made. `names` are the
   * ones the app sent, by member position.
   */
  async afterCreate(
    groupId: string,
    names: ReadonlyMap<number, string>,
  ): Promise<MobileGroupView> {
    const group = await this.load(groupId);
    if (group === null) throw MobileContractError.notFoundBooking();
    return this.present(group, names);
  }

  /**
   * My Bookings (GET /v1/mobile-booking): each row that is a member of a
   * mobile party becomes ONE `booking_type: "GROUP"` row for the party.
   *
   * A customer holds one lane per party (guests' lanes are filed under the
   * group, not under anyone), so this swaps a row for a row: the page size
   * and the shelf counts the list already worked out stay true. A desk
   * party's lane is left exactly as it was.
   *
   * The GROUP row has the same keys as any row, plus `member_count`: `id` is
   * the group's (what GET /v1/mobile-booking/group/:groupId takes), and the
   * money is the party's.
   */
  async decorateList(page: unknown): Promise<unknown> {
    if (typeof page !== 'object' || page === null) return page;
    const results = (page as { results?: unknown }).results;
    if (!Array.isArray(results)) return page;

    const ids = results
      .map((r) => (r as { id?: unknown }).id)
      .filter((id): id is string => typeof id === 'string' && UUID_RE.test(id));
    if (ids.length === 0) return page;

    const lanes = await this.prisma.booking.findMany({
      where: { id: { in: ids }, groupId: { not: null } },
      select: { id: true, groupId: true },
    });
    if (lanes.length === 0) return page;

    const views = new Map<string, MobileGroupView>();
    for (const groupId of new Set(lanes.map((l) => l.groupId!))) {
      const group = await this.load(groupId);
      if (group !== null)
        views.set(groupId, await this.present(group, new Map()));
    }
    const groupOf = new Map(lanes.map((l) => [l.id, l.groupId!]));

    return {
      ...page,
      results: (results as unknown[]).map((row): unknown => {
        const groupId = groupOf.get((row as { id?: string }).id ?? '');
        const view = groupId === undefined ? undefined : views.get(groupId);
        return view === undefined ? row : groupRow(view);
      }),
    };
  }

  private async load(groupId: string) {
    if (!UUID_RE.test(groupId)) return null;
    const group = await this.prisma.bookingGroup.findUnique({
      where: { id: groupId },
      include: { participants: { orderBy: { position: 'asc' } } },
    });
    if (group === null || group.source !== 'mobile') return null;

    const ids = group.participants
      .map((p) => p.bookingId)
      .filter((x): x is string => x !== null);
    const lanes = await this.prisma.booking.findMany({
      where: { id: { in: ids } },
      include: {
        items: { orderBy: { position: 'asc' } },
        products: { orderBy: { position: 'asc' } },
        ledger: { orderBy: { createdAt: 'asc' } },
      },
    });
    const byId = new Map(lanes.map((l) => [l.id, l]));
    return {
      ...group,
      members: group.participants.flatMap((p) => {
        const lane = p.bookingId === null ? undefined : byId.get(p.bookingId);
        return lane === undefined ? [] : [{ participant: p, lane }];
      }),
    };
  }

  /** The organiser, anyone in the party, or staff of the salon (D3). */
  private visible(
    group: {
      organiserId: string;
      branchId: string;
      participants: { customerId: string | null }[];
    },
    who: GroupReader,
  ): boolean {
    if (who.actorKind === 'customer') {
      const me = toUuid(who.actorId);
      return (
        group.organiserId === me ||
        group.participants.some((p) => p.customerId === me)
      );
    }
    return (
      who.actorBranchId === null || group.branchId === toUuid(who.actorBranchId)
    );
  }

  private async present(
    group: NonNullable<Awaited<ReturnType<MobileGroupReadHandler['load']>>>,
    names: ReadonlyMap<number, string>,
  ): Promise<MobileGroupView> {
    const day = group.tradingDay.toISOString().slice(0, 10);
    const { index, staff } = await this.namesFor(group, day);

    const at = (minute: number): string =>
      toOffsetIso(branchInstant(day, minute), BRANCH_UTC_OFFSET_MIN);

    const members = group.members.map(({ participant: p, lane }) => {
      const products = productMoney(lane.products);
      const total = (storedTotalFils(lane) ?? 0) + products.totalFils;
      const staffId =
        lane.items[0] === undefined
          ? null
          : index.toSlug(lane.items[0].staffId);
      const kind: MemberKindWord =
        p.customerId === null
          ? 'guest'
          : p.customerId === group.organiserId
            ? 'self'
            : 'registered';
      return {
        view: {
          ref: p.clientRef,
          id: p.id,
          booking_code: lane.code,
          user_id: p.customerId,
          name: p.guestName ?? names.get(p.position) ?? null,
          kind,
          age_group: p.ageGroup,
          status: toMobileStatus(lane.status),
          services: lane.items.map((i) => ({
            id: index.toSlug(i.serviceId),
            name: i.serviceName,
            amount: filsToAed(i.priceFils),
          })),
          products: productsOut(lane.products),
          stylist:
            staffId === null
              ? null
              : { id: staffId, name: staff.get(staffId) ?? null },
          start_time: at(lane.startMinute),
          end_time: at(lane.startMinute + lane.durationMin),
          total: filsToAed(total),
        },
        lane,
        kind,
        netFils: (lane.netFils ?? 0) + products.netFils,
        vatFils: (lane.taxFils ?? 0) + products.vatFils,
        totalFils: total,
      };
    });

    const booker =
      members.find((m) => m.kind === 'self')?.lane ?? members[0]?.lane;
    if (booker === undefined) throw MobileContractError.notFoundBooking();

    const sum = (xs: readonly number[]): number =>
      xs.reduce((a, b) => a + b, 0);
    const captures = members.flatMap((m) =>
      m.lane.ledger.filter((l) => l.entryType === 'captured'),
    );
    const captured = sum(captures.map((c) => c.amountFils));
    const totalFils = sum(members.map((m) => m.totalFils));
    const lastRail =
      [...captures]
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .at(-1)?.rail ?? null;

    return {
      id: group.id,
      salon_id: index.toSlug(group.branchId),
      booking_type: 'GROUP',
      status: toMobileStatus(booker.status),
      status_detail: booker.status.toUpperCase(),
      payment_status: toMobilePaymentStatus(booker.paymentStatus),
      payment_status_detail: booker.paymentStatus.toUpperCase(),
      date: day,
      start_time: at(Math.min(...members.map((m) => m.lane.startMinute))),
      end_time: at(
        Math.max(
          ...members.map((m) => m.lane.startMinute + m.lane.durationMin),
        ),
      ),
      member_count: members.length,
      members: members.map((m) => m.view),
      amount_without_tax: filsToAed(sum(members.map((m) => m.netFils))),
      tax_amount: filsToAed(sum(members.map((m) => m.vatFils))),
      discount: filsToAed(sum(members.map((m) => m.lane.discountFils ?? 0))),
      promo_code: booker.promoCode,
      total: filsToAed(totalFils),
      deposit_percent: group.depositPercent,
      deposit_amount: filsToAed(sum(members.map((m) => m.lane.depositFils))),
      advance_paid_amount: filsToAed(captured),
      due_amount: filsToAed(Math.max(0, totalFils - captured)),
      payment_method: railToMethod(lastRail),
      /** One pass for the party: the booker's own code (decision D5). */
      pass_qr_code: booker.code,
      /** The draft hold: set while unpaid, cleared once paid. */
      expires_at:
        booker.linkExpiresAt === null
          ? null
          : toOffsetIso(booker.linkExpiresAt, BRANCH_UTC_OFFSET_MIN),
      created_at: toOffsetIso(group.createdAt, BRANCH_UTC_OFFSET_MIN),
    };
  }

  /**
   * Stylist names and the slug index, for the party's own branch and day.
   *
   * A NAME IS DECORATION, the party is real either way: a platform that is
   * down leaves the names off, it does not make the party unreadable. Run in
   * the party's own tenant when the request carried none, as the single read
   * does, because the roster lookup is tenant-scoped.
   */
  private async namesFor(
    group: { branchId: string; tenantId: string | null },
    day: string,
  ): Promise<{ index: SlugIndex; staff: ReadonlyMap<string, string> }> {
    const branch = new SlugIndex([DEFAULT_BRANCH_ID]).toSlug(group.branchId);
    const load = async () => {
      const [roster, catalogue] = await Promise.all([
        this.context.loadDay(branch, day),
        this.context.loadCatalogue(branch),
      ]);
      return {
        index: new SlugIndex([
          ...roster.professionals.map((p) => p.id),
          ...catalogue.map((c) => c.id),
          DEFAULT_BRANCH_ID,
        ]),
        staff: new Map(roster.professionals.map((p) => [p.id, p.name])),
      };
    };
    try {
      return this.tenants.current() !== null || group.tenantId === null
        ? await load()
        : await this.tenants.run(group.tenantId, load);
    } catch {
      return { index: new SlugIndex([DEFAULT_BRANCH_ID]), staff: new Map() };
    }
  }
}

/** A party as one row of My Bookings: the single row's keys, plus the count. */
function groupRow(v: MobileGroupView): Record<string, unknown> {
  const stylists = new Map<
    string,
    { id: string; name: string | null; avatar_url: null }
  >();
  for (const m of v.members) {
    if (m.stylist !== null && !stylists.has(m.stylist.id)) {
      stylists.set(m.stylist.id, { ...m.stylist, avatar_url: null });
    }
  }
  return {
    id: v.id,
    salon_id: v.salon_id,
    status: v.status,
    payment_status: v.payment_status,
    booking_type: 'GROUP',
    member_count: v.member_count,
    date: v.date,
    start_time: v.start_time,
    end_time: v.end_time,
    services: v.members.flatMap((m) =>
      m.services.map((s) => ({ id: s.id, name: s.name })),
    ),
    stylists: [...stylists.values()],
    total: v.total,
    due_amount: v.due_amount,
    created_at: v.created_at,
  };
}

type MemberKindWord = 'self' | 'registered' | 'guest';

/** docs/APP_GROUP_BOOKING_SPEC.md §6, plus the detail words the single read adds. */
export interface MobileGroupView {
  readonly id: string;
  readonly salon_id: string;
  readonly booking_type: 'GROUP';
  readonly status: string;
  readonly status_detail: string;
  readonly payment_status: string;
  readonly payment_status_detail: string;
  readonly date: string;
  readonly start_time: string;
  readonly end_time: string;
  readonly member_count: number;
  readonly members: readonly {
    readonly ref: number | null;
    readonly id: string;
    readonly booking_code: string;
    readonly user_id: string | null;
    readonly name: string | null;
    readonly kind: MemberKindWord;
    readonly age_group: string | null;
    readonly status: string;
    readonly services: readonly { id: string; name: string; amount: number }[];
    readonly products: ReturnType<typeof productsOut>;
    readonly stylist: { id: string; name: string | null } | null;
    readonly start_time: string;
    readonly end_time: string;
    readonly total: number;
  }[];
  readonly amount_without_tax: number;
  readonly tax_amount: number;
  readonly discount: number;
  readonly promo_code: string | null;
  readonly total: number;
  readonly deposit_percent: number | null;
  readonly deposit_amount: number;
  readonly advance_paid_amount: number;
  readonly due_amount: number;
  readonly payment_method: string | null;
  readonly pass_qr_code: string;
  readonly expires_at: string | null;
  readonly created_at: string;
}
