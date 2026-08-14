/**
 * @avidia/simulation — M11 stateful patient simulation engine.
 *
 * Pure, deterministic, versioned. The LLM is never the authoritative
 * simulation engine (spec core principle): patient state, action validity,
 * transitions, critical events, scoring, and outcomes all live here as
 * structured, testable code. The SQL interpreter in migration 0011 mirrors
 * these semantics (ADR-0020 double-maintenance contract); this package is
 * the executable specification that pins them.
 */

export * from './types';
export * from './engine';
export * from './redact';
export * from './score';
export * from './evidence';
export * from './replay';
export * from './validateCase';
export * from './cases';
