import { describe, it, expect } from 'vitest';
import {
  posTicketSyncEnabled,
  posTicketSyncFor,
  posTicketSyncTenants,
} from './pos-ticket-sync.flag';

describe('POS_TICKET_SYNC_ENABLED', () => {
  it('is off unless it says true', () => {
    expect(posTicketSyncEnabled(undefined)).toBe(false);
    expect(posTicketSyncEnabled('')).toBe(false);
    expect(posTicketSyncEnabled('1')).toBe(false);
    expect(posTicketSyncEnabled('yes')).toBe(false);
    expect(posTicketSyncEnabled(' TRUE ')).toBe(true);
  });
});

describe('POS_TICKET_SYNC_TENANTS', () => {
  it('splits and trims, and treats empty as every tenant', () => {
    expect(posTicketSyncTenants(undefined)).toEqual([]);
    expect(posTicketSyncTenants(' , ')).toEqual([]);
    expect(posTicketSyncTenants(' a , b,')).toEqual(['a', 'b']);
  });
});

describe('posTicketSyncFor', () => {
  it('is no while the switch is off, whoever asks', () => {
    expect(posTicketSyncFor('t1', false, [])).toBe(false);
  });

  it('is every tenant with an empty list', () => {
    expect(posTicketSyncFor('t1', true, [])).toBe(true);
  });

  it('narrows to the list', () => {
    expect(posTicketSyncFor('t1', true, ['t1'])).toBe(true);
    expect(posTicketSyncFor('t2', true, ['t1'])).toBe(false);
  });

  it('never syncs a booking with no tenant', () => {
    expect(posTicketSyncFor(null, true, [])).toBe(false);
  });
});
