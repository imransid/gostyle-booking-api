import { describe, expect, it } from 'vitest';
import { commaList } from './calendar-query';

describe('commaList', () => {
  it('reads one value as a list of one, spelled exactly as sent', () => {
    // Case and uuid spelling are toUuid's and SlugIndex's to judge, not this.
    expect(commaList('maya')).toEqual(['maya']);
    expect(commaList('Maya')).toEqual(['Maya']);
    expect(commaList('8384C1F0-7366-4867-AEB8-27C23D34F910')).toEqual([
      '8384C1F0-7366-4867-AEB8-27C23D34F910',
    ]);
  });

  it('reads several values in the order they were sent', () => {
    expect(commaList('reem,maya,anya')).toEqual(['reem', 'maya', 'anya']);
  });

  it('drops whitespace around a value, so "maya, reem" is two stylists', () => {
    expect(commaList('maya, reem')).toEqual(['maya', 'reem']);
    expect(commaList(' maya ')).toEqual(['maya']);
  });

  it('reads nothing as absent, never as an empty list that matches nobody', () => {
    expect(commaList(undefined)).toBeUndefined();
    expect(commaList('')).toBeUndefined();
    expect(commaList(',')).toBeUndefined();
    expect(commaList(' , ,')).toBeUndefined();
  });

  it('skips the gaps a stray comma leaves', () => {
    expect(commaList('maya,')).toEqual(['maya']);
    expect(commaList(',maya,,reem')).toEqual(['maya', 'reem']);
  });

  it('checks no vocabulary: an id nobody holds is still passed on', () => {
    expect(commaList('maya,ghost')).toEqual(['maya', 'ghost']);
  });
});
