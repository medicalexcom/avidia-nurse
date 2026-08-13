#!/usr/bin/env node
/**
 * Authorization / RLS verification for profiles (M1) and courses/modules/
 * exams/exam_modules (M2).
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
 *
 * M2 checks (spec B):
 *   8.  Owner can create courses, modules, exams and exam-module links.
 *   9.  Cross-user reads of course data return nothing.
 *   10. Cross-user writes under someone else's course fail.
 *   11. user_id / course_id cannot be reassigned (column grants).
 *   12. exam_modules cannot reference another user's records or span courses.
 *   13. Course deletion cascades to its children but never the profile.
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

  // ---------------------------------------------------------------------
  // M2: courses, modules, exams, exam_modules (spec B).
  // ---------------------------------------------------------------------

  // 8. Owner CRUD on courses works.
  const courseIns = await a.client
    .from('courses')
    .insert({ user_id: a.id, title: 'Pharmacology', term: 'Fall 2026' })
    .select()
    .single();
  check('user creates own course', !courseIns.error, courseIns.error?.message);
  const courseId = courseIns.data?.id;

  const modIns = await a.client
    .from('modules')
    .insert({ course_id: courseId, title: 'Cardiac', sequence: 0 })
    .select()
    .single();
  check('user creates module in own course', !modIns.error, modIns.error?.message);
  const moduleId = modIns.data?.id;

  const examIns = await a.client
    .from('exams')
    .insert({ course_id: courseId, title: 'Exam 1', exam_at: '2026-09-04T14:00:00Z', weight: 25 })
    .select()
    .single();
  check('user creates exam in own course', !examIns.error, examIns.error?.message);
  const examId = examIns.data?.id;

  const linkIns = await a.client
    .from('exam_modules')
    .insert({ exam_id: examId, module_id: moduleId });
  check('user links own exam to own module (same course)', !linkIns.error, linkIns.error?.message);

  // 9. Cross-user reads of course data return nothing.
  const bCourse = await b.client.from('courses').select('*').eq('id', courseId).maybeSingle();
  check("user cannot read another user's course by id", !bCourse.data);
  const bModules = await b.client.from('modules').select('*').eq('course_id', courseId);
  check("user cannot read another user's modules", (bModules.data ?? []).length === 0);
  const bExams = await b.client.from('exams').select('*').eq('course_id', courseId);
  check("user cannot read another user's exams", (bExams.data ?? []).length === 0);

  // 10. Cross-user writes under someone else's course must fail.
  const bModIns = await b.client
    .from('modules')
    .insert({ course_id: courseId, title: 'Intrusion', sequence: 0 });
  check("user cannot create a module under another user's course", Boolean(bModIns.error));
  const bExamIns = await b.client
    .from('exams')
    .insert({ course_id: courseId, title: 'Intrusion', exam_at: '2026-09-04T14:00:00Z' });
  check("user cannot create an exam under another user's course", Boolean(bExamIns.error));
  const bCourseUpd = await b.client
    .from('courses')
    .update({ title: 'Hacked' })
    .eq('id', courseId)
    .select();
  check("user cannot update another user's course", (bCourseUpd.data ?? []).length === 0);
  const bCourseDel = await b.client.from('courses').delete().eq('id', courseId).select();
  check("user cannot delete another user's course", (bCourseDel.data ?? []).length === 0);

  // 11. Reparenting is impossible (column grants): user_id / course_id are
  // not updatable even by the owner.
  const reparentCourse = await a.client
    .from('courses')
    .update({ user_id: b.id })
    .eq('id', courseId);
  check('owner cannot reassign course user_id', Boolean(reparentCourse.error));
  const reparentModule = await a.client
    .from('modules')
    .update({ course_id: crypto.randomUUID() })
    .eq('id', moduleId);
  check('owner cannot reassign module course_id', Boolean(reparentModule.error));

  // 12. Join table cannot reference foreign records: B cannot link B's own
  // exam to A's module (cross-user), and A cannot link across A's own courses.
  const bOwnCourse = await b.client
    .from('courses')
    .insert({ user_id: b.id, title: 'B Course' })
    .select()
    .single();
  const bOwnExam = await b.client
    .from('exams')
    .insert({ course_id: bOwnCourse.data?.id, title: 'B Exam', exam_at: '2026-09-04T14:00:00Z' })
    .select()
    .single();
  const bLink = await b.client
    .from('exam_modules')
    .insert({ exam_id: bOwnExam.data?.id, module_id: moduleId });
  check("user cannot link own exam to another user's module", Boolean(bLink.error));

  const aCourse2 = await a.client
    .from('courses')
    .insert({ user_id: a.id, title: 'A Course 2' })
    .select()
    .single();
  const aMod2 = await a.client
    .from('modules')
    .insert({ course_id: aCourse2.data?.id, title: 'Other course module', sequence: 0 })
    .select()
    .single();
  const crossCourseLink = await a.client
    .from('exam_modules')
    .insert({ exam_id: examId, module_id: aMod2.data?.id });
  check(
    'exam cannot be linked to a module from a different course',
    Boolean(crossCourseLink.error)
  );

  // 13. Deleting a course cascades to its modules/exams/links but never
  // touches the profile.
  const aDel = await a.client.from('courses').delete().eq('id', courseId).select();
  check('owner deletes own course', (aDel.data ?? []).length === 1);
  const orphanModules = await admin.from('modules').select('id').eq('course_id', courseId);
  const orphanExams = await admin.from('exams').select('id').eq('course_id', courseId);
  const orphanLinks = await admin.from('exam_modules').select('exam_id').eq('exam_id', examId);
  check(
    'course delete cascades to modules, exams and exam_modules',
    (orphanModules.data ?? []).length === 0 &&
      (orphanExams.data ?? []).length === 0 &&
      (orphanLinks.data ?? []).length === 0
  );
  const profileStill = await admin.from('profiles').select('id').eq('id', a.id).maybeSingle();
  check('profile survives course deletion', Boolean(profileStill.data));
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
