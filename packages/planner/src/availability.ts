/**
 * Availability configuration helpers — M13 (spec B/C).
 *
 * Simple by design: seven weekday numbers plus presets. Deliberately NOT a
 * calendar-management system.
 */

import { AVAILABILITY_PRESETS, MAX_DAILY_MINUTES, MIN_DAILY_MINUTES } from './config';
import type { AvailabilityConfig, AvailabilityPreset, WeekdayMinutes } from './types';

/** A uniform week at `minutes` per day. */
export function uniformWeek(minutes: number): WeekdayMinutes {
  const m = clampMinutes(minutes);
  return [m, m, m, m, m, m, m];
}

export function clampMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return 0;
  return Math.min(MAX_DAILY_MINUTES, Math.max(MIN_DAILY_MINUTES, Math.round(minutes)));
}

/** Build a config from a preset (spec C). Custom starts from standard. */
export function availabilityFromPreset(preset: AvailabilityPreset): AvailabilityConfig {
  if (preset === 'custom') {
    return { preset, minutesByWeekday: uniformWeek(AVAILABILITY_PRESETS.standard) };
  }
  return { preset, minutesByWeekday: uniformWeek(AVAILABILITY_PRESETS[preset]) };
}

/** Sanitize arbitrary stored numbers into a valid weekly config. */
export function normalizeWeek(minutes: readonly number[]): WeekdayMinutes {
  const out: number[] = [];
  for (let i = 0; i < 7; i += 1) out.push(clampMinutes(minutes[i] ?? 0));
  return out as unknown as WeekdayMinutes;
}

/** Minutes available on a JavaScript weekday (Sunday=0). */
export function minutesForWeekday(config: AvailabilityConfig, weekday: number): number {
  return config.minutesByWeekday[((weekday % 7) + 7) % 7] ?? 0;
}

/** True when every day is zero — the "prompt for setup" empty state. */
export function hasNoAvailability(config: AvailabilityConfig): boolean {
  return config.minutesByWeekday.every((m) => m === 0);
}
