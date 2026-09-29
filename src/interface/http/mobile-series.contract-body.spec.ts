import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HttpException,
  ValidationPipe,
  type ArgumentMetadata,
  type ExecutionContext,
} from '@nestjs/common';
import {
  CUSTOM_ROUTE_ARGS_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import {
  EDGE_VALIDATION,
  MobileRoutineContractDto,
  MobileSeriesBodyPipe,
  MobileSeriesController,
  MobileSeriesDto,
  routineContractOf,
} from './mobile-series.controller';
import { mobileValidationPipe } from './mobile-validation.pipe';

/**
 * STEP B1 (gostyle-customer-api docs/ROUTINE_FE_CONTRACT_AUDIT.md, 4.1): the
 * create body with the app team's contract options, behind
 * MOBILE_ROUTINE_CONTRACT.
 *
 * "TODAY" IS MEASURED, NOT WRITTEN DOWN. Before B1 the create body was
 * checked by main.ts's global ValidationPipe against MobileSeriesDto (global
 * pipes run first). `today` below is that pipe, so every flag-off case
 * compares the new pipe's answer with the old one, body by body.
 */

const today = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});
const AS_BODY: ArgumentMetadata = {
  type: 'body',
  metatype: MobileSeriesDto,
  data: undefined,
};

type Outcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: number; readonly body: unknown };

async function outcome(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    if (e instanceof HttpException) {
      return { ok: false, status: e.getStatus(), body: e.getResponse() };
    }
    throw e;
  }
}

const viaPipe = (raw: object) =>
  outcome(() => new MobileSeriesBodyPipe().transform(structuredClone(raw)));
const viaToday = (raw: object) =>
  outcome(() => today.transform(structuredClone(raw), AS_BODY));

function oldBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    salon_id: 'marina-walk',
    services: [{ id: 'haircut-finish', amount: 120 }],
    stylist_id: 'maya',
    frequency: 'MONTHLY',
    start_date: '2026-10-06',
    sessions: 3,
    time: '16:30',
    payment_plan: 'PAY_AT_SALON',
    picks: [{ index: 1, date: '2026-11-07', time: '17:00' }],
    products: [{ id: 'pomade-100', amount: 20 }],
    amount_without_tax: 360,
    tax_amount: 18,
    discount: 0,
    total: 378,
    ...over,
  };
}

function without(key: string): Record<string, unknown> {
  const body = oldBody();
  delete body[key];
  return body;
}

function dryRunWithoutFigures(): Record<string, unknown> {
  const body = without('time');
  for (const k of ['amount_without_tax', 'tax_amount', 'discount', 'total']) {
    delete body[k];
  }
  return { ...body, dry_run: true };
}

const OPTIONS = {
  stylist_candidates: ['maya', 'omar'],
  check_later: true,
  with_reasons: true,
  alternative_rule: 'SAME_STYLIST_FORWARD',
  alternatives_max: 12,
  strict_picks: true,
};

/** Old bodies, good and bad, none with a contract option. */
const OLD_BODIES: readonly (readonly [string, Record<string, unknown>])[] = [
  ['a create', oldBody()],
  ['a dry run with no time and no figures', dryRunWithoutFigures()],
  ['a body with a field missing', without('salon_id')],
  [
    'a body with a wrong type and an unknown field',
    oldBody({ sessions: 'three', foo: 1 }),
  ],
  ['a body with a bad pick', oldBody({ picks: [{ index: 'one' }] })],
];

afterEach(() => {
  delete process.env.MOBILE_ROUTINE_CONTRACT;
});

/** Every body the flag-off pipe is compared on: the old ones, and options. */
const FLAG_OFF_BODIES: readonly (readonly [string, Record<string, unknown>])[] =
  [
    ...OLD_BODIES,
    ...Object.entries(OPTIONS).map(
      ([k, v]) => [`an old body plus ${k}`, oldBody({ [k]: v })] as const,
    ),
    ['an old body plus every option', oldBody(OPTIONS)],
    ['an option of the wrong type', oldBody({ check_later: 'yes' })],
    [
      'an option next to a bad old field',
      oldBody({ alternatives_max: 99, sessions: 'three' }),
    ],
    [
      'options and an unknown field, in body order',
      oldBody({ strict_picks: true, foo: 1, check_later: true }),
    ],
  ];

describe('the create body, MOBILE_ROUTINE_CONTRACT off (the default)', () => {
  it.each(FLAG_OFF_BODIES)(
    '%s: exactly the answer it had before B1',
    async (_name, raw) => {
      expect(await viaPipe(raw)).toStrictEqual(await viaToday(raw));
    },
  );

  it('refuses a contract option as an unknown property, 400, as before', async () => {
    const answer = await viaPipe(oldBody({ check_later: true }));
    expect(answer).toStrictEqual({
      ok: false,
      status: 400,
      body: {
        statusCode: 400,
        message: ['property check_later should not exist'],
        error: 'Bad Request',
      },
    });
  });

  it('a good old body comes out as the old class, carrying no options', async () => {
    const answer = await viaPipe(oldBody());
    expect(answer.ok).toBe(true);
    const dto = (answer as { value: MobileSeriesDto }).value;
    expect(dto).toBeInstanceOf(MobileSeriesDto);
    expect(dto).not.toBeInstanceOf(MobileRoutineContractDto);
    expect(routineContractOf(dto)).toBeNull();
  });
});

