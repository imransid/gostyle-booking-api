/**
 * Where a domain event goes once it leaves the outbox.
 *
 * A port, so the relay can be built and proven before Redis is involved.
 * Swapping the logging adapter for BullMQ changes one provider; the relay,
 * the transaction, and every domain file stay untouched.
 */
export interface DomainEvent {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly createdAt: Date;
  /** How many times delivery has already been attempted. */
  readonly attempts: number;
}

export interface EventPublisher {
  /**
   * Deliver one event. Throwing means "not delivered", and the relay will
   * retry it later, so this must be safe to call twice for the same event.
   *
   * At-least-once, not exactly-once. Exactly-once across a network is not a
   * thing you can buy; idempotent consumers are.
   */
  publish(event: DomainEvent): Promise<void>;
}

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');
