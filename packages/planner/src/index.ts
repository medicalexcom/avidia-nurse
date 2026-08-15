/**
 * @avidia/planner — M13 intelligent study planner.
 *
 * Pure, deterministic scheduling over the outputs of the authoritative
 * engines (M8 mastery/priority, M12 analytics). See package.json for the
 * scope contract. Fixtures are exported for tests but never imported by
 * the app bundle.
 */

export * from './types';
export * from './config';
export * from './availability';
export * from './dates';
export * from './demand';
export * from './generate';
export * from './reminders';
export * from './match';
