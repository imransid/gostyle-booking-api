import { Injectable } from '@nestjs/common';
import {
  DAY_START_MIN,
  DAY_END_MIN,
  SLOT_MIN,
  SLOTS,
  MIN_SELLABLE_MIN,
  OFFER_SPACING_MIN,
  DAILY_BOOKING_CAP,
} from '@domain/availability/grid';
import { DESK_CHANNEL, ONLINE_CHANNEL } from '@domain/availability/feasible';
import {
  DEPOSIT_FLOOR,
  DEPOSIT_CEILING,
  DEFAULT_BRANCH,
  FIRST_VISIT_PERCENT,
  RISK_FLAG_PERCENT,
  HIGH_RISK_PERCENT,
  PEAK_ESCALATION_PERCENT,
  tierDiscountPercent,
} from '@domain/booking/customer';
import { VAT_PERCENT, DEFAULT_PROMO_PERCENT } from '@domain/booking/quote';
import { HOLD_TTL_MS, THREE_DS_GRACE_MS } from '@domain/booking/hold';
import { OFFER_TTL_MS, DECLINE_CAP } from '@domain/booking/waitlist';
import {
  LINK_WINDOW_MS,
  LINK_CUTOFF_BEFORE_START_MS,
} from '@domain/booking/payment-link';
import {
  LATE_CANCEL_WINDOW_HOURS,
  FREE_CANCEL_WINDOW_HOURS,
  CHECK_IN_OPENS_MIN,
  ARRIVAL_GRACE_MIN,
  VIP_ARRIVAL_GRACE_MIN,
  AUTO_NO_SHOW_MIN,
} from '@domain/booking/lifecycle';
import {
  SERIES_HORIZON_DAYS,
  BOOKING_HORIZON_DAYS,
} from '@domain/booking/recurrence';
import { CANCELLATION_PROTECTION_HOURS } from '@domain/booking/series-edit';
import {
  MAX_MOVE_MIN,
  MAX_MOVES,
  MIN_STRANDED_GAIN_MIN,
} from '@domain/availability/compaction';

/**
 * Every number the front end would otherwise hard-code.
 *
 * READ FROM THE CONSTANTS, NEVER RETYPED. Each value below is imported from
 * the module that owns it, so a rule and the settings endpoint cannot drift:
 * change the hold TTL in hold.ts and this endpoint says fifteen minutes
 * without anybody remembering to come here. Retyping them would make this the
 * second definition of twenty-nine rules (CLAUDE.md 4).
 *
 * WHAT THIS IS NOT: a configuration surface. Nothing here is per-branch yet —
 * there is no branch table and DEFAULT_BRANCH is the only instance that
 * exists — so the endpoint is honest about that rather than implying a
 * per-branch answer it cannot give.
 */
export interface SettingsView {
  readonly tradingWindow: {
    readonly fromMin: number;
    readonly toMin: number;
    readonly slotMin: number;
    readonly slots: number;
  };
  readonly channels: {
    readonly DESK: { readonly grainMin: number; readonly leadMin: number };
    readonly ONLINE: { readonly grainMin: number; readonly leadMin: number };
  };
  readonly horizons: {
    readonly bookingDays: number;
    readonly seriesDays: number;
  };
  readonly money: {
    readonly currency: 'AED';
    readonly minorUnitsPerMajor: number;
    readonly vatPercent: number;
    readonly tierDiscountPercentGold: number;
    readonly defaultPromoPercent: number;
    readonly depositFloorMinor: number;
    readonly depositCeilingMinor: number;
    readonly firstVisitPercent: number;
    readonly requireDepositFlagPercent: number;
    readonly highRiskPercent: number;
    readonly peakEscalationPercent: number;
  };
  readonly peakWindow: {
    readonly enabled: boolean;
    readonly fromMin: number;
    readonly toMin: number;
  };
  readonly holds: {
    readonly ttlMs: number;
    readonly threeDSGraceMs: number;
  };
  readonly paymentLink: {
    readonly windowMs: number;
    readonly cutoffBeforeStartMs: number;
  };
  readonly waitlist: {
    readonly offerTtlMs: number;
    readonly declineCap: number;
  };
  readonly dayOf: {
    readonly checkInOpensMin: number;
    readonly arrivalGraceMin: number;
    readonly vipArrivalGraceMin: number;
    readonly autoNoShowMin: number;
    readonly freeCancelWindowHours: number;
    readonly lateCancelWindowHours: number;
  };
  readonly capacity: {
    readonly dailyBookingCap: number;
    readonly sliverThresholdMin: number;
    readonly offerSpacingMin: number;
  };
  readonly compaction: {
    readonly maxMoveMin: number;
    readonly maxMoves: number;
    readonly minStrandedGainMin: number;
  };
  readonly series: {
    readonly cancellationProtectionHours: number;
  };
  readonly groups: {
    readonly minParticipants: number;
    readonly maxParticipants: number;
  };
  /** Said out loud, so nobody reads this as per-branch configuration. */
  readonly scope: string;
}

