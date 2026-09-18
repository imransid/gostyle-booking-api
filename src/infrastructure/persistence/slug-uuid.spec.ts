import { describe, it, expect } from 'vitest';
import { SlugIndex } from './slug-uuid';
import { toUuid } from './hold.repository';

/**
 * The boundary these tests describe is load-bearing in both directions, and
 * only one of them was ever exercised.
 *
 * Reading a slug back out of a uuid column is what SlugIndex was written
 * for. PASSING A REAL UUID THROUGH UNTOUCHED is the other half, and it is
 * what lets a caller send a platform branch id through a column that also
 * holds folded slugs. Nothing pinned it until group confirm started relying
 * on it.
 */
describe('SlugIndex', () => {
  const index = new SlugIndex(['marina-walk', 'maya', 'full-colour']);

  it('reads a folded slug back out of its uuid', () => {
    expect(index.toSlug(toUuid('marina-walk'))).toBe('marina-walk');
    expect(index.toSlug(toUuid('maya'))).toBe('maya');
  });

  it('is case-insensitive, because Postgres returns uuids lowercased', () => {
    expect(index.toSlug(toUuid('maya').toUpperCase())).toBe('maya');
  });

  it('passes a REAL uuid through untouched', () => {
    // toUuid returns a genuine uuid unchanged, so a platform id stored in
    // this column is still itself. Folding it again, or failing to
    // recognise it, would send the caller's branch to the wrong salon.
    const platform = '22222222-2222-2222-2222-222222222222';
    expect(toUuid(platform)).toBe(platform);
    expect(index.toSlug(platform)).toBe(platform);
  });

  it('round-trips: fold, read back, fold again', () => {
    // What group confirm does -- read the stored branch, resolve it to what
    // the catalogue speaks, then hand it back to a repository that folds it
    // again. The two uuids must be the same one or the reservations and the
    // booking land at different branches.
    for (const id of ['marina-walk', '22222222-2222-2222-2222-222222222222']) {
      expect(toUuid(index.toSlug(toUuid(id)))).toBe(toUuid(id));
    }
  });

  it('leaves an unknown id alone rather than guessing', () => {
    expect(index.toSlug('some-branch-nobody-registered')).toBe(
      'some-branch-nobody-registered',
    );
  });
});
