import type { SupabaseClient } from '@supabase/supabase-js';

import { fetchOwnProfile, sanitizeProfileUpdate, updateOwnProfile } from './profileApi';

/** Chainable fake of the supabase-js query builder that records the query. */
function makeFakeDb(result: unknown) {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, args: unknown[]) => {
    (calls[name] ??= []).push(args);
  };
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'update', 'eq', 'maybeSingle', 'single']) {
    builder[method] = jest.fn((...args: unknown[]) => {
      record(method, args);
      if (method === 'maybeSingle' || method === 'single') {
        return Promise.resolve({ data: result, error: null });
      }
      return builder;
    });
  }
  const client = {
    from: jest.fn((table: string) => {
      record('from', [table]);
      return builder;
    }),
  } as unknown as SupabaseClient;
  return { client, calls };
}

const profile = {
  id: 'user-1',
  email: 'student@example.com',
  role: 'student',
  timezone: null,
  program_type: null,
  created_at: '2026-08-12T00:00:00Z',
};

describe('profile ownership scoping', () => {
  it('fetchOwnProfile queries only the caller’s own row', async () => {
    const { client, calls } = makeFakeDb(profile);
    await fetchOwnProfile(client, 'user-1');
    expect(calls.from).toEqual([['profiles']]);
    expect(calls.eq).toEqual([['id', 'user-1']]);
  });

  it('updateOwnProfile scopes the update to the caller’s own row', async () => {
    const { client, calls } = makeFakeDb(profile);
    await updateOwnProfile(client, 'user-1', { timezone: 'America/New_York' });
    expect(calls.eq).toEqual([['id', 'user-1']]);
    expect(calls.update).toEqual([[{ timezone: 'America/New_York' }]]);
  });

  it('strips fields the student is not allowed to change', async () => {
    const { client, calls } = makeFakeDb(profile);
    await updateOwnProfile(client, 'user-1', {
      timezone: 'UTC',
      // attempts to escalate privileges or change identity:
      role: 'admin',
      email: 'attacker@example.com',
      id: 'someone-else',
    } as never);
    expect(calls.update).toEqual([[{ timezone: 'UTC' }]]);
  });
});

describe('sanitizeProfileUpdate', () => {
  it('keeps only timezone and program_type', () => {
    expect(
      sanitizeProfileUpdate({ timezone: 'UTC', program_type: 'absn', role: 'admin', email: 'x' })
    ).toEqual({ timezone: 'UTC', program_type: 'absn' });
  });

  it('preserves explicit nulls (clearing a field)', () => {
    expect(sanitizeProfileUpdate({ timezone: null })).toEqual({ timezone: null });
  });
});