/** Minimum 2 participants, hard cap 8 online (§15.1.1). */
const GROUP_MIN = 2;
const GROUP_MAX = 8;

@Injectable()
export class GetSettingsHandler {
  execute(): SettingsView {
    return {
      tradingWindow: {
        fromMin: DAY_START_MIN,
        toMin: DAY_END_MIN,
        slotMin: SLOT_MIN,
        slots: SLOTS,
      },
      channels: {
        DESK: {
          grainMin: DESK_CHANNEL.grainMin,
          leadMin: DESK_CHANNEL.leadMin,
        },
        ONLINE: {
          grainMin: ONLINE_CHANNEL.grainMin,
          leadMin: ONLINE_CHANNEL.leadMin,
        },
      },
      horizons: {
        bookingDays: BOOKING_HORIZON_DAYS,
        seriesDays: SERIES_HORIZON_DAYS,
      },
      money: {
        currency: 'AED',
        minorUnitsPerMajor: 100,
        vatPercent: VAT_PERCENT,
        tierDiscountPercentGold: tierDiscountPercent('gold'),
        defaultPromoPercent: DEFAULT_PROMO_PERCENT,
        depositFloorMinor: DEPOSIT_FLOOR.fils,
        depositCeilingMinor: DEPOSIT_CEILING.fils,
        firstVisitPercent: FIRST_VISIT_PERCENT,
        requireDepositFlagPercent: RISK_FLAG_PERCENT,
        highRiskPercent: HIGH_RISK_PERCENT,
        peakEscalationPercent: PEAK_ESCALATION_PERCENT,
      },
      peakWindow: {
        // Kept, and kept true, rather than dropped. Rung 4b is no longer
        // switchable -- the field is now a statement about the engine, not a
        // setting -- but a client already branching on it would break if the
        // key vanished, and `true` is the honest answer either way.
        enabled: true,
        fromMin: DEFAULT_BRANCH.peakFromMin,
        toMin: DEFAULT_BRANCH.peakToMin,
      },
      holds: { ttlMs: HOLD_TTL_MS, threeDSGraceMs: THREE_DS_GRACE_MS },
      paymentLink: {
        windowMs: LINK_WINDOW_MS,
        cutoffBeforeStartMs: LINK_CUTOFF_BEFORE_START_MS,
      },
      waitlist: { offerTtlMs: OFFER_TTL_MS, declineCap: DECLINE_CAP },
      dayOf: {
        checkInOpensMin: CHECK_IN_OPENS_MIN,
        arrivalGraceMin: ARRIVAL_GRACE_MIN,
        vipArrivalGraceMin: VIP_ARRIVAL_GRACE_MIN,
        autoNoShowMin: AUTO_NO_SHOW_MIN,
        freeCancelWindowHours: FREE_CANCEL_WINDOW_HOURS,
        lateCancelWindowHours: LATE_CANCEL_WINDOW_HOURS,
      },
      capacity: {
        dailyBookingCap: DAILY_BOOKING_CAP,
        sliverThresholdMin: MIN_SELLABLE_MIN,
        offerSpacingMin: OFFER_SPACING_MIN,
      },
      compaction: {
        maxMoveMin: MAX_MOVE_MIN,
        maxMoves: MAX_MOVES,
        minStrandedGainMin: MIN_STRANDED_GAIN_MIN,
      },
      series: { cancellationProtectionHours: CANCELLATION_PROTECTION_HOURS },
      groups: { minParticipants: GROUP_MIN, maxParticipants: GROUP_MAX },
      scope:
        'Branch-wide defaults. Nothing here varies by branch yet: there is ' +
        'no branch configuration table, so every branch reads the same ' +
        'values.',
    };
  }
}
