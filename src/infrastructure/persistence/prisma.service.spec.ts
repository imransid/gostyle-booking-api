import { describe, it, expect } from 'vitest';
import { poolConfig } from './prisma.service';

/**
 * ONE ASSERTION THAT MATTERS, and it is about a string.
 *
 * Without `-c timezone=UTC` the API still boots, still connects, still reads
 * and writes, and every unit test in this repo still passes -- while on a
 * database whose own timezone is not UTC, no booking can be confirmed at all
 * (see the comment on poolConfig). There is no type, no constraint and no
 * other test that would notice its removal.
 */
describe('poolConfig', () => {
  it('pins every session to UTC', () => {
    expect(poolConfig('postgres://x/y').options).toBe('-c timezone=UTC');
  });

  it('passes the connection string through untouched', () => {
    const url = 'postgres://u:p@host:5432/db?schema=public';
    expect(poolConfig(url).connectionString).toBe(url);
  });

  it('keeps the connect timeout, so a hung connect fails fast', () => {
    expect(poolConfig('postgres://x/y').connectionTimeoutMillis).toBe(5_000);
  });
});
