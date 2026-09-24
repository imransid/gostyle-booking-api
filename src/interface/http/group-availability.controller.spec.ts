import { describe, expect, it } from 'vitest';
import {
  BadRequestException,
  ValidationPipe,
  type ArgumentMetadata,
} from '@nestjs/common';
import {
  GroupAvailabilityController,
  GroupAvailabilityDto,
} from './group-availability.controller';
import type { GroupAvailabilityHandler } from '@application/queries/group-availability.handler';

/**
 * THE EDGE OF POST /v1/bookings/availability/group.
 *
 * Driven through a ValidationPipe built with EXACTLY the options main.ts
 * gives the global one -- transform, whitelist, forbidNonWhitelisted -- so a
 * body is accepted or refused here for the reason it would be on the wire.
 * If main.ts changes those options, this must change with it.
 *
 * The first block PINS the single-start request. Its snapshots were written
 * before `targetMins` existed: what the pipe accepts, the exact 400 it
 * answers with otherwise, and the exact query the controller hands the
 * handler. All compared as JSON strings, so key order counts.
 */

const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});

const meta: ArgumentMetadata = {
  type: 'body',
  metatype: GroupAvailabilityDto,
  data: '',
};

async function accepted(raw: unknown): Promise<GroupAvailabilityDto> {
  const out: unknown = await pipe.transform(raw, meta);
  expect(out).toBeInstanceOf(GroupAvailabilityDto);
  return out as GroupAvailabilityDto;
}

async function refused(raw: unknown): Promise<string> {
  try {
    await pipe.transform(raw, meta);
  } catch (e) {
    if (e instanceof BadRequestException)
      return JSON.stringify(e.getResponse());
    throw e;
  }
  throw new Error('expected a 400, the body was accepted');
}

const pair = [
  { label: 'A', serviceIds: ['blow-dry'] },
  { label: 'B', serviceIds: ['gel-manicure'] },
];

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    day: '2026-10-11',
    targetMin: 900,
    mode: 'TOGETHER',
    participants: pair,
    ...over,
  };
}

/** Bodies that work today, from the least to the most they can say. */
const SINGLE_ACCEPTED: Readonly<Record<string, Record<string, unknown>>> = {
  minimal: body(),
  'every optional field': body({
    branchId: 'marina-walk',
    mode: 'finish',
    finishWindowMin: 15,
    maxStaggerMin: 45,
    participants: [
      { label: 'A', serviceIds: ['blow-dry'], preferredStaffId: 'maya' },
      { label: 'B', serviceIds: ['gel-manicure', 'brow-lamination'] },
    ],
  }),
  'the first minute': body({ targetMin: 600 }),
  'the last minute': body({ targetMin: 1319 }),
};

/** Bodies refused today, each for a different reason. */
const SINGLE_REFUSED: Readonly<Record<string, unknown>> = {
  'an empty body': {},
  'no targetMin': (() => {
    const { targetMin: _, ...rest } = body();
    return rest;
  })(),
  'targetMin at the close': body({ targetMin: 1320 }),
  'targetMin before the open': body({ targetMin: 599 }),
  'targetMin as a string': body({ targetMin: '600' }),
  'targetMin with a fraction': body({ targetMin: 600.5 }),
  'targetMin null': body({ targetMin: null }),
  'a day that is not a date': body({ day: 'tomorrow' }),
  'an unknown mode': body({ mode: 'SOMETIME' }),
  'a party of one': body({ participants: [pair[0]] }),
  'a party of nine': body({
    participants: Array.from({ length: 9 }, (_, i) => ({
      label: `P${i}`,
      serviceIds: ['blow-dry'],
    })),
  }),
  'a participant with a customerId': body({
    participants: [{ ...pair[0], customerId: 'dana' }, pair[1]],
  }),
  'a field the route does not take': body({ arrangement: 'ORGANIZER' }),
  'a participant with no services': body({
    participants: [{ label: 'A', serviceIds: [] }, pair[1]],
  }),
};

/** A handler that records what it was asked and answers with a marker. */
function recordingHandler() {
  const asked: { method: string; query: string }[] = [];
  const handler = {
    execute: (q: unknown) => {
      asked.push({ method: 'execute', query: JSON.stringify(q) });
      return Promise.resolve({ answer: 'single' });
    },
  };
  return { handler: handler as unknown as GroupAvailabilityHandler, asked };
}

describe('one start: the request as it was before targetMins existed', () => {
  for (const [name, raw] of Object.entries(SINGLE_ACCEPTED)) {
    it(`accepts ${name}, and hands the handler the same query`, async () => {
      const dto = await accepted(raw);
      const { handler, asked } = recordingHandler();
      const answer = await new GroupAvailabilityController(handler).group(
        dto,
        'branch-from-the-decorator',
      );

      expect(answer).toEqual({ answer: 'single' });
      expect(asked).toHaveLength(1);
      expect({ dto: JSON.stringify(dto), asked }).toMatchSnapshot();
    });
  }

  for (const [name, raw] of Object.entries(SINGLE_REFUSED)) {
    it(`refuses ${name} with the same 400`, async () => {
      expect(await refused(raw)).toMatchSnapshot();
    });
  }
});

// ------------------------------------------------------------ many starts

