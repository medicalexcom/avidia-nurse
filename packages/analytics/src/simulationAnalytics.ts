/**
 * Simulation analytics — M12 (spec Z/AA).
 *
 * Consumes the compact per-completed-session aggregates from the
 * `get_simulation_analytics` RPC (migration 0013): outcomes, critical-action
 * misses, unsafe-action counts, and clinical-judgment dimension scores that
 * M11's deterministic engine already computed. Trend language appears only
 * past MIN_SIMULATION_SESSIONS_FOR_TREND completed sessions (spec AA);
 * dimension claims require MIN_DIMENSION_POSSIBLE_POINTS of evidence.
 *
 * Known limitation (documented, spec Z): hint usage is a client-side
 * analytics event only and is not persisted server-side, so hint reliance
 * cannot be reported here.
 */

import { MIN_DIMENSION_POSSIBLE_POINTS, MIN_SIMULATION_SESSIONS_FOR_TREND } from './thresholds';
import type { SimulationRecord, Trend } from './types';

export interface SimulationDimensionSummary {
  dimension: string;
  label: string;
  earned: number;
  possible: number;
  /** Fraction earned, present only past the evidence gate (spec AJ). */
  share: number | null;
}

export interface SimulationAnalytics {
  completedCount: number;
  /** Outcome counts by kind — honest, includes negative endings. */
  outcomes: Record<'stabilized' | 'deteriorated' | 'complication' | 'timeout', number>;
  totalCriticalMissed: number;
  totalUnsafeActions: number;
  /** Aggregated dimension performance across completed sessions. */
  dimensions: SimulationDimensionSummary[];
  /** Weakest sufficient-evidence dimension, or null. */
  weakestDimension: SimulationDimensionSummary | null;
  /** Score trend across completed sessions in chronological order. */
  scoreTrend: Trend;
  /** Recent completed sessions, newest first (for the session list). */
  recent: SimulationRecord[];
}

/** Compare early-half vs late-half score shares across completed sessions. */
function scoreTrend(chronological: readonly SimulationRecord[]): Trend {
  if (chronological.length < MIN_SIMULATION_SESSIONS_FOR_TREND) return 'insufficient';
  const half = Math.floor(chronological.length / 2);
  const early = chronological.slice(0, half);
  const late = chronological.slice(chronological.length - half);
  const shareOf = (rows: readonly SimulationRecord[]): number | null => {
    const possible = rows.reduce((sum, r) => sum + r.possible, 0);
    if (possible === 0) return null;
    return rows.reduce((sum, r) => sum + r.earned, 0) / possible;
  };
  const earlyShare = shareOf(early);
  const lateShare = shareOf(late);
  if (earlyShare === null || lateShare === null) return 'insufficient';
  const delta = lateShare - earlyShare;
  if (delta >= 0.1) return 'improving';
  if (delta <= -0.1) return 'declining';
  return 'stable';
}

export function computeSimulationAnalytics(
  simulations: readonly SimulationRecord[]
): SimulationAnalytics {
  const chronological = [...simulations].sort(
    (a, b) =>
      Date.parse(a.completedAt) - Date.parse(b.completedAt) ||
      a.sessionId.localeCompare(b.sessionId)
  );
  const outcomes = { stabilized: 0, deteriorated: 0, complication: 0, timeout: 0 };
  let totalCriticalMissed = 0;
  let totalUnsafeActions = 0;
  const dimensionTotals = new Map<string, { label: string; earned: number; possible: number }>();
  for (const sim of chronological) {
    outcomes[sim.outcomeKind] += 1;
    totalCriticalMissed += sim.criticalMissedCount;
    totalUnsafeActions += sim.unsafeActionCount;
    for (const dim of sim.dimensions) {
      const entry = dimensionTotals.get(dim.dimension) ?? {
        label: dim.label,
        earned: 0,
        possible: 0,
      };
      entry.earned += dim.earned;
      entry.possible += dim.possible;
      dimensionTotals.set(dim.dimension, entry);
    }
  }
  const dimensions: SimulationDimensionSummary[] = [...dimensionTotals.entries()]
    .map(([dimension, entry]) => ({
      dimension,
      label: entry.label,
      earned: entry.earned,
      possible: entry.possible,
      share: entry.possible >= MIN_DIMENSION_POSSIBLE_POINTS ? entry.earned / entry.possible : null,
    }))
    .sort((a, b) => a.dimension.localeCompare(b.dimension));
  const sufficient = dimensions.filter((d) => d.share !== null);
  const weakestDimension =
    sufficient.length > 0
      ? sufficient.reduce((worst, d) => ((d.share as number) < (worst.share as number) ? d : worst))
      : null;
  return {
    completedCount: chronological.length,
    outcomes,
    totalCriticalMissed,
    totalUnsafeActions,
    dimensions,
    weakestDimension,
    scoreTrend: scoreTrend(chronological),
    recent: [...chronological].reverse(),
  };
}
