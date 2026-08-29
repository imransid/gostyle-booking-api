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
export function WireEnum<T extends string>(
  values: readonly T[],
): PropertyDecorator {
  // Composed by hand rather than through applyDecorators, which is declared
  // to return a broad decorator union that reads as `any` on a property and
  // so cannot be returned without either an assertion or a disabled rule.
  // Transform and IsIn are both plain PropertyDecorators, so calling them in
  // order is the same thing, fully typed, and one dependency lighter.
  const upperCase = Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  );
  const oneOf = IsIn(values);

  return (target, propertyKey) => {
    upperCase(target, propertyKey);
    oneOf(target, propertyKey);
  };
}
