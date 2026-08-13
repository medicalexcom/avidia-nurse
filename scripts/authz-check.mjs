#!/usr/bin/env node
/**
 * Authorization / RLS verification for the M1 profile foundation.
 *
 * Runs against a REAL Supabase project (never in the client bundle). Requires:
 *   SUPABASE_URL                — project URL
 *   SUPABASE_ANON_KEY           — public anon key
 *   SUPABASE_SERVICE_ROLE_KEY   — secret; used only to create/delete the two
 *                                 throwaway test users. Server-side only.
 *
 * Usage:  node scripts/authz-check.mjs
 * Exits 0 with SKIPPED when the environment is not configured, so CI can run
 * it unconditionally and it activates once project secrets are provided.
 *
 * Checks (Playbook §8, M1 spec E):
 *   1. A user can read their own profile (auto-created by trigger on sign-up).
 *   2. A user CANNOT read another user's profile by changing the id.
 *   3. A user can update allowed fields (timezone, program_type) on their own row.
 *   4. A user CANNOT update privileged fields (role, email).
 *   5. A user CANNOT update another user's profile.
 *   6. A user CANNOT insert or delete profile rows.
 *   7. An unauthenticated (anon) client can read nothing.
 */
import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  console.log(
    'SKIPPED: authz-check requires SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY.'
  );
  process.exit(0);
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let failures = 0;
function check(name, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL';
  if (!ok) failures += 1;
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function userClient() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createTestUser(tag) {
  const email = `authz-${tag}-${Date.now()}@example.com`;
  const password = `Test-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(`could not create test user: ${error.message}`);
  const client = userClient();
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`could not sign in test user: ${signInError.message}`);
  return { id: data.user.id, email, client };
}

const cleanup = [];
try {
  const a = await createTestUser('a');
  const b = await createTestUser('b');
  cleanup.push(a.id, b.id);

  // 1. Own profile readable (trigger created it).
  const own = await a.client.from('profiles').select('*').eq('id', a.id).maybeSingle();
  check('user reads own profile', !own.error && own.data?.id === a.id, own.error?.message);

  // 2. Cross-user read must return nothing.
  const cross = await a.client.from('profiles').select('*').eq('id', b.id).maybeSingle();
  check(
    "user cannot read another user's profile",
    !cross.data,
    cross.data ? 'row was returned!' : ''
  );
  const all = await a.client.from('profiles').select('id');
  check(
    'unscoped select returns only own row',
    (all.data ?? []).every((r) => r.id === a.id)
  );

  // 3. Allowed-field update works.
  const upd = await a.client
    .from('profiles')
    .update({ timezone: 'America/New_York', program_type: 'absn' })
    .eq('id', a.id)
    .select()
    .single();
  check(
    'user updates allowed fields on own profile',
    !upd.error && upd.data?.timezone === 'America/New_York',
    upd.error?.message
  );

  // 4. Privileged-field update must fail (column-level grants).
  const priv = await a.client.from('profiles').update({ role: 'admin' }).eq('id', a.id);
  check('user cannot change role', Boolean(priv.error), priv.error ? '' : 'update succeeded!');
  const mail = await a.client
    .from('profiles')
    .update({ email: 'attacker@example.com' })
    .eq('id', a.id);
  check('user cannot change email', Boolean(mail.error), mail.error ? '' : 'update succeeded!');

  // 5. Cross-user update must affect zero rows.
  const crossUpd = await a.client
    .from('profiles')
    .update({ timezone: 'Hacked/Zone' })
    .eq('id', b.id)
    .select();
  const bRow = await admin.from('profiles').select('timezone').eq('id', b.id).single();
  check(
    "user cannot update another user's profile",
    (crossUpd.data ?? []).length === 0 && bRow.data?.timezone !== 'Hacked/Zone'
  );

  // 6. Insert/delete must fail.
  const ins = await a.client
    .from('profiles')
    .insert({ id: crypto.randomUUID(), email: 'x@example.com' });
  check('user cannot insert profiles', Boolean(ins.error));
  const del = await a.client.from('profiles').delete().eq('id', a.id).select();
  check('user cannot delete profiles', Boolean(del.error) || (del.data ?? []).length === 0);

  // 7. Unauthenticated client reads nothing.
  const anonRead = await userClient().from('profiles').select('id');
  check('anonymous client reads nothing', (anonRead.data ?? []).length === 0);
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  failures += 1;
} finally {
  for (const id of cleanup) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
}

console.log(
  failures === 0 ? '\nAll authorization checks passed.' : `\n${failures} check(s) FAILED.`
);
process.exit(failures === 0 ? 0 : 1);
