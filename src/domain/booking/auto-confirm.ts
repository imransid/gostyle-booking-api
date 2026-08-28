/**
 * What state is an occurrence born in?
 *
 * Materialisation creates a real booking, so it must answer the same question
 * the wizard answers for a manual booking: is this confirmed, is it waiting on
 * money, or is it waiting on the customer? The auto-confirm rule decides,
 * and the payment requirement gets a veto on everything except a VIP standing
 * reservation.
 *
 * The rule is a property of the SERIES. The requirement is resolved PER
 * OCCURRENCE, because a client's risk band and the branch's peak hours both
 * move underneath a standing booking.
 */

import type { BookingStatus } from './lifecycle';
import type { RequirementKind, Tier } from './customer';

export type AutoConfirmRule =
  /** The customer pre-agreed to the cadence. */
  | 'auto_confirm_on_schedule'
  /** A confirmation request goes out before every visit. */
  | 'ask_each_time'
  /** The calendar is blocked permanently. Gold and Royal only. */
  | 'vip_standing';

/** A reminder goes out 48 hours before a scheduled occurrence. */
export const SCHEDULE_REMINDER_LEAD_HOURS = 48;

/** The confirmation request goes out 7 days before. */
export const CONFIRMATION_REQUEST_LEAD_DAYS = 7;

/** Silence for this long expires the occurrence and releases the slot. */
export const CONFIRMATION_WINDOW_HOURS = 48;

/** Two consecutive expiries flag the series At risk. */
export const CONSECUTIVE_EXPIRIES_AT_RISK = 2;

/** Only these tiers may hold a standing reservation. */
const STANDING_TIERS: ReadonlySet<Tier> = new Set<Tier>(['gold', 'royal']);

export function mayHoldStandingReservation(tier: Tier): boolean {
  return STANDING_TIERS.has(tier);
}

export interface MaterialisationInput {
  readonly rule: AutoConfirmRule;
  /** Resolved for THIS occurrence, not once for the series. */
  readonly requirement: RequirementKind;
  readonly tier: Tier;
}

export interface Notification {
  /** How far before the start it goes out. */
  readonly leadHours: number;
  readonly kind: 'reminder' | 'confirmation_request';
}

export interface BirthState {
  readonly status: BookingStatus;
  /**
   * The requirement was set aside by rule rather than satisfied.
   *
   * Only a standing reservation does this, and it is a waiver rather than an
   * exemption: the money was never owed, so there is nothing to collect later.
   */
  readonly depositWaived: boolean;
  readonly notification: Notification | null;
  /** The window that, on silence, expires the occurrence. Hours. */
  readonly confirmationWindowHours: number | null;
  readonly explanation: string;
}

/**
 * The rule table from 15.2.2, with the payment requirement layered on top.
 *
 * ORDER MATTERS. "Ask each time" outranks the requirement: there is no point
 * asking a customer for money for a visit they have not yet agreed to. The
 * payment link is issued when they confirm, not before.
 */
export function birthState(input: MaterialisationInput): BirthState {
  if (input.rule === 'vip_standing') {
    // A standing reservation that has to be paid for is not standing. The
    // tier check is a guard against a rule that was set before a downgrade.
    if (!mayHoldStandingReservation(input.tier)) {
      return {
        status: 'pending_confirmation',
        depositWaived: false,
        notification: {
          leadHours: CONFIRMATION_REQUEST_LEAD_DAYS * 24,
          kind: 'confirmation_request',
        },
        confirmationWindowHours: CONFIRMATION_WINDOW_HOURS,
        explanation:
          'A standing reservation needs Gold or Royal. The tier no longer ' +
          'qualifies, so this occurrence asks the customer instead.',
      };
    }

    return {
      status: 'confirmed',
      depositWaived: true,
      notification: {
        leadHours: SCHEDULE_REMINDER_LEAD_HOURS,
        kind: 'reminder',
      },
      confirmationWindowHours: null,
      explanation:
        'Standing reservation: the calendar is blocked and the deposit is ' +
        'waived by rule.',
    };
  }

  if (input.rule === 'ask_each_time') {
    return {
      status: 'pending_confirmation',
      depositWaived: false,
      notification: {
        leadHours: CONFIRMATION_REQUEST_LEAD_DAYS * 24,
        kind: 'confirmation_request',
      },
      confirmationWindowHours: CONFIRMATION_WINDOW_HOURS,
      explanation:
        `A confirmation request goes out ${CONFIRMATION_REQUEST_LEAD_DAYS} ` +
        `days ahead. Silence for ${CONFIRMATION_WINDOW_HOURS} hours expires it.`,
    };
  }

  // auto_confirm_on_schedule: confirmed, PAYMENT RULE PERMITTING.
  if (input.requirement === 'none') {
    return {
      status: 'confirmed',
      depositWaived: false,
      notification: {
        leadHours: SCHEDULE_REMINDER_LEAD_HOURS,
        kind: 'reminder',
      },
      confirmationWindowHours: null,
      explanation:
        'The customer pre-agreed to the cadence and nothing is owed up front.',
    };
  }

  return {
    status: 'pending_payment',
    depositWaived: false,
    notification: {
      leadHours: SCHEDULE_REMINDER_LEAD_HOURS,
      kind: 'reminder',
    },
    confirmationWindowHours: null,
    explanation:
      input.requirement === 'full'
        ? 'The cadence is agreed, but this occurrence needs paying in full first.'
        : 'The cadence is agreed, but this occurrence needs a deposit first.',
  };
}
