/**
 * Seed migration generator (spec AB/AF/AX): renders the contents of
 * supabase/migrations/0012_simulation_seed.sql from BUILTIN_CASES.
 *
 * The migration file is generated, never hand-edited. A sync-pin test
 * (seedSql.test.ts) fails whenever the built-in library and the checked-in
 * migration drift apart; regenerate with UPDATE_SIM_SEED=1.
 *
 * Every case must pass the validation gate (spec AB) before it is allowed
 * into the seed — invalid cases throw here, at generation time, so a broken
 * definition can never reach the database as an ACTIVE case.
 */

import { BUILTIN_CASES } from './cases';
import type { SimulationCaseDefinition } from './types';
import { validateCase } from './validateCase';

/** Dollar-quote tag for the JSON payloads. */
const TAG = '$sim$';

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function caseInsert(caseDef: SimulationCaseDefinition): string {
  const gate = validateCase(caseDef);
  if (!gate.valid) {
    throw new Error(
      `Case "${caseDef.caseId}" failed the validation gate and cannot be seeded:\n` +
        gate.errors.map((e) => `  - ${e}`).join('\n')
    );
  }
  const json = JSON.stringify(caseDef);
  if (json.includes(TAG)) {
    throw new Error(`Case "${caseDef.caseId}" JSON contains the dollar-quote tag ${TAG}`);
  }
  return [
    'insert into public.simulation_cases',
    '  (case_key, case_version, engine_version, status, title, description, difficulty, scenario_type, estimated_duration_minutes, definition)',
    'values',
    `  (${sqlString(caseDef.caseId)}, ${caseDef.caseVersion}, ${caseDef.engineVersion}, 'active', ${sqlString(
      caseDef.title
    )}, ${sqlString(caseDef.description)}, ${sqlString(caseDef.difficulty)}, ${sqlString(
      caseDef.scenarioType
    )}, ${caseDef.estimatedDurationMinutes}, ${TAG}${json}${TAG}::jsonb)`,
    'on conflict (case_key) do update set',
    '  case_version = excluded.case_version,',
    '  engine_version = excluded.engine_version,',
    '  status = excluded.status,',
    '  title = excluded.title,',
    '  description = excluded.description,',
    '  difficulty = excluded.difficulty,',
    '  scenario_type = excluded.scenario_type,',
    '  estimated_duration_minutes = excluded.estimated_duration_minutes,',
    '  definition = excluded.definition,',
    '  updated_at = now();',
  ].join('\n');
}

/**
 * Builds the full text of migration 0012 from the built-in case library.
 * Deterministic: same library in, same SQL out (spec AZ).
 */
export function buildSeedSql(cases: SimulationCaseDefinition[] = BUILTIN_CASES): string {
  const header = [
    '-- 0012_simulation_seed.sql',
    '--',
    '-- GENERATED FILE — do not edit by hand.',
    '-- Source of truth: packages/simulation/src/cases (BUILTIN_CASES).',
    '-- Regenerate: UPDATE_SIM_SEED=1 pnpm --filter @avidia/simulation test -- seedSql',
    '--',
    '-- Seeds the built-in simulation case library (spec AE/AF). Idempotent:',
    '-- re-running upserts by case_key. Each case passed validateCase() at',
    '-- generation time (spec AB), so only gate-clean definitions ship.',
    '',
    'begin;',
    '',
  ].join('\n');
  const inserts = cases.map((caseDef) => caseInsert(caseDef)).join('\n\n');
  return `${header}${inserts}\n\ncommit;\n`;
}
