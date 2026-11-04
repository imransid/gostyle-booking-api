import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { MobilePackagesHandler } from '@application/queries/mobile-packages.handler';
import { Money } from '@domain/shared/money';
import { DeskOnly } from '../../auth/desk-only.decorator';
import { BranchId } from './branch.decorator';

export interface DeskPackagesView {
  readonly branchId: string;
  readonly count: number;
  readonly packages: readonly {
    /** Send this in `serviceIds` on quote, hold, confirm or walk-in. */
    readonly packageId: string;
    readonly name: string;
    /** What the package sells for, net of VAT: what a booking charges. */
    readonly priceMinor: number;
    readonly price: string;
    /** The parts at their own prices. Display only. */
    readonly partsTotalMinor: number;
    readonly savingMinor: number;
    readonly saving: string;
    /** The parts end to end. A guide; the quote decides. */
    readonly durationMin: number;
    /** What is performed, in order. Their serviceIds, not the package's. */
    readonly parts: readonly {
      readonly serviceId: string;
      readonly name: string;
      /** This part's share of the package price, as a booking stores it. */
      readonly priceMinor: number;
      readonly durationMin: number;
    }[];
  }[];
}

/**
 * The packages a branch sells, for the desk's picker.
 *
 * The desk could already SELL a package -- quote, hold, confirm and walk-in
 * all take a package id among their serviceIds -- but had nowhere to learn
 * which packages exist: only the app's /v1/mobile-packages listed them. The
 * same list, in the desk's vocabulary, from the same handler, so a package
 * cannot be listed at one price and sold at another.
 */
@ApiTags('packages')
@Controller('packages')
@DeskOnly()
export class PackagesController {
  constructor(private readonly handler: MobilePackagesHandler) {}

  @Get()
  @ApiOperation({
    summary: 'Packages sold at a branch',
    description:
      'Each package with its price, its parts and what it saves. Send ' +
      'packageId among serviceIds on quote, hold, confirm or walk-in, and ' +
      'it is sold at its own price, carried by its parts.',
  })
  @ApiOkResponse({ description: '{ branchId, count, packages }' })
  async list(@BranchId() branchId: string): Promise<DeskPackagesView> {
    const offers = await this.handler.offers(branchId);
    return {
      branchId,
      count: offers.length,
      packages: offers.map((o) => ({
        packageId: o.id,
        name: o.name,
        priceMinor: o.priceFils,
        price: Money.fils(o.priceFils).toString(),
        partsTotalMinor: o.partsTotalFils,
        savingMinor: o.savingFils,
        saving: Money.fils(o.savingFils).toString(),
        durationMin: o.durationMin,
        parts: o.parts.map((p) => ({
          serviceId: p.id,
          name: p.name,
          priceMinor: p.priceFils,
          durationMin: p.durationMin,
        })),
      })),
    };
  }
}
