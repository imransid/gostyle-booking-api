import { describe, expect, it } from 'vitest';
import {
  BadRequestException,
  ValidationPipe,
  type ArgumentMetadata,
} from '@nestjs/common';
import { CalendarDayQuery, CalendarWeekQuery } from './read-models.query';

/**
 * QUERY DTO SPEC — run through a pipe built as main.ts builds the global one,
 * because `transform: true` is what makes @Transform run at all.
 *
 * `status=` is the case this exists for. @IsOptional skips undefined and
 * null but NOT the empty string, so without the transform a chip bar with
 * nothing picked got a 400 instead of the diary.
 *
 * A STRAY COMMA IS NOW TIDIED, NOT REFUSED. The chips used to answer a
 * malformed list differently from the ids -- `staffId=reem,` worked while
 * `status=upcoming,` was a 400 -- so `tidyChipList` folds the chip values
 * through the same `commaList` the ids use. A trailing, leading, doubled or
 * lone comma, and surrounding spaces, are all dropped; a real typo is still a
 * 400. Both families now answer the same malformed input the same way.
 */

const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});

const dayMeta: ArgumentMetadata = {
  type: 'query',
  metatype: CalendarDayQuery,
  data: '',
};

const weekMeta: ArgumentMetadata = {
  type: 'query',
  metatype: CalendarWeekQuery,
  data: '',
};

async function accepted<T = CalendarDayQuery>(
  raw: Record<string, unknown>,
  meta: ArgumentMetadata = dayMeta,
): Promise<T> {
  return (await pipe.transform(raw, meta)) as T;
}

/** The field errors, or a failure saying it was accepted. */
async function refused(
  raw: Record<string, unknown>,
  meta: ArgumentMetadata = dayMeta,
): Promise<string[]> {
  try {
    await pipe.transform(raw, meta);
  } catch (e) {
    if (e instanceof BadRequestException) {
      return (e.getResponse() as { message: string[] }).message;
    }
    throw e;
  }
  throw new Error('expected a refusal, the query was accepted');
}

const STATUS_MESSAGE =
  'status must be a comma-separated list of: upcoming, checked_in, in_service, completed, no_show, cancelled';
const PAYMENT_MESSAGE =
  'payment must be a comma-separated list of: unpaid, deposit_paid, fully_paid';

describe('CalendarDayQuery status', () => {
  it('reads an empty status= as no filter, not a 400', async () => {
    const q = await accepted({ date: '2026-09-20', status: '' });

    expect(q.status).toBeUndefined();
  });

  it('leaves a missing status missing', async () => {
    const q = await accepted({ date: '2026-09-20' });

    expect(q.status).toBeUndefined();
  });

  it('passes a chip list through untouched', async () => {
    const q = await accepted({
      date: '2026-09-20',
      status: 'checked_in,in_service',
    });

    expect(q.status).toBe('checked_in,in_service');
  });

  // ---- the tidy-up: a stray comma or space is dropped, not refused --------

  it('tidies a trailing comma to the bare chip', async () => {
    const q = await accepted({ date: '2026-09-20', status: 'no_show,' });

    expect(q.status).toBe('no_show');
  });

  it('tidies a leading comma', async () => {
    const q = await accepted({ date: '2026-09-20', status: ',upcoming' });

    expect(q.status).toBe('upcoming');
  });

  it('tidies a doubled comma between chips', async () => {
    const q = await accepted({
      date: '2026-09-20',
      status: 'upcoming,,checked_in',
    });

    expect(q.status).toBe('upcoming,checked_in');
  });

  it('trims spaces around each value', async () => {
    const q = await accepted({
      date: '2026-09-20',
      status: ' upcoming , checked_in ',
    });

    expect(q.status).toBe('upcoming,checked_in');
  });

  it('reads a lone comma as no filter', async () => {
    const q = await accepted({ date: '2026-09-20', status: ',' });

    expect(q.status).toBeUndefined();
  });

  it('reads a lone space as no filter', async () => {
    const q = await accepted({ date: '2026-09-20', status: ' ' });

    expect(q.status).toBeUndefined();
  });

  // ---- a real typo is still a 400, tidy-up or not ------------------------

  it('still refuses a word that is not a chip, naming the six', async () => {
    const errors = await refused({ date: '2026-09-20', status: 'checkedin' });

    expect(errors).toEqual([STATUS_MESSAGE]);
  });

  it('still refuses an unknown word buried in a tidy list', async () => {
    const errors = await refused({
      date: '2026-09-20',
      status: 'upcoming,banana',
    });

    expect(errors).toEqual([STATUS_MESSAGE]);
  });
});

describe('CalendarDayQuery payment', () => {
  it('reads an empty payment= as no filter', async () => {
    const q = await accepted({ date: '2026-09-20', payment: '' });

    expect(q.payment).toBeUndefined();
  });

  it('tidies a trailing comma to the bare chip', async () => {
    const q = await accepted({ date: '2026-09-20', payment: 'unpaid,' });

    expect(q.payment).toBe('unpaid');
  });

  it('reads a lone comma as no filter', async () => {
    const q = await accepted({ date: '2026-09-20', payment: ',' });

    expect(q.payment).toBeUndefined();
  });

  it('still refuses a word that is not a payment chip, naming the three', async () => {
    const errors = await refused({ date: '2026-09-20', payment: 'paid' });

    expect(errors).toEqual([PAYMENT_MESSAGE]);
  });
});

/**
 * THE WEEK DTO CARRIES THE SAME TWO CHIP FILTERS, so the fix has to land on
 * both. These prove the tidy-up and the refusal both hold on CalendarWeekQuery,
 * whose date field is `from` rather than `date`.
 */
describe('CalendarWeekQuery status and payment', () => {
  it('tidies a trailing comma on the week status too', async () => {
    const q = await accepted<CalendarWeekQuery>(
      { from: '2026-09-21', status: 'no_show,' },
      weekMeta,
    );

    expect(q.status).toBe('no_show');
  });

  it('tidies a doubled comma on the week payment', async () => {
    const q = await accepted<CalendarWeekQuery>(
      { from: '2026-09-21', payment: 'unpaid,,fully_paid' },
      weekMeta,
    );

    expect(q.payment).toBe('unpaid,fully_paid');
  });

  it('reads a lone comma as no filter on the week', async () => {
    const q = await accepted<CalendarWeekQuery>(
      { from: '2026-09-21', status: ',' },
      weekMeta,
    );

    expect(q.status).toBeUndefined();
  });

  it('still refuses a bad chip on the week, naming the six', async () => {
    const errors = await refused(
      { from: '2026-09-21', status: 'checkedin' },
      weekMeta,
    );

    expect(errors).toEqual([STATUS_MESSAGE]);
  });
});
