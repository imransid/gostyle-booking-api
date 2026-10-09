import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Metadata, status } from '@grpc/grpc-js';
import { Observable } from 'rxjs';

import { callOnce, type GrpcCallOptions } from './call-with-retry';
import { describeGrpcFailure, grpcStatusOf } from './grpc-failure';
import { blankToNull } from './blank-to-null';
import { CHAIR_DIRECTORY_CLIENT } from './floor-grpc.constants';
import type {
  ChairDirectory,
  ChairLookup,
} from '@application/ports/chair-directory.port';

/**
 * The wire shape, snake_case, exactly as floor.proto declares it. Optional
 * as every wire shape here is, though the loader's `defaults` fills them.
 */
interface ResolveChairQrWire {
  status?: string;
  chair_id?: string;
  tenant_id?: string;
  branch_id?: string;
  chair_number?: string;
  zone_id?: string;
  zone_name?: string;
  chair_state?: string;
  chair_bookable?: boolean;
}

interface ChairDirectoryGrpc {
  resolveChairQr(
    data: { token: string; user_agent: string },
    metadata?: Metadata,
    options?: GrpcCallOptions,
  ): Observable<ResolveChairQrWire>;
}

/**
 * How long a scan waits for platform. The customer is standing at the chair
 * with the app open, and customer-api gives the whole request 10s
 * (BOOKING_API_TIMEOUT). Platform's answer is one indexed read and one
 * insert: anything slower is platform in trouble, and the customer is better
 * off at the desk than watching a spinner.
 */
const RESOLVE_TIMEOUT_MS = 2_000;

/**
 * Codes that mean the two services disagree about their SETUP, not that
 * platform is busy. Nothing changes until somebody changes it, so every scan
 * would fail the same way: logged at ERROR once per process each, never once
 * per customer who sits down.
 */
const MISCONFIGURED: ReadonlyMap<number, string> = new Map([
  [
    status.UNAUTHENTICATED,
    'platform refused our x-internal-key. PLATFORM_INTERNAL_KEY must hold ' +
      'the same value here and on platform; platform logs which side is ' +
      'wrong, on its warn line after "Refused ChairDirectory.ResolveChairQr:".',
  ],
  [
    status.UNIMPLEMENTED,
    'platform does not serve ChairDirectory.ResolveChairQr: it is older ' +
      'than floor.proto (platform PR #178).',
  ],
]);

/**
 * CHAIR_DIRECTORY over gRPC to platform's ChairDirectory.
 *
 * KEYED: PLATFORM_INTERNAL_KEY goes as gRPC metadata `x-internal-key` on
 * every call. A different key from INTERNAL_GRPC_KEY (customer-api's), so a
 * leak of that one does not also open platform, whose answer carries tenant
 * and branch ids. Never logged, nor any part of it.
 *
 * ONE ATTEMPT (callOnce), because every answered call is a scan row.
 *
 * Three answers, as the port has them:
 *
 *   found         what the card and the chair are, '' read as null
 *   unknown_card  NOT_FOUND or INVALID_ARGUMENT: no scan was written
 *   unavailable   anything else, and the reason is logged here: a setup
 *                 fault once per process at ERROR, anything else once per
 *                 scan at WARN, since each one is a customer sent to the desk
 */
@Injectable()
export class GrpcChairDirectory implements ChairDirectory, OnModuleInit {
  private readonly logger = new Logger(GrpcChairDirectory.name);
  private svc!: ChairDirectoryGrpc;
  /** The setup faults already logged in this process. */
  private readonly reported = new Set<string>();

  constructor(
    @Inject(CHAIR_DIRECTORY_CLIENT) private readonly client: ClientGrpc,
  ) {}

  onModuleInit(): void {
    this.svc = this.client.getService<ChairDirectoryGrpc>('ChairDirectory');
  }

  async resolve(token: string, userAgent: string | null): Promise<ChairLookup> {
    // Read per call, like INTERNAL_GRPC_KEY: .env is loaded after this module,
    // and a key rotation should need a restart, not a rebuild.
    const key = (process.env.PLATFORM_INTERNAL_KEY ?? '').trim();
    if (key === '') {
      // Platform would refuse it anyway. Refused here, it costs no round
      // trip, and the log says which service to fix.
      this.reportOnce(
        'no key',
        'PLATFORM_INTERNAL_KEY is not set on booking-api, so a scan is ' +
          'refused here, before it reaches platform. Set it to the value ' +
          'platform holds.',
      );
      return { kind: 'unavailable', error: 'PLATFORM_INTERNAL_KEY is not set' };
    }

    let res: ResolveChairQrWire;
    try {
      res = await callOnce(RESOLVE_TIMEOUT_MS, (md, opts) => {
        md.set('x-internal-key', key);
        return this.svc.resolveChairQr(
          { token, user_agent: userAgent ?? '' },
          md,
          opts,
        );
      });
    } catch (e) {
      const code = grpcStatusOf(e);
      if (code === status.NOT_FOUND || code === status.INVALID_ARGUMENT) {
        return { kind: 'unknown_card' };
      }
      const error = `platform ${describeGrpcFailure(e)}`;
      const fault = code === null ? undefined : MISCONFIGURED.get(code);
      if (fault !== undefined) {
        this.reportOnce(String(code), `${error} -- ${fault}`);
      } else {
        this.logger.warn(
          `ResolveChairQr: ${error}. The customer is sent to the desk.`,
        );
      }
      return { kind: 'unavailable', error };
    }

    // Always set, says the contract. Without it there is no chair to store,
    // so this is platform breaking its word, not a card we do not know.
    const chairId = blankToNull(res.chair_id);
    if (chairId === null) {
      const error = 'platform answered ResolveChairQr with no chair_id';
      this.logger.warn(`${error}. The customer is sent to the desk.`);
      return { kind: 'unavailable', error };
    }

    return {
      kind: 'found',
      chair: {
        // Platform's word, compared exactly by the rule: not trimmed here.
        cardStatus: res.status ?? '',
        chairId,
        tenantId: blankToNull(res.tenant_id),
        branchId: blankToNull(res.branch_id),
        chairNumber: blankToNull(res.chair_number),
        zoneName: blankToNull(res.zone_name),
        chairState: blankToNull(res.chair_state),
        chairBookable: res.chair_bookable === true,
      },
    };
  }

  /**
   * The line SAYS it will not repeat. Otherwise a wrong key reads as one
   * ERROR at boot and then silence, while every customer who sits down is
   * refused: somebody reading the log later would take the silence for a fix.
   */
  private reportOnce(fault: string, line: string): void {
    if (this.reported.has(fault)) return;
    this.reported.add(fault);
    this.logger.error(
      `${line} Every chair scan is refused until this is fixed; this will ` +
        'not be logged again until the service restarts.',
    );
  }
}