describe('the create body, MOBILE_ROUTINE_CONTRACT on', () => {
  const on = () => {
    process.env.MOBILE_ROUTINE_CONTRACT = 'true';
  };

  it('accepts every option and carries them in our words', async () => {
    on();
    const answer = await viaPipe(oldBody(OPTIONS));
    expect(answer.ok).toBe(true);
    const dto = (answer as { value: MobileSeriesDto }).value;
    expect(dto).toBeInstanceOf(MobileRoutineContractDto);
    expect(routineContractOf(dto)).toStrictEqual({
      stylistCandidates: ['maya', 'omar'],
      checkLater: true,
      withReasons: true,
      alternativeRule: 'SAME_STYLIST_FORWARD',
      alternativesMax: 12,
      strictPicks: true,
    });
  });

  it('one option alone: the rest take their "off" value', async () => {
    on();
    const answer = await viaPipe(oldBody({ alternatives_max: 5 }));
    const dto = (answer as { value: MobileSeriesDto }).value;
    expect(routineContractOf(dto)).toStrictEqual({
      stylistCandidates: null,
      checkLater: false,
      withReasons: false,
      alternativeRule: null,
      alternativesMax: 5,
      strictPicks: false,
    });
  });

  it('an option sent as null counts as not sent', async () => {
    on();
    const answer = await viaPipe(oldBody({ check_later: null }));
    expect(answer.ok).toBe(true);
    const dto = (answer as { value: MobileSeriesDto }).value;
    expect(routineContractOf(dto)).toBeNull();
  });

  it.each(OLD_BODIES)(
    '%s, with no option: the same answer as with the flag off',
    async (_name, raw) => {
      const off = await viaPipe(raw);
      on();
      const onAnswer = await viaPipe(raw);
      if (off.ok) {
        // The class differs (the subclass), the values do not.
        expect(onAnswer).toEqual(off);
        expect(
          routineContractOf((onAnswer as { value: MobileSeriesDto }).value),
        ).toBeNull();
      } else {
        expect(onAnswer).toStrictEqual(off);
      }
    },
  );

  it.each([
    ['stylist_candidates', []],
    ['stylist_candidates', ['']],
    ['stylist_candidates', 'maya'],
    ['stylist_candidates', [7]],
    ['alternatives_max', 0],
    ['alternatives_max', 13],
    ['alternatives_max', 2.5],
    ['alternative_rule', 'ANY'],
    ['check_later', 'yes'],
    ['with_reasons', 1],
    ['strict_picks', 'true'],
  ])('refuses %s = %j with a 400 that names it', async (field, value) => {
    on();
    const answer = await viaPipe(oldBody({ [field]: value }));
    expect(answer.ok).toBe(false);
    const { status, body } = answer as {
      status: number;
      body: { message: string[] };
    };
    expect(status).toBe(400);
    expect(body.message.length).toBeGreaterThan(0);
    expect(body.message.every((m) => m.includes(field))).toBe(true);
  });

  it('still refuses a field nobody knows', async () => {
    on();
    const answer = await viaPipe(oldBody({ foo: 1 }));
    expect(answer).toMatchObject({
      ok: false,
      status: 400,
      body: { message: ['property foo should not exist'] },
    });
  });
});

describe('the wiring', () => {
  it("EDGE_VALIDATION is main.ts's global pipe, word for word", () => {
    const main = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8');
    const m = /useGlobalPipes\(\s*new ValidationPipe\(\{([^}]*)\}\)/.exec(main);
    expect(m).not.toBeNull();
    const global = m![1]!
      .split(',')
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => s !== '')
      .sort();
    const ours = Object.entries(EDGE_VALIDATION)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .sort();
    expect(global).toStrictEqual(ours);
  });

  it('the create body is a custom param with MobileSeriesBodyPipe, not @Body()', () => {
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      MobileSeriesController,
      'create',
    ) as Record<
      string,
      {
        index: number;
        pipes: unknown[];
        factory?: (data: unknown, ctx: ExecutionContext) => unknown;
      }
    >;
    const [key, first] = Object.entries(args).find(([, a]) => a.index === 0)!;
    expect(key).toContain(CUSTOM_ROUTE_ARGS_METADATA);
    expect(first.pipes).toStrictEqual([MobileSeriesBodyPipe]);

    const body = { salon_id: 'marina-walk' };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ body }) }),
    } as unknown as ExecutionContext;
    expect(first.factory!(undefined, ctx)).toBe(body);
  });

  it('the global pipe and the mobile pipe both pass a custom param over untouched', async () => {
    const raw = oldBody({ check_later: true, foo: 1 });
    const custom: ArgumentMetadata = {
      type: 'custom',
      metatype: MobileSeriesDto,
      data: undefined,
    };
    await expect(today.transform(raw, custom)).resolves.toBe(raw);
    await expect(mobileValidationPipe().transform(raw, custom)).resolves.toBe(
      raw,
    );
  });

  it('the published body is still the old MobileSeriesDto', () => {
    const create = Object.getOwnPropertyDescriptor(
      MobileSeriesController.prototype,
      'create',
    )!.value as object;
    const params = Reflect.getMetadata('swagger/apiParameters', create) as {
      in: string;
      type: unknown;
    }[];
    expect(params).toContainEqual(
      expect.objectContaining({ in: 'body', type: MobileSeriesDto }),
    );
  });
});