/** Records which handler method the controller chose, and with what. */
function recordingBoth() {
  const asked: { method: string; query: unknown }[] = [];
  const handler = {
    execute: (q: unknown) => {
      asked.push({ method: 'execute', query: q });
      return Promise.resolve({ answer: 'single' });
    },
    executeMany: (q: unknown) => {
      asked.push({ method: 'executeMany', query: q });
      return Promise.resolve({ starts: [] });
    },
  };
  return { handler: handler as unknown as GroupAvailabilityHandler, asked };
}

/** A list body: targetMin removed, targetMins in its place. */
function listBody(
  targetMins: unknown,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  const { targetMin: _, ...rest } = body(over);
  return { ...rest, targetMins };
}

const HALF_HOURS = Array.from({ length: 24 }, (_, i) => 600 + i * 30);

/** The 400's messages, parsed back out of the pinned JSON form. */
async function messages(raw: unknown): Promise<string[]> {
  return (JSON.parse(await refused(raw)) as { message: string[] }).message;
}

describe('many starts: what the edge accepts, and where it sends it', () => {
  it('sends a list to executeMany, never to execute', async () => {
    const dto = await accepted(listBody(HALF_HOURS));
    const { handler, asked } = recordingBoth();
    const answer = await new GroupAvailabilityController(handler).group(
      dto,
      'branch-from-the-decorator',
    );

    expect(answer).toEqual({ starts: [] });
    expect(asked).toEqual([
      {
        method: 'executeMany',
        query: {
          branchId: 'branch-from-the-decorator',
          tradingDay: '2026-10-11',
          targetMins: HALF_HOURS,
          mode: 'arrive_together',
          participants: [
            { label: 'A', serviceIds: ['blow-dry'], preferredStaffId: null },
            {
              label: 'B',
              serviceIds: ['gel-manicure'],
              preferredStaffId: null,
            },
          ],
        },
      },
    ]);
  });

  it('carries every optional field through, as the single call does', async () => {
    const dto = await accepted(
      listBody([600, 900], {
        mode: 'finish',
        finishWindowMin: 15,
        maxStaggerMin: 45,
        participants: [
          { label: 'A', serviceIds: ['blow-dry'], preferredStaffId: 'maya' },
          pair[1],
        ],
      }),
    );
    const { handler, asked } = recordingBoth();
    await new GroupAvailabilityController(handler).group(dto, 'b');

    expect(asked[0]).toMatchObject({
      method: 'executeMany',
      query: {
        targetMins: [600, 900],
        mode: 'finish_together',
        finishWindowMin: 15,
        maxStaggerMin: 45,
        participants: [
          { label: 'A', serviceIds: ['blow-dry'], preferredStaffId: 'maya' },
          { label: 'B', serviceIds: ['gel-manicure'], preferredStaffId: null },
        ],
      },
    });
  });

  it('still sends a single start to execute, with both methods on offer', async () => {
    const { handler, asked } = recordingBoth();
    await new GroupAvailabilityController(handler).group(
      await accepted(body()),
      'b',
    );
    expect(asked.map((a) => a.method)).toEqual(['execute']);
  });

  for (const [name, list] of Object.entries({
    'one start': [600],
    'the last minute': [1319],
    'unsorted, with a repeat': [1000, 600, 1000],
    'exactly the cap': HALF_HOURS,
  })) {
    it(`accepts ${name}, and keeps it as sent`, async () => {
      const dto = await accepted(listBody(list));
      expect(dto.targetMins).toEqual(list);
      expect(dto.targetMin).toBeUndefined();
    });
  }
});

describe('many starts: what the edge refuses', () => {
  it('both targetMin and targetMins', async () => {
    expect(await messages(body({ targetMins: [600] }))).toEqual([
      'send targetMin or targetMins, not both',
    ]);
  });

  it('an empty list', async () => {
    expect(await messages(listBody([]))).toEqual([
      'targetMins should not be empty',
    ]);
  });

  it('one start more than the cap', async () => {
    expect(await messages(listBody([...HALF_HOURS, 1319]))).toEqual([
      'targetMins must contain no more than 24 elements',
    ]);
  });

  it('a start before the open', async () => {
    expect(await messages(listBody([600, 599]))).toEqual([
      'each value in targetMins must not be less than 600',
    ]);
  });

  it('a start at the close, under the same rule as targetMin', async () => {
    expect(await messages(listBody([1320]))).toEqual([
      'each value in targetMins must not be greater than 1319',
    ]);
  });

  it('a start as a string', async () => {
    expect(await messages(listBody(['600']))).toContain(
      'each value in targetMins must be an integer number',
    );
  });

  it('a start with a fraction', async () => {
    expect(await messages(listBody([600.5]))).toEqual([
      'each value in targetMins must be an integer number',
    ]);
  });

  it('null, rather than treating it as absent', async () => {
    expect(await messages(listBody(null))).toContain(
      'targetMins must be an array',
    );
  });

  it('a bare number where the list goes', async () => {
    expect(await messages(listBody(600))).toContain(
      'targetMins must be an array',
    );
  });

  it('never blames targetMin for a body that did not send it', async () => {
    for (const bad of [[], [599], ['600'], null]) {
      const said = await messages(listBody(bad));
      expect(said.some((m) => m.startsWith('targetMin '))).toBe(false);
    }
  });
});
