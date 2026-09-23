import { describe, expect, it } from 'vitest';
import {
  BadRequestException,
  ValidationPipe,
  type ArgumentMetadata,
} from '@nestjs/common';
import { CalendarDayQuery } from './read-models.query';

/**
 * QUERY DTO SPEC — run through a pipe built as main.ts builds the global one,
 * because `transform: true` is what makes @Transform run at all.
 *
 * `status=` is the case this exists for. @IsOptional skips undefined and
 * null but NOT the empty string, so without the transform a chip bar with
 * nothing picked got a 400 instead of the diary.
 */

const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});

const meta: ArgumentMetadata = {
  type: 'query',
  metatype: CalendarDayQuery,
  data: '',
};

async function accepted(
  raw: Record<string, unknown>,
): Promise<CalendarDayQuery> {
  return (await pipe.transform(raw, meta)) as CalendarDayQuery;
}

/** The field errors, or a failure saying it was accepted. */
async function refused(raw: Record<string, unknown>): Promise<string[]> {
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

  it('still refuses a word that is not a chip, naming the six', async () => {
    const errors = await refused({ date: '2026-09-20', status: 'checkedin' });

    expect(errors).toEqual([
      'status must be a comma-separated list of: upcoming, checked_in, in_service, completed, no_show, cancelled',
    ]);
  });

  it('refuses a trailing comma rather than reading it as empty', async () => {
    const errors = await refused({ date: '2026-09-20', status: 'no_show,' });

    expect(errors).toHaveLength(1);
  });
});
