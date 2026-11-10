import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { Observable } from 'rxjs';

import { callWithRetry, type GrpcCallOptions } from './call-with-retry';
import { describeGrpcFailure } from './grpc-failure';
import { SERVICES_DIRECTORY_CLIENT } from './services-grpc.constants';
import {
  tenantVatFromPlatform,
  type TaxSettingsAnswer,
  type TaxSettingsReader,
} from '@application/ports/tax-settings.port';
import { DEFAULT_VAT, saneVatPolicy } from '@domain/shared/vat';

/** services.proto TaxSettings, snake_case as declared. */
interface TaxSettingsWire {
  configured?: boolean;
  vat_bps?: number;
  tax_mode?: string;
  tax_rate_id?: string;
}

interface TaxSettingsGrpc {
  getTaxSettings(
    data: { tenant_id: string },
    metadata?: Metadata,
    options?: GrpcCallOptions,
  ): Observable<TaxSettingsWire>;
}

const CALL_TIMEOUT_MS = 2_000;

/**
 * How long a tenant's answer is kept. A rate changes a few times a decade;
 * a quote is asked many times a minute. Five minutes is how long a changed
 * rate takes to reach the app -- and the till freezes its rate per ticket
 * anyway.
 */
export const TAX_SETTINGS_TTL_MS = 5 * 60_000;

const DEFAULT_ANSWER: TaxSettingsAnswer = {
  policy: DEFAULT_VAT,
  source: 'default',
};

/**
 * TAX_SETTINGS over gRPC to platform's ServicesDirectory.GetTaxSettings,
 * the same resolver the POS opens a ticket with (resolveDefaultVat).
 *
 * NEVER FAILS A QUOTE: a platform that is down or answers nonsense falls back
 * to DEFAULT_VAT, logged once per tenant per outage. A FAILURE IS NOT CACHED,
 * so the next quote asks again; an answer is, for TAX_SETTINGS_TTL_MS.
 */
@Injectable()
export class GrpcTaxSettings implements TaxSettingsReader, OnModuleInit {
  private readonly logger = new Logger(GrpcTaxSettings.name);
  private svc!: TaxSettingsGrpc;
  private readonly cache = new Map<
    string,
    { readonly answer: TaxSettingsAnswer; readonly atMs: number }
  >();
  private readonly failing = new Set<string>();

  constructor(
    @Inject(SERVICES_DIRECTORY_CLIENT) private readonly client: ClientGrpc,
  ) {}

  onModuleInit(): void {
    this.svc = this.client.getService<TaxSettingsGrpc>('ServicesDirectory');
  }

  async forTenant(tenantId: string | null): Promise<TaxSettingsAnswer> {
    if (!tenantVatFromPlatform() || tenantId === null || tenantId === '') {
      return DEFAULT_ANSWER;
    }
    const now = Date.now();
    const hit = this.cache.get(tenantId);
    if (hit !== undefined && now - hit.atMs < TAX_SETTINGS_TTL_MS) {
      return hit.answer;
    }

    let res: TaxSettingsWire;
    try {
      res = await callWithRetry(
        this.logger,
        `GetTaxSettings ${tenantId.slice(0, 8)}`,
        CALL_TIMEOUT_MS,
        (md, opts) =>
          this.svc.getTaxSettings({ tenant_id: tenantId }, md, opts),
      );
    } catch (e) {
      if (!this.failing.has(tenantId)) {
        this.failing.add(tenantId);
        this.logger.error(
          `GetTaxSettings for ${tenantId}: platform ${describeGrpcFailure(e)} ` +
            '-- quoting 5% exclusive until it answers',
        );
      }
      return DEFAULT_ANSWER;
    }
    this.failing.delete(tenantId);

    const policy = {
      bps: Number(res.vat_bps ?? 0),
      inclusive: (res.tax_mode ?? '').toUpperCase() === 'INCLUSIVE',
    };
    const answer: TaxSettingsAnswer =
      res.configured === true && saneVatPolicy(policy)
        ? { policy, source: 'platform' }
        : DEFAULT_ANSWER;
    if (answer === DEFAULT_ANSWER && res.configured === true) {
      this.logger.error(
        `GetTaxSettings for ${tenantId}: a rate no tenant can have ` +
          `(${String(res.vat_bps)} bps) -- quoting 5% exclusive`,
      );
    }
    this.cache.set(tenantId, { answer, atMs: now });
    return answer;
  }
}
