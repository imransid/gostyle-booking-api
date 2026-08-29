import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsIn } from 'class-validator';

/**
 * A wire enum: SCREAMING_SNAKE on the way out, either case on the way in.
 *
 * The contract specifies uppercase and every response returns it. Being
 * strict on the REQUEST as well buys nothing: a caller sending `desk` has
 * told us unambiguously which channel they mean, and answering that with a
 * 400 listing the same word in capitals is pedantry with a support cost.
 * Postel's rule, scoped to case alone -- `arrive_together` is a different
 * word, not a different case, and is still refused.
 *
 * Normalising BEFORE validation rather than widening the allowed list keeps
 * the published OpenAPI enum clean: the docs say DESK and ONLINE, because
 * that is what a caller should send and what they will always get back.
 */
export function WireEnum<T extends string>(values: readonly T[]) {
  return applyDecorators(
    Transform(({ value }) =>
      typeof value === 'string' ? value.toUpperCase() : value,
    ),
    IsIn(values),
  );
}
