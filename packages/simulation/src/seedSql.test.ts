/**
 * Seed sync-pin test (spec AB/AX): the checked-in 0012 migration must be
 * byte-identical to what buildSeedSql() produces from BUILTIN_CASES.
 *
 * If the library changes, this test fails; regenerate the migration with:
 *   UPDATE_SIM_SEED=1 pnpm --filter @avidia/simulation test -- seedSql
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { BUILTIN_CASES } from './cases';
import { buildSeedSql } from './seedSql';

const MIGRATION_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'supabase',
  'migrations',
  '0012_simulation_seed.sql'
);

describe('buildSeedSql', () => {
  it('is deterministic', () => {
    expect(buildSeedSql()).toBe(buildSeedSql());
  });

  it('contains one upsert per built-in case', () => {
    const sql = buildSeedSql();
    for (const caseDef of BUILTIN_CASES) {
      expect(sql).toContain(`('${caseDef.caseId}', ${caseDef.caseVersion}, `);
    }
    expect(sql.match(/insert into public\.simulation_cases/g)).toHaveLength(BUILTIN_CASES.length);
  });

  it('refuses to seed an invalid case (spec AB)', () => {
    const broken = JSON.parse(JSON.stringify(BUILTIN_CASES[0]));
    broken.engineVersion = 99;
    expect(() => buildSeedSql([broken])).toThrow('failed the validation gate');
  });

  it('matches the checked-in migration file exactly (sync pin)', () => {
    const expected = buildSeedSql();
    if (process.env.UPDATE_SIM_SEED === '1') {
      writeFileSync(MIGRATION_PATH, expected);
    }
    const actual = readFileSync(MIGRATION_PATH, 'utf8');
    expect(actual).toBe(expected);
  });
});
