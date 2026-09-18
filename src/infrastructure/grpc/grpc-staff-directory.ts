import { Inject, Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { Observable } from 'rxjs';

import { callWithRetry, type GrpcCallOptions } from './call-with-retry';
import { describeGrpcFailure } from './grpc-failure';

import type {
  StaffDirectoryReader,
  Stylist,
} from '@application/ports/staff-directory.port';
import { STAFF_DIRECTORY_CLIENT } from './staff-grpc.constants';

/**
 * The wire shape, snake_case, exactly as staff.proto declares it.
 *
 * DECLARED HERE AND NOWHERE ELSE. This is the only file in the service that
 * is allowed to know a proto exists; everything above receives `Stylist`.
 *
 * Fields are optional because proto3 omits defaults on the wire: an empty
 * string is simply not sent, so the key is absent rather than ''. Reading
 * `row.bio` when nothing was sent gives undefined, which is why every access
 * below coalesces.
 */
interface StylistWire {
  staff_profile_id?: string;
  user_id?: string;
  first_name?: string;
  last_name?: string;
  position?: string;
  branch_id?: string;
  employment_status?: string;
  photo_url?: string;
  rating_bps?: number;
  review_count?: number;
  years_experience?: number;
  offday?: string;
  opening_time?: string;
  closing_time?: string;
  bio?: string;
}

/** The generated client surface. Nest lowercases the first letter of each rpc. */
interface StaffDirectoryGrpc {
  listStylists(
    data: { tenant_id: string; branch_id: string },
    metadata?: Metadata,
    options?: GrpcCallOptions,
  ): Observable<{
    stylists?: StylistWire[];
  }>;
}

/** Milliseconds. gRPC sets NO default deadline, so an unanswered call hangs
 *  until the socket dies, holding a request open the whole time. */
const CALL_TIMEOUT_MS = 5_000;

@Injectable()
export class GrpcStaffDirectory implements StaffDirectoryReader, OnModuleInit {
  private readonly logger = new Logger(GrpcStaffDirectory.name);
  private svc!: StaffDirectoryGrpc;

  constructor(
    @Inject(STAFF_DIRECTORY_CLIENT) private readonly client: ClientGrpc,
  ) {}

  /** getService in onModuleInit, NOT in the constructor: the client proxy is
   *  not ready until Nest has initialised the module. */
  onModuleInit(): void {
    this.svc = this.client.getService<StaffDirectoryGrpc>('StaffDirectory');
  }

  async listStylists(tenantId: string, branchId: string): Promise<Stylist[]> {
    try {
      const res = await callWithRetry(
        this.logger,
        `listStylists tenant=${tenantId} branch=${branchId}`,
        CALL_TIMEOUT_MS,
        (md, opts) =>
          this.svc.listStylists(
            { tenant_id: tenantId, branch_id: branchId },
            md,
            opts,
          ),
      );
      return (res.stylists ?? []).map(toStylist);
    } catch (err) {
      /**
       * STILL CLOSED BY DEFAULT, unlike the services adapter beside it,
       * and the difference is what the answer is USED FOR.
       *
       * This one feeds a "meet the team" list. An empty roster is a poor
       * panel; nobody is refused anything and no money moves. The services
       * catalogue prices a booking, so an empty answer there turns a
       * server outage into `unknown_service` at a customer -- which is why
       * that one now refuses and this one does not.
       *
       * It is still a lie of a smaller kind: a reader cannot tell an empty
       * roster from an unreachable platform. The log line below is the only
       * place that distinction survives, and it should become a 503 the day
       * anything decides something on the strength of this list.
       */
      this.logger.error(
        `listStylists failed for tenant ${tenantId}: ${describeGrpcFailure(err)}`,
      );
      return [];
    }
  }
}

/**
 * Wire row to domain type. THE ANTI-CORRUPTION LAYER, in one function.
 *
 * Three conversions happen here and nowhere else:
 *
 *   1. snake_case becomes camelCase.
 *   2. Basis points become stars. 4800 is a wire encoding; 4.8 is a rating.
 *   3. EMPTY BECOMES NULL. This is the important one. Platform sends 0 and ''
 *      for "we have no column for this yet", because proto3 cannot send null.
 *      Passing that straight through would render every stylist as a
 *      zero-star, zero-experience stylist, which states something false.
 *      null means unknown, and the UI can then hide the field.
 */
function toStylist(row: StylistWire): Stylist {
  const name = [row.first_name, row.last_name]
    .filter((part) => part && part.length > 0)
    .join(' ')
    .trim();

  return {
    id: row.staff_profile_id ?? '',
    name,
    position: blankToNull(row.position),
    branchId: blankToNull(row.branch_id),
    active: row.employment_status === 'ACTIVE',

    photoUrl: blankToNull(row.photo_url),
    // Divide by 1000: 4800 bps is 4.8 stars.
    rating: zeroToNull(row.rating_bps, (bps) => bps / 1000),
    reviewCount: zeroToNull(row.review_count),
    yearsExperience: zeroToNull(row.years_experience),
    offday: blankToNull(row.offday),
    openingTime: blankToNull(row.opening_time),
    closingTime: blankToNull(row.closing_time),
    bio: blankToNull(row.bio),
  };
}

/** '' or absent becomes null. Both mean the same thing on this wire. */
function blankToNull(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/** 0 or absent becomes null, with an optional unit conversion applied to the
 *  values that survive. */
function zeroToNull(
  value: number | undefined,
  convert: (n: number) => number = (n) => n,
): number | null {
  return value === undefined || value === 0 ? null : convert(value);
}
