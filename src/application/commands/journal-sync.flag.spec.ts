import { describe, it, expect } from 'vitest';
import {
  journalPostingEnabled,
  journalPostingTenants,
} from './journal-sync.flag';

describe('journalPostingEnabled', () => {
  it('is off unless it says true', () => {
    expect(journalPostingEnabled(undefined)).toBe(false);
    expect(journalPostingEnabled('')).toBe(false);
    expect(journalPostingEnabled('false')).toBe(false);
    expect(journalPostingEnabled('1')).toBe(false);
    expect(journalPostingEnabled('yes')).toBe(false);
  });

  it('is on for true, however it is written', () => {
    expect(journalPostingEnabled('true')).toBe(true);
    expect(journalPostingEnabled(' TRUE ')).toBe(true);
  });
});

describe('journalPostingTenants', () => {
  it('unset or empty is every tenant', () => {
    expect(journalPostingTenants(undefined)).toEqual([]);
    expect(journalPostingTenants('')).toEqual([]);
    expect(journalPostingTenants(' , ,')).toEqual([]);
  });

  it('reads a comma-separated list, trimmed', () => {
    expect(journalPostingTenants(' a-1 ,b-2,, c-3 ')).toEqual([
      'a-1',
      'b-2',
      'c-3',
    ]);
  });
});
