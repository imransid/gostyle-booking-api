import { describe, it, expect } from 'vitest';
import { bookingIdsOf, withSeriesIds } from './mobile-series-list';

const B1 = '11111111-1111-4111-8111-111111111111';
const B2 = '22222222-2222-4222-8222-222222222222';
const APP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('withSeriesIds: Upcoming and Archive rows name their routine', () => {
  it('gives a visit of an app routine its series_id', () => {
    const rows = withSeriesIds(
      [{ id: B1, code: 'GS-1337' }],
      new Map([[B1, APP]]),
    );
    expect(rows).toEqual([{ id: B1, code: 'GS-1337', series_id: APP }]);
  });

  it('gives every other row series_id null', () => {
    const rows = withSeriesIds(
      [{ id: B2 }, { code: 'no id' }],
      new Map([[B1, APP]]),
    );
    expect(rows).toEqual([
      { id: B2, series_id: null },
      { code: 'no id', series_id: null },
    ]);
  });

  it('leaves the rows it was given as they were', () => {
    const row = { id: B1 };
    withSeriesIds([row], new Map([[B1, APP]]));
    expect(row).toEqual({ id: B1 });
  });
});

describe('bookingIdsOf: only real ids reach the database', () => {
  it('keeps uuids and drops the rest', () => {
    expect(
      bookingIdsOf([
        { id: B1 },
        { id: 'GS-1337' },
        { code: 'x' },
        null,
        { id: B2 },
      ]),
    ).toEqual([B1, B2]);
  });
});
