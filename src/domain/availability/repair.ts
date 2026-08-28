/**
 * What a repair ladder is allowed to choose from.
 *
 * Two ladders exist and they answer different questions. The SERIES ladder
 * (15.2.3) repairs one occurrence of a standing booking and yields the
 * professional to keep the hour. The DISRUPTION ladder (14.6) repairs every
 * booking a professional was going to take, and cannot keep the professional
 * at all because they are the reason the repair is happening.
 *
 * The POLICY differs; the raw material does not. Both are handed starts the
 * availability engine has already proved feasible and choose between them, so
 * the candidate lives here rather than in either ladder. Neither owns it.
 */
export interface RepairCandidate {
  readonly startMin: number;
  readonly staffId: string;
  readonly durationMin: number;
}
