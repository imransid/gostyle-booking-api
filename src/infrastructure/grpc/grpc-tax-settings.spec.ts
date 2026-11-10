import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { status } from '@grpc/grpc-js';
import { loadSync, type ServiceDefinition } from '@grpc/proto-loader';
import { of, throwError, type Observable } from 'rxjs';

import { GrpcTaxSettings } from './grpc-tax-settings';
import { DEFAULT_VAT } from '@domain/shared/vat';

const TENANT = '0190f0c1-1111-7000-8000-000000000001';

function build(reply: () => Observable<unknown>) {
  const getTaxSettings = vi.fn(() => reply());
  const client = { getService: vi.fn(() => ({ getTaxSettings })) };
  const adapter = new GrpcTaxSettings(client as never);
  adapter.onModuleInit();
  return { adapter, getTaxSettings };
}

const saved = process.env.TENANT_VAT_FROM_PLATFORM;
beforeEach(() => {
  process.env.TENANT_VAT_FROM_PLATFORM = 'true';
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation(() => {});
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  if (saved === undefined) delete process.env.TENANT_VAT_FROM_PLATFORM;
  else process.env.TENANT_VAT_FROM_PLATFORM = saved;
});

describe('GrpcTaxSettings', () => {
  it('answers 5% exclusive without asking while the switch is off', async () => {
    process.env.TENANT_VAT_FROM_PLATFORM = '';
    const { adapter, getTaxSettings } = build(() => of({}));
    expect(await adapter.forTenant(TENANT)).toEqual({
      policy: DEFAULT_VAT,
      source: 'default',
    });
    expect(getTaxSettings).not.toHaveBeenCalled();
  });

  it('reads the tenant’s rate and mode, and keeps the answer', async () => {
    const { adapter, getTaxSettings } = build(() =>
      of({
        configured: true,
        vat_bps: 500,
        tax_mode: 'INCLUSIVE',
        tax_rate_id: 'x',
      }),
    );
    expect(await adapter.forTenant(TENANT)).toEqual({
      policy: { bps: 500, inclusive: true },
      source: 'platform',
    });
    await adapter.forTenant(TENANT);
    expect(getTaxSettings).toHaveBeenCalledTimes(1);
  });

  it('falls back when no rate is configured, or none makes sense', async () => {
    expect(
      await build(() => of({ configured: false })).adapter.forTenant(TENANT),
    ).toEqual({ policy: DEFAULT_VAT, source: 'default' });
    expect(
      await build(() =>
        of({ configured: true, vat_bps: 20_000, tax_mode: 'EXCLUSIVE' }),
      ).adapter.forTenant(TENANT),
    ).toEqual({ policy: DEFAULT_VAT, source: 'default' });
  });

  it('never fails a quote, and does not cache a failure', async () => {
    const { adapter, getTaxSettings } = build(() =>
      throwError(() =>
        Object.assign(new Error('down'), { code: status.INTERNAL }),
      ),
    );
    expect((await adapter.forTenant(TENANT)).source).toBe('default');
    await adapter.forTenant(TENANT);
    expect(getTaxSettings).toHaveBeenCalledTimes(2);
  });

  it('asks nothing for a booking with no tenant', async () => {
    const { adapter, getTaxSettings } = build(() => of({}));
    expect((await adapter.forTenant(null)).source).toBe('default');
    expect(getTaxSettings).not.toHaveBeenCalled();
  });
});

describe('services.proto GetTaxSettings, as the client loads it', () => {
  it('round-trips the answer under its snake_case names', () => {
    const def = loadSync(join(process.cwd(), 'proto/services.proto'), {
      keepCase: true,
      defaults: true,
      longs: String,
      enums: String,
      oneofs: true,
    });
    const svc = def[
      'gostyle.services.v1.ServicesDirectory'
    ] as ServiceDefinition;
    const m = svc.GetTaxSettings!;
    const answer = {
      configured: true,
      vat_bps: 500,
      tax_mode: 'EXCLUSIVE',
      tax_rate_id: '0190f0c1-0000-7000-8000-000000000001',
    };
    expect(m.responseDeserialize(m.responseSerialize(answer))).toEqual(answer);
  });
});
