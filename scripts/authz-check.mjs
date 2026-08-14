#!/usr/bin/env node
/**
 * Authorization / RLS verification for profiles (M1), courses/modules/
 * exams/exam_modules (M2), documents + course-materials storage (M3), and
 * document processing + document_sections (M4).
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
 *
 * M3 checks (spec K):
 *   14. Owner can create a document row, store its object and sign a URL.
 *   15. documents.storage_key cannot point at a foreign storage path (CHECK).
 *   16. Cross-user document reads/inserts/updates/deletes fail; uploaded_by
 *       cannot be spoofed.
 *   17. Storage policies block cross-user upload/replace/download/list/sign/
 *       delete and anonymous access, even with the exact object path.
 *   18. Course deletion cascades to modules, exams, links AND documents, but
 *       never the profile.
 *
 * M4 checks (spec T security / U):
 *   19. Owner can enqueue their own document (uploaded -> queued); the
 *       trigger blocks clients from entering 'processing' or 'ready'.
 *   20. Only the service role can call replace_document_sections; clients
 *       cannot insert/update/delete document_sections directly.
 *   21. Owner reads own sections; cross-user section reads return nothing.
 *   22. Deleting the course cascades to document_sections (derived content
 *       never outlives its document).
 *
 * M5 checks (spec T/U/W): source_chunks + retrieval scoping.
 *   23. Only the service role can call replace_source_chunks; clients cannot
 *       write source_chunks directly.
 *   24. Owner reads own chunk text/provenance, but the raw embedding vector
 *       is NOT selectable by any client (column-level grant).
 *   25. User B and anonymous clients read no chunks even with exact ids.
 *   26. search_course_chunks works for the owner, raises for another user's
 *       course, and is denied to anonymous callers.
 *   27. Deleting the course cascades to source_chunks (no orphan vectors).
 *
 * M6 checks (spec R/X): concepts + knowledge model.
 *   28. Only the service role can call apply_concept_extraction and
 *       recompute_concept_emphasis; both are denied to clients and anon.
 *   29. Owner reads own concepts, aliases, provenance links and
 *       relationships; the evidence trail is visible (spec Q).
 *   30. User B and anonymous clients read NOTHING from any concept table,
 *       even with the exact guessed ids (spec R).
 *   31. Clients cannot insert/update/delete concepts, concept_aliases,
 *       concept_sources or concept_relationships directly — the knowledge
 *       model is written only by the pipeline.
 *   32. Deleting a document removes its provenance links and prunes AI
 *       concepts left with no supporting source (spec M/O).
 *   33. Deleting the course cascades to all four concept tables — no
 *       knowledge outlives the course it came from (spec A).
 *
 * M7 checks (spec AB/K/S/V/W/AH): questions + assessment engine.
 *   34. Only the service role can call apply_question_generation; questions,
 *       question_options and question_sources reject ALL direct client writes.
 *   35. Owner reads own ACTIVE questions and options, but the answer-revealing
 *       columns (rationale, expected_value/tolerance, is_correct,
 *       correct_position, option rationale) are NOT selectable by any client.
 *   36. Flagged questions are invisible to students (lifecycle spec S); user B
 *       and anonymous clients read nothing even with exact guessed ids.
 *   37. Sessions are owner-scoped: B cannot create a session under A's course,
 *       read A's sessions, or update them; course_id is not reassignable.
 *   38. question_attempts have NO direct write path — the only way to score is
 *       submit_question_attempt, which verifies ownership, scores server-side
 *       (choice + numeric tolerance), and reveals rationales only afterwards.
 *   39. Answers are immutable (spec W): re-answering the same question in the
 *       same session is a hard error; recorded attempts reject update/delete.
 *   40. Feedback is stored but never auto-applied (spec AH); B cannot flag A's
 *       question; deleting a document retires evidence-less course-grounded
 *       questions; course deletion cascades to ALL M7 tables.
 *
 * M8 checks (spec AC/AD/AE/Z/AA): mastery engine.
 *   41. Scoring a concept-linked attempt transactionally creates/updates the
 *       concept_mastery aggregate with the exact versioned v1 arithmetic, and
 *       writes exactly one auditable mastery_event per attempt; the refused
 *       double-submit never double-updates mastery (idempotency, spec AC).
 *   42. Owners read their OWN mastery rows and event history; user B and
 *       anonymous clients read NOTHING even with exact guessed ids (spec AD).
 *   43. There is NO client write path: concept_mastery and mastery_events
 *       reject all direct inserts/updates/deletes — the submit RPC is the
 *       sole writer (spec AD/Z).
 *   44. The M8 'adaptive' session type is accepted for owners, unknown types
 *       are rejected, and B cannot start adaptive sessions under A's course;
 *       course deletion cascades to concept_mastery and mastery_events.
 *
 * M9 checks (spec B/O/AB/AF): daily sessions and stored plans.
 *   45. requested_duration_minutes is stored for the owner; the 1–120 check
 *       constraint rejects nonsense durations.
 *   46. The stored session plan is owner-scoped end to end: the owner inserts
 *       and reads it in order; user B and anonymous clients read nothing by
 *       guessed id and B cannot forge rows into A's session.
 *   47. skipped_at is the ONLY client-updatable plan column (spec AB): the
 *       owner can mark a skip, plan order cannot be rewritten, and B cannot
 *       skip rows in A's plan.
 *   48. Closed sessions accept no new plan rows, and deleting a session
 *       cascades to its plan — no orphaned plan state survives.
 * M10 checks (spec AK/AL): study modes.
 *   49. The five mode session_type values are accepted for the owner's own
 *       course, and an invented session_type is rejected by the check
 *       constraint — session history cannot be mislabeled.
 *
 * M11 checks (spec N/V/W/X/Y/AW/BC): patient simulation.
 *   50. Seeded cases are readable metadata-only; the authoritative
 *       `definition` column is not selectable and anon sees no cases.
 *   51. start_simulation creates a session for the owner and RESUMES the
 *       existing active session on a repeat call; the client view leaks no
 *       hidden findings or server internals.
 *   52. User B can neither start on A's course, read A's session, act on it,
 *       nor fetch its view; anonymous clients cannot call the RPCs.
 *   53. Server-only columns (sessions.state/score, actions.events/result)
 *       are not selectable by any client.
 *   54. No direct write path: even the owner cannot insert/update sessions
 *       or forge action-history rows — the RPCs are the only door.
 *   55. simulation_act appends exactly one audited row per submission; a
 *       replayed idempotency key returns the stored result without
 *       re-running, and rejected actions are audited but change nothing.
 *   56. The debrief is refused while the session is still active.
 *   57. Course deletion cascades to simulation sessions and their action
 *       history — no orphaned clinical state.
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

  // -------------------------------------------------------------------------
  // M3 checks (spec K): documents + private course-materials storage.
  // -------------------------------------------------------------------------

  // 14. Owner can create a document row, store the object, and finish it.
  const docIns = await a.client
    .from('documents')
    .insert({
      course_id: courseId,
      uploaded_by: a.id,
      filename: 'authz-test.txt',
      original_filename: 'authz-test.txt',
      mime_type: 'text/plain',
      file_extension: 'txt',
      file_size: 20,
      document_type: 'notes',
      content_hash: null,
    })
    .select()
    .single();
  check('owner creates document row in own course', !docIns.error, docIns.error?.message);
  const docId = docIns.data?.id;
  const objectKey = `${a.id}/${courseId}/${docId}/authz-test.txt`;
  const objectBody = new Blob(['authz storage check'], { type: 'text/plain' });
  const objUp = await a.client.storage.from('course-materials').upload(objectKey, objectBody, {
    contentType: 'text/plain',
    upsert: false,
  });
  check('owner uploads object to own storage folder', !objUp.error, objUp.error?.message);
  const docDone = await a.client
    .from('documents')
    .update({ storage_key: objectKey, processing_status: 'uploaded' })
    .eq('id', docId)
    .select()
    .single();
  check(
    'owner marks document uploaded with storage key',
    !docDone.error && docDone.data?.processing_status === 'uploaded',
    docDone.error?.message
  );
  const signed = await a.client.storage.from('course-materials').createSignedUrl(objectKey, 60);
  check('owner can create a short-lived signed URL', !signed.error, signed.error?.message);

  // 15. The storage_key CHECK ties rows to the owner's folder: a key outside
  // {uploaded_by}/{course_id}/{id}/ must be rejected by the database.
  const badKey = await a.client
    .from('documents')
    .update({ storage_key: `${b.id}/${courseId}/${docId}/authz-test.txt` })
    .eq('id', docId);
  check('document cannot point at a foreign storage path', Boolean(badKey.error));

  // 16. Cross-user document access is impossible at the database level.
  const bDocs = await b.client.from('documents').select('*').eq('course_id', courseId);
  check("user cannot read another user's documents", (bDocs.data ?? []).length === 0);
  const bDocIns = await b.client.from('documents').insert({
    course_id: courseId,
    uploaded_by: b.id,
    filename: 'intruder.txt',
    original_filename: 'intruder.txt',
    mime_type: 'text/plain',
    file_extension: 'txt',
    file_size: 10,
    document_type: 'other',
    content_hash: null,
  });
  check("user cannot upload a document into another user's course", Boolean(bDocIns.error));
  const spoofUploader = await a.client.from('documents').insert({
    course_id: courseId,
    uploaded_by: b.id,
    filename: 'spoof.txt',
    original_filename: 'spoof.txt',
    mime_type: 'text/plain',
    file_extension: 'txt',
    file_size: 10,
    document_type: 'other',
    content_hash: null,
  });
  check('uploaded_by cannot be attributed to another user', Boolean(spoofUploader.error));
  const bDocUpd = await b.client
    .from('documents')
    .update({ document_type: 'lecture' })
    .eq('id', docId)
    .select();
  check("user cannot update another user's document", (bDocUpd.data ?? []).length === 0);
  const bDocDel = await b.client.from('documents').delete().eq('id', docId).select();
  check("user cannot delete another user's document", (bDocDel.data ?? []).length === 0);

  // 17. Storage-policy isolation: knowing the exact object path gives B and
  // anonymous clients nothing — policies, not path obscurity, control access.
  const bObjUp = await b.client.storage
    .from('course-materials')
    .upload(
      `${a.id}/${courseId}/${docId}/injected.txt`,
      new Blob(['intrusion'], { type: 'text/plain' }),
      { contentType: 'text/plain', upsert: false }
    );
  check("user cannot upload into another user's storage folder", Boolean(bObjUp.error));
  const bObjReplace = await b.client.storage
    .from('course-materials')
    .upload(objectKey, new Blob(['replaced'], { type: 'text/plain' }), {
      contentType: 'text/plain',
      upsert: true,
    });
  check("user cannot replace another user's object", Boolean(bObjReplace.error));
  const bObjDown = await b.client.storage.from('course-materials').download(objectKey);
  check("user cannot download another user's object by guessed path", Boolean(bObjDown.error));
  const bObjList = await b.client.storage
    .from('course-materials')
    .list(`${a.id}/${courseId}/${docId}`);
  check("user cannot list another user's storage objects", (bObjList.data ?? []).length === 0);
  const bSigned = await b.client.storage.from('course-materials').createSignedUrl(objectKey, 60);
  check("user cannot sign another user's object", Boolean(bSigned.error));
  const bObjDel = await b.client.storage.from('course-materials').remove([objectKey]);
  check(
    "user cannot delete another user's object",
    Boolean(bObjDel.error) || (bObjDel.data ?? []).length === 0
  );
  const anonDown = await userClient().storage.from('course-materials').download(objectKey);
  check('anonymous client cannot download a material', Boolean(anonDown.error));
  const stillThere = await admin.storage.from('course-materials').download(objectKey);
  check('object survived the attack attempts (admin check)', !stillThere.error);

  // -------------------------------------------------------------------------
  // M4 checks (spec T/U): processing state machine + document_sections.
  // -------------------------------------------------------------------------

  // 19. Owner may request processing (uploaded -> queued), but the trigger
  // reserves 'processing' and 'ready' for the service-role worker.
  const enqueue = await a.client
    .from('documents')
    .update({ processing_status: 'queued' })
    .eq('id', docId)
    .select()
    .single();
  check(
    'owner can enqueue own document (uploaded -> queued)',
    !enqueue.error && enqueue.data?.processing_status === 'queued',
    enqueue.error?.message
  );
  const fakeReady = await a.client
    .from('documents')
    .update({ processing_status: 'ready' })
    .eq('id', docId);
  check('client cannot mark a document ready', Boolean(fakeReady.error));
  const fakeProcessing = await a.client
    .from('documents')
    .update({ processing_status: 'processing' })
    .eq('id', docId);
  check("client cannot claim 'processing' status", Boolean(fakeProcessing.error));

  // 20. Sections are written ONLY through the service-role RPC.
  const seeded = await admin.rpc('replace_document_sections', {
    p_document_id: docId,
    p_sections: [
      {
        section_type: 'paragraph',
        sequence: 0,
        page_number: null,
        slide_number: null,
        heading: null,
        content: 'Authz section content.',
        metadata: null,
      },
    ],
  });
  check(
    'service role replaces sections via RPC',
    !seeded.error && seeded.data === 1,
    seeded.error?.message
  );
  const clientRpc = await a.client.rpc('replace_document_sections', {
    p_document_id: docId,
    p_sections: [],
  });
  check('authenticated client cannot call replace_document_sections', Boolean(clientRpc.error));
  const sectionIns = await a.client.from('document_sections').insert({
    document_id: docId,
    section_type: 'paragraph',
    sequence: 1,
    content: 'forged section',
  });
  check('client cannot insert document_sections directly', Boolean(sectionIns.error));
  const sectionUpd = await a.client
    .from('document_sections')
    .update({ content: 'tampered' })
    .eq('document_id', docId)
    .select();
  check(
    'client cannot update document_sections',
    Boolean(sectionUpd.error) || (sectionUpd.data ?? []).length === 0
  );
  const sectionDel = await a.client
    .from('document_sections')
    .delete()
    .eq('document_id', docId)
    .select();
  check(
    'client cannot delete document_sections',
    Boolean(sectionDel.error) || (sectionDel.data ?? []).length === 0
  );

  // 21. Owner reads own sections; cross-user reads return nothing.
  const ownSections = await a.client.from('document_sections').select('*').eq('document_id', docId);
  check(
    'owner reads own document sections',
    (ownSections.data ?? []).length === 1 &&
      ownSections.data?.[0]?.content === 'Authz section content.',
    ownSections.error?.message
  );
  const bSections = await b.client.from('document_sections').select('*').eq('document_id', docId);
  check("user cannot read another user's sections", (bSections.data ?? []).length === 0);
  const anonSections = await userClient()
    .from('document_sections')
    .select('*')
    .eq('document_id', docId);
  check('anonymous client reads no sections', (anonSections.data ?? []).length === 0);

  // -------------------------------------------------------------------------
  // M5 checks (spec T/U/W): source_chunks + course-scoped retrieval.
  // -------------------------------------------------------------------------

  const unitVector = `[${Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)).join(',')}]`;

  // 23. Chunks are written ONLY through the service-role RPC.
  const chunkSeed = await admin.rpc('replace_source_chunks', {
    p_document_id: docId,
    p_chunks: [
      {
        ordinal: 0,
        content: 'Authz chunk: furosemide is a loop diuretic.',
        token_estimate: 12,
        source_locator: { type: 'txt', sectionIndex: 0 },
        section_start: 0,
        section_end: 0,
        embedding: unitVector,
        embedding_provider: 'authz',
        embedding_model: 'authz-test',
        embedding_version: 'v1',
      },
    ],
  });
  check(
    'service role replaces chunks via RPC',
    !chunkSeed.error && chunkSeed.data === 1,
    chunkSeed.error?.message
  );
  const clientChunkRpc = await a.client.rpc('replace_source_chunks', {
    p_document_id: docId,
    p_chunks: [],
  });
  check('authenticated client cannot call replace_source_chunks', Boolean(clientChunkRpc.error));
  const chunkIns = await a.client.from('source_chunks').insert({
    document_id: docId,
    course_id: courseId,
    ordinal: 1,
    content: 'forged chunk',
    token_estimate: 2,
    source_locator: {},
    section_start: 0,
    section_end: 0,
    embedding: unitVector,
    embedding_provider: 'x',
    embedding_model: 'x',
    embedding_version: 'x',
  });
  check('client cannot insert source_chunks directly', Boolean(chunkIns.error));
  const chunkUpd = await a.client
    .from('source_chunks')
    .update({ content: 'tampered' })
    .eq('document_id', docId)
    .select('id');
  check(
    'client cannot update source_chunks',
    Boolean(chunkUpd.error) || (chunkUpd.data ?? []).length === 0
  );
  const chunkDel = await a.client
    .from('source_chunks')
    .delete()
    .eq('document_id', docId)
    .select('id');
  check(
    'client cannot delete source_chunks',
    Boolean(chunkDel.error) || (chunkDel.data ?? []).length === 0
  );

  // 24. Owner reads text + provenance, but never the raw vector (spec U).
  const ownChunks = await a.client
    .from('source_chunks')
    .select('id, content, source_locator, ordinal')
    .eq('document_id', docId);
  check(
    'owner reads own chunk text and provenance',
    (ownChunks.data ?? []).length === 1 &&
      ownChunks.data?.[0]?.content === 'Authz chunk: furosemide is a loop diuretic.',
    ownChunks.error?.message
  );
  const chunkId = ownChunks.data?.[0]?.id;
  const vectorRead = await a.client.from('source_chunks').select('embedding').eq('id', chunkId);
  check('raw embedding vector is not selectable by clients', Boolean(vectorRead.error));

  // 25. Cross-user and anonymous chunk reads return nothing, even by id.
  const bChunks = await b.client.from('source_chunks').select('id, content').eq('id', chunkId);
  check("user cannot read another user's chunks by guessed id", (bChunks.data ?? []).length === 0);
  const anonChunks = await userClient()
    .from('source_chunks')
    .select('id, content')
    .eq('id', chunkId);
  check('anonymous client reads no chunks', (anonChunks.data ?? []).length === 0);

  // 26. Retrieval is course-scoped inside the database function (spec K/T).
  const ownSearch = await a.client.rpc('search_course_chunks', {
    p_course_id: courseId,
    p_query: 'furosemide',
    p_query_embedding: unitVector,
    p_top_k: 5,
    p_min_similarity: 0,
    p_document_id: null,
  });
  check(
    'owner retrieves own course chunks via search RPC',
    !ownSearch.error && (ownSearch.data ?? []).length === 1,
    ownSearch.error?.message
  );
  const bSearch = await b.client.rpc('search_course_chunks', {
    p_course_id: courseId,
    p_query: 'furosemide',
    p_query_embedding: unitVector,
    p_top_k: 5,
    p_min_similarity: 0,
    p_document_id: null,
  });
  check("search RPC raises for another user's course", Boolean(bSearch.error));
  const anonSearch = await userClient().rpc('search_course_chunks', {
    p_course_id: courseId,
    p_query: 'furosemide',
    p_query_embedding: unitVector,
    p_top_k: 5,
    p_min_similarity: 0,
    p_document_id: null,
  });
  check('search RPC is denied to anonymous callers', Boolean(anonSearch.error));

  // -------------------------------------------------------------------------
  // M6 checks (spec R/X): concepts + knowledge model.
  // -------------------------------------------------------------------------

  // 28. Concept writes happen ONLY through the service-role RPCs.
  const conceptSeed = await admin.rpc('apply_concept_extraction', {
    p_document_id: docId,
    p_payload: {
      extraction: {
        provider: 'authz',
        model: 'authz-test',
        prompt_version: 'p1',
        extraction_version: 'v1',
      },
      concepts: [
        {
          key: 'furosemide',
          name: 'Furosemide',
          type: 'medication',
          summary: 'Loop diuretic used in the authz fixture.',
          aliases: [{ alias: 'Lasix', key: 'lasix' }],
          chunk_ids: [chunkId],
        },
        {
          key: 'hypokalemia',
          name: 'Hypokalemia',
          type: 'laboratory',
          summary: 'Low serum potassium.',
          aliases: [],
          chunk_ids: [chunkId],
        },
      ],
      relationships: [
        {
          source_key: 'furosemide',
          target_key: 'hypokalemia',
          type: 'may_cause',
          chunk_id: chunkId,
        },
      ],
    },
  });
  check(
    'service role applies concept extraction via RPC',
    !conceptSeed.error &&
      conceptSeed.data?.new_concepts === 2 &&
      conceptSeed.data?.links === 2 &&
      conceptSeed.data?.relationships === 1,
    conceptSeed.error?.message ?? JSON.stringify(conceptSeed.data)
  );
  const emphasisSeed = await admin.rpc('recompute_concept_emphasis', {
    p_course_id: courseId,
  });
  check(
    'service role recomputes concept emphasis via RPC',
    !emphasisSeed.error,
    emphasisSeed.error?.message
  );
  const clientApplyRpc = await a.client.rpc('apply_concept_extraction', {
    p_document_id: docId,
    p_payload: { extraction: {}, concepts: [], relationships: [] },
  });
  check('authenticated client cannot call apply_concept_extraction', Boolean(clientApplyRpc.error));
  const anonApplyRpc = await userClient().rpc('apply_concept_extraction', {
    p_document_id: docId,
    p_payload: { extraction: {}, concepts: [], relationships: [] },
  });
  check('anonymous client cannot call apply_concept_extraction', Boolean(anonApplyRpc.error));
  const clientEmphasisRpc = await a.client.rpc('recompute_concept_emphasis', {
    p_course_id: courseId,
  });
  check(
    'authenticated client cannot call recompute_concept_emphasis',
    Boolean(clientEmphasisRpc.error)
  );

  // 29. Owner sees the concepts WITH their evidence trail (spec Q).
  const ownConcepts = await a.client
    .from('concepts')
    .select('id, canonical_name, concept_type, emphasis_score')
    .eq('course_id', courseId)
    .order('canonical_name');
  check(
    'owner reads own course concepts',
    (ownConcepts.data ?? []).length === 2 &&
      ownConcepts.data?.[0]?.canonical_name === 'Furosemide' &&
      ownConcepts.data?.[1]?.canonical_name === 'Hypokalemia',
    ownConcepts.error?.message
  );
  const furosemideId = ownConcepts.data?.[0]?.id;
  const hypokalemiaId = ownConcepts.data?.[1]?.id;
  const ownAliases = await a.client
    .from('concept_aliases')
    .select('alias')
    .eq('concept_id', furosemideId);
  check(
    'owner reads own concept aliases (Lasix)',
    (ownAliases.data ?? []).length === 1 && ownAliases.data?.[0]?.alias === 'Lasix',
    ownAliases.error?.message
  );
  const ownLinks = await a.client
    .from('concept_sources')
    .select('concept_id, chunk_id')
    .eq('document_id', docId);
  check('owner reads own concept provenance links', (ownLinks.data ?? []).length === 2);
  const ownRels = await a.client
    .from('concept_relationships')
    .select('relationship_type, source_concept_id, target_concept_id')
    .eq('course_id', courseId);
  check(
    'owner reads own concept relationships with provenance',
    (ownRels.data ?? []).length === 1 &&
      ownRels.data?.[0]?.relationship_type === 'may_cause' &&
      ownRels.data?.[0]?.source_concept_id === furosemideId &&
      ownRels.data?.[0]?.target_concept_id === hypokalemiaId,
    ownRels.error?.message
  );
  // 30. Cross-user and anonymous reads return nothing, even by exact id
  // (spec R — a guessed id is indistinguishable from a nonexistent one).
  const bConcept = await b.client.from('concepts').select('id').eq('id', furosemideId);
  check(
    "user cannot read another user's concepts by guessed id",
    (bConcept.data ?? []).length === 0
  );
  const bAlias = await b.client.from('concept_aliases').select('id').eq('concept_id', furosemideId);
  check("user cannot read another user's concept aliases", (bAlias.data ?? []).length === 0);
  const bLinks = await b.client.from('concept_sources').select('id').eq('document_id', docId);
  check("user cannot read another user's concept sources", (bLinks.data ?? []).length === 0);
  const bRels = await b.client.from('concept_relationships').select('id').eq('course_id', courseId);
  check("user cannot read another user's concept relationships", (bRels.data ?? []).length === 0);
  const anonConcept = await userClient().from('concepts').select('id').eq('id', furosemideId);
  check('anonymous client reads no concepts', (anonConcept.data ?? []).length === 0);

  // 31. Concept tables reject direct client writes — even from the owner.
  const conceptIns = await a.client.from('concepts').insert({
    course_id: courseId,
    canonical_name: 'Forged Concept',
    normalized_key: 'forged concept',
    concept_type: 'other',
    extraction_version: 'v1',
  });
  check('client cannot insert concepts directly', Boolean(conceptIns.error));
  const conceptUpd = await a.client
    .from('concepts')
    .update({ canonical_name: 'Tampered' })
    .eq('id', furosemideId)
    .select('id');
  check(
    'client cannot update concepts',
    Boolean(conceptUpd.error) || (conceptUpd.data ?? []).length === 0
  );
  const conceptDel = await a.client.from('concepts').delete().eq('id', furosemideId).select('id');
  check(
    'client cannot delete concepts',
    Boolean(conceptDel.error) || (conceptDel.data ?? []).length === 0
  );
  const aliasIns = await a.client.from('concept_aliases').insert({
    concept_id: furosemideId,
    course_id: courseId,
    alias: 'Forged Alias',
    normalized_alias: 'forged alias',
  });
  check('client cannot insert concept_aliases directly', Boolean(aliasIns.error));
  const conceptLinkIns = await a.client.from('concept_sources').insert({
    concept_id: furosemideId,
    chunk_id: chunkId,
    course_id: courseId,
    document_id: docId,
    extraction_version: 'v1',
  });
  check('client cannot insert concept_sources directly', Boolean(conceptLinkIns.error));
  const relIns = await a.client.from('concept_relationships').insert({
    course_id: courseId,
    source_concept_id: furosemideId,
    target_concept_id: hypokalemiaId,
    relationship_type: 'treats',
    chunk_id: chunkId,
  });
  check('client cannot insert concept_relationships directly', Boolean(relIns.error));

  // -------------------------------------------------------------------------
  // M7 checks (spec AB/K/S/V/W/AH): questions + assessment engine.
  // -------------------------------------------------------------------------

  const sbaHash = 'a'.repeat(64);
  const numericHash = 'b'.repeat(64);
  const flaggedHash = 'c'.repeat(64);

  // 34. Generation writes flow ONLY through the service-role RPC.
  const questionSeed = await admin.rpc('apply_question_generation', {
    p_document_id: docId,
    p_payload: {
      generation: {
        provider: 'authz',
        model: 'authz-test',
        prompt_version: 'p1',
        generation_version: 'v1',
      },
      questions: [
        {
          content_hash: sbaHash,
          concept_key: 'furosemide',
          question_type: 'single_best_answer',
          stem: 'A client taking furosemide reports muscle weakness. Which finding should the nurse assess first?',
          difficulty: 'moderate',
          cognitive_level: 'application',
          source_type: 'course_grounded',
          priority_frameworks: ['safety'],
          rationale:
            'Furosemide causes potassium loss; muscle weakness suggests hypokalemia, so serum potassium is the priority.',
          status: 'active',
          safety_flags: [],
          options: [
            {
              ordinal: 1,
              text: 'Serum potassium level',
              is_correct: true,
              rationale: 'Hypokalemia is the classic furosemide risk.',
            },
            {
              ordinal: 2,
              text: 'Daily calorie intake',
              is_correct: false,
              rationale: 'Nutrition is not the priority here.',
            },
            {
              ordinal: 3,
              text: 'Pupillary response',
              is_correct: false,
              rationale: 'Not related to loop diuretic therapy.',
            },
          ],
          chunk_ids: [chunkId],
        },
        {
          content_hash: numericHash,
          concept_key: 'furosemide',
          question_type: 'numeric_calculation',
          stem: 'The provider prescribes furosemide 40 mg PO. Tablets contain 20 mg. How many tablets should the nurse administer?',
          difficulty: 'easy',
          cognitive_level: 'application',
          source_type: 'course_grounded',
          priority_frameworks: [],
          rationale: 'Desired 40 mg divided by 20 mg per tablet equals 2 tablets.',
          expected_value: 2,
          tolerance: 0.1,
          answer_unit: 'tablets',
          rounding_note: 'Whole tablets.',
          status: 'active',
          safety_flags: [],
          options: [],
          chunk_ids: [chunkId],
        },
        {
          content_hash: flaggedHash,
          concept_key: 'furosemide',
          question_type: 'single_best_answer',
          stem: 'A flagged fixture question about furosemide dosing safety that students must never see in practice.',
          difficulty: 'hard',
          cognitive_level: 'analysis',
          source_type: 'course_grounded',
          priority_frameworks: [],
          rationale: 'Fixture rationale for the flagged safety-review question about dosing.',
          status: 'flagged',
          safety_flags: ['high_alert_medication'],
          options: [
            { ordinal: 1, text: 'Correct option', is_correct: true, rationale: null },
            { ordinal: 2, text: 'Distractor', is_correct: false, rationale: null },
          ],
          chunk_ids: [chunkId],
        },
      ],
    },
  });
  check(
    'service role applies question generation via RPC',
    !questionSeed.error &&
      questionSeed.data?.inserted === 3 &&
      questionSeed.data?.links === 3 &&
      questionSeed.data?.retired === 0,
    questionSeed.error?.message ?? JSON.stringify(questionSeed.data)
  );
  const clientGenRpc = await a.client.rpc('apply_question_generation', {
    p_document_id: docId,
    p_payload: { generation: {}, questions: [] },
  });
  check('authenticated client cannot call apply_question_generation', Boolean(clientGenRpc.error));
  const anonGenRpc = await userClient().rpc('apply_question_generation', {
    p_document_id: docId,
    p_payload: { generation: {}, questions: [] },
  });
  check('anonymous client cannot call apply_question_generation', Boolean(anonGenRpc.error));

  const adminQuestions = await admin
    .from('questions')
    .select('id, content_hash, status')
    .eq('course_id', courseId);
  const sbaQuestionId = adminQuestions.data?.find((q) => q.content_hash === sbaHash)?.id;
  const numericQuestionId = adminQuestions.data?.find((q) => q.content_hash === numericHash)?.id;
  const flaggedQuestionId = adminQuestions.data?.find((q) => q.content_hash === flaggedHash)?.id;

  // Questions/options/sources reject ALL direct client writes.
  const qIns = await a.client.from('questions').insert({
    course_id: courseId,
    question_type: 'single_best_answer',
    stem: 'Forged question stem that is definitely long enough to pass checks.',
    difficulty: 'easy',
    cognitive_level: 'recall',
    source_type: 'general_knowledge',
    rationale: 'Forged rationale that is long enough to pass the check.',
    content_hash: 'f'.repeat(64),
  });
  check('client cannot insert questions directly', Boolean(qIns.error));
  const qUpd = await a.client
    .from('questions')
    .update({ stem: 'Tampered stem that is long enough for the check constraint.' })
    .eq('id', sbaQuestionId)
    .select('id');
  check('client cannot update questions', Boolean(qUpd.error) || (qUpd.data ?? []).length === 0);
  const qDel = await a.client.from('questions').delete().eq('id', sbaQuestionId).select('id');
  check('client cannot delete questions', Boolean(qDel.error) || (qDel.data ?? []).length === 0);
  const optIns = await a.client.from('question_options').insert({
    question_id: sbaQuestionId,
    course_id: courseId,
    ordinal: 9,
    option_text: 'Forged option',
    is_correct: true,
  });
  check('client cannot insert question_options directly', Boolean(optIns.error));
  const optUpd = await a.client
    .from('question_options')
    .update({ option_text: 'Tampered' })
    .eq('question_id', sbaQuestionId)
    .select('id');
  check(
    'client cannot update question_options',
    Boolean(optUpd.error) || (optUpd.data ?? []).length === 0
  );
  const srcIns = await a.client.from('question_sources').insert({
    question_id: sbaQuestionId,
    chunk_id: chunkId,
    course_id: courseId,
    document_id: docId,
    generation_version: 'v1',
  });
  check('client cannot insert question_sources directly', Boolean(srcIns.error));

  // 35. Owner reads active questions/options — but never the answers (spec K).
  const ownQuestions = await a.client
    .from('questions')
    .select('id, question_type, stem, difficulty, cognitive_level, source_type, status')
    .eq('course_id', courseId)
    .order('created_at');
  check(
    'owner reads own ACTIVE questions only (flagged is invisible)',
    (ownQuestions.data ?? []).length === 2 &&
      (ownQuestions.data ?? []).every((q) => q.status === 'active'),
    ownQuestions.error?.message
  );
  const rationaleLeak = await a.client
    .from('questions')
    .select('rationale')
    .eq('id', sbaQuestionId);
  check('question rationale is not selectable by clients', Boolean(rationaleLeak.error));
  const numericLeak = await a.client
    .from('questions')
    .select('expected_value, tolerance')
    .eq('id', numericQuestionId);
  check('numeric expected_value/tolerance are not selectable', Boolean(numericLeak.error));
  const ownOptions = await a.client
    .from('question_options')
    .select('id, ordinal, option_text')
    .eq('question_id', sbaQuestionId)
    .order('ordinal');
  check(
    'owner reads own option text in deterministic order',
    (ownOptions.data ?? []).length === 3 && ownOptions.data?.[0]?.ordinal === 1,
    ownOptions.error?.message
  );
  const correctLeak = await a.client
    .from('question_options')
    .select('is_correct')
    .eq('question_id', sbaQuestionId);
  check('option is_correct is not selectable by clients', Boolean(correctLeak.error));
  const positionLeak = await a.client
    .from('question_options')
    .select('correct_position, rationale')
    .eq('question_id', sbaQuestionId);
  check('option correct_position/rationale are not selectable', Boolean(positionLeak.error));
  const ownProvenance = await a.client
    .from('question_sources')
    .select('question_id, chunk_id')
    .eq('question_id', sbaQuestionId);
  check(
    'owner reads own question provenance links (spec Q)',
    (ownProvenance.data ?? []).length === 1 && ownProvenance.data?.[0]?.chunk_id === chunkId,
    ownProvenance.error?.message
  );

  // 36. Flagged + guessed-id reads return nothing for the owner, B and anon.
  const flaggedRead = await a.client.from('questions').select('id').eq('id', flaggedQuestionId);
  check('flagged questions are invisible to students', (flaggedRead.data ?? []).length === 0);
  const flaggedOptions = await a.client
    .from('question_options')
    .select('id')
    .eq('question_id', flaggedQuestionId);
  check('options of flagged questions are invisible', (flaggedOptions.data ?? []).length === 0);
  const bQuestion = await b.client.from('questions').select('id').eq('id', sbaQuestionId);
  check(
    "user cannot read another user's questions by guessed id",
    (bQuestion.data ?? []).length === 0
  );
  const bOptions = await b.client
    .from('question_options')
    .select('id')
    .eq('question_id', sbaQuestionId);
  check("user cannot read another user's question options", (bOptions.data ?? []).length === 0);
  const bSources = await b.client
    .from('question_sources')
    .select('question_id')
    .eq('question_id', sbaQuestionId);
  check("user cannot read another user's question sources", (bSources.data ?? []).length === 0);
  const anonQuestion = await userClient().from('questions').select('id').eq('id', sbaQuestionId);
  check('anonymous client reads no questions', (anonQuestion.data ?? []).length === 0);

  // 37. Sessions are owner-scoped.
  const sessionIns = await a.client
    .from('study_sessions')
    .insert({ course_id: courseId, session_type: 'practice', planned_question_count: 2 })
    .select('id, status')
    .single();
  check(
    'owner creates a study session in own course',
    !sessionIns.error && sessionIns.data?.status === 'in_progress',
    sessionIns.error?.message
  );
  const sessionId = sessionIns.data?.id;
  const bSessionIns = await b.client
    .from('study_sessions')
    .insert({ course_id: courseId, session_type: 'practice', planned_question_count: 1 });
  check("user cannot create a session under another user's course", Boolean(bSessionIns.error));
  const bSessionRead = await b.client.from('study_sessions').select('id').eq('id', sessionId);
  check(
    "user cannot read another user's sessions by guessed id",
    (bSessionRead.data ?? []).length === 0
  );
  const bSessionUpd = await b.client
    .from('study_sessions')
    .update({ status: 'completed' })
    .eq('id', sessionId)
    .select('id');
  check(
    "user cannot update another user's session",
    Boolean(bSessionUpd.error) || (bSessionUpd.data ?? []).length === 0
  );
  const sessionReparent = await a.client
    .from('study_sessions')
    .update({ course_id: crypto.randomUUID() })
    .eq('id', sessionId);
  check('session course_id is not reassignable (column grant)', Boolean(sessionReparent.error));

  // 38. Attempts exist ONLY via submit_question_attempt.
  const attemptIns = await a.client.from('question_attempts').insert({
    session_id: sessionId,
    question_id: sbaQuestionId,
    course_id: courseId,
    response: { selected_option_ids: [] },
    is_correct: true,
  });
  check('client cannot insert question_attempts directly', Boolean(attemptIns.error));

  const adminOptions = await admin
    .from('question_options')
    .select('id, is_correct')
    .eq('question_id', sbaQuestionId);
  const correctOptionId = adminOptions.data?.find((o) => o.is_correct)?.id;
  const wrongOptionId = adminOptions.data?.find((o) => !o.is_correct)?.id;

  const scored = await a.client.rpc('submit_question_attempt', {
    p_session_id: sessionId,
    p_question_id: sbaQuestionId,
    p_response: { selected_option_ids: [correctOptionId] },
    p_response_time_ms: 4200,
    p_confidence: 'pretty_sure',
  });
  check(
    'owner scores an SBA attempt server-side and gets rationales back',
    !scored.error &&
      scored.data?.is_correct === true &&
      typeof scored.data?.rationale === 'string' &&
      (scored.data?.options ?? []).some((o) => o.is_correct === true),
    scored.error?.message
  );
  const numericScored = await a.client.rpc('submit_question_attempt', {
    p_session_id: sessionId,
    p_question_id: numericQuestionId,
    p_response: { value: 2.05 },
    p_response_time_ms: null,
    p_confidence: null,
  });
  check(
    'numeric scoring honors the stored tolerance (spec P)',
    !numericScored.error &&
      numericScored.data?.is_correct === true &&
      Number(numericScored.data?.expected_value) === 2,
    numericScored.error?.message
  );

  // 39. The locked answer is immutable (spec W).
  const reanswer = await a.client.rpc('submit_question_attempt', {
    p_session_id: sessionId,
    p_question_id: sbaQuestionId,
    p_response: { selected_option_ids: [wrongOptionId] },
  });
  check('re-answering the same question in a session is refused', Boolean(reanswer.error));
  const attemptRows = await a.client
    .from('question_attempts')
    .select('id, is_correct')
    .eq('session_id', sessionId);
  check(
    'owner reads own attempts (two locked answers)',
    (attemptRows.data ?? []).length === 2,
    attemptRows.error?.message
  );
  const attemptUpd = await a.client
    .from('question_attempts')
    .update({ is_correct: false })
    .eq('session_id', sessionId)
    .select('id');
  check(
    'client cannot update recorded attempts',
    Boolean(attemptUpd.error) || (attemptUpd.data ?? []).length === 0
  );
  const attemptDel = await a.client
    .from('question_attempts')
    .delete()
    .eq('session_id', sessionId)
    .select('id');
  check(
    'client cannot delete recorded attempts',
    Boolean(attemptDel.error) || (attemptDel.data ?? []).length === 0
  );
  const bAttemptRpc = await b.client.rpc('submit_question_attempt', {
    p_session_id: sessionId,
    p_question_id: sbaQuestionId,
    p_response: { selected_option_ids: [correctOptionId] },
  });
  check("user cannot score attempts against another user's session", Boolean(bAttemptRpc.error));
  const anonAttemptRpc = await userClient().rpc('submit_question_attempt', {
    p_session_id: sessionId,
    p_question_id: sbaQuestionId,
    p_response: { selected_option_ids: [correctOptionId] },
  });
  check('anonymous client cannot call submit_question_attempt', Boolean(anonAttemptRpc.error));
  const bAttemptRead = await b.client
    .from('question_attempts')
    .select('id')
    .eq('session_id', sessionId);
  check("user cannot read another user's attempts", (bAttemptRead.data ?? []).length === 0);

  const sessionClose = await a.client
    .from('study_sessions')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('id', sessionId)
    .select('status')
    .single();
  check(
    'owner completes own session',
    !sessionClose.error && sessionClose.data?.status === 'completed',
    sessionClose.error?.message
  );

  // ── M8: mastery engine security + correctness (spec AC/AD/AE/Z/AA) ──────

  // 41. Both scored attempts above hit concept-linked questions, so the RPC
  // must have created ONE concept_mastery row for the furosemide concept
  // (furosemideId from the M6 section above) and exactly one mastery event
  // per attempt — with the versioned v1 arithmetic.
  const masteryRow = (
    await admin
      .from('concept_mastery')
      .select(
        'user_id, concept_id, mastery, attempts_count, correct_count, misconception_severity, review_stage, next_review_at, algorithm_version'
      )
      .eq('course_id', courseId)
      .eq('user_id', a.id)
      .eq('concept_id', furosemideId)
      .maybeSingle()
  ).data;
  // v1 replay of the two attempts: SBA correct moderate/application/
  // pretty_sure (weight 1.1 → +0.25 capped), then numeric correct easy/
  // application/no-confidence (weight 0.88 → +0.198) ⇒ mastery 0.448.
  const close = (x, y) => typeof x === 'number' && Math.abs(x - y) < 1e-6;
  check(
    'submitting attempts creates the concept_mastery aggregate via the RPC',
    Boolean(masteryRow) &&
      masteryRow.attempts_count === 2 &&
      masteryRow.correct_count === 2 &&
      close(Number(masteryRow.mastery), 0.448) &&
      close(Number(masteryRow.misconception_severity), 0) &&
      masteryRow.review_stage === 2 &&
      masteryRow.next_review_at !== null &&
      masteryRow.algorithm_version === 1,
    masteryRow ? JSON.stringify(masteryRow) : 'row missing'
  );
  const masteryEvents = (
    await admin
      .from('mastery_events')
      .select('attempt_id, evidence_weight, mastery_before, mastery_after, algorithm_version')
      .eq('course_id', courseId)
      .eq('concept_id', furosemideId)
      .order('created_at', { ascending: true })
  ).data;
  check(
    'each scored attempt produced exactly one auditable mastery event (spec Z/AC)',
    (masteryEvents ?? []).length === 2 &&
      new Set(masteryEvents.map((e) => e.attempt_id)).size === 2 &&
      close(Number(masteryEvents[0].mastery_before), 0) &&
      close(Number(masteryEvents[0].mastery_after), 0.25) &&
      close(Number(masteryEvents[0].evidence_weight), 1.1) &&
      close(Number(masteryEvents[1].mastery_before), 0.25) &&
      close(Number(masteryEvents[1].mastery_after), 0.448) &&
      close(Number(masteryEvents[1].evidence_weight), 0.88) &&
      masteryEvents.every((e) => e.algorithm_version === 1),
    JSON.stringify(masteryEvents ?? [])
  );
  // The refused double-submit and the denied B/anon RPC calls above must not
  // have advanced mastery: still exactly two attempts counted (spec AC).
  check(
    'refused double-submit never double-updates mastery (spec AC)',
    masteryRow?.attempts_count === 2 && (masteryEvents ?? []).length === 2
  );

  // 42. Owners read their OWN mastery; B and anonymous read nothing even
  // with exact guessed ids (spec AD); nothing here ever goes to an AI
  // provider — it is plain owner-scoped rows (spec AE).
  const ownMastery = await a.client
    .from('concept_mastery')
    .select('concept_id, mastery, attempts_count, review_stage, next_review_at')
    .eq('course_id', courseId);
  check(
    'owner reads own concept_mastery rows',
    (ownMastery.data ?? []).length === 1 && ownMastery.data?.[0]?.concept_id === furosemideId,
    ownMastery.error?.message
  );
  const ownEvents = await a.client
    .from('mastery_events')
    .select('attempt_id, mastery_before, mastery_after')
    .eq('course_id', courseId);
  check(
    'owner reads own mastery event history (spec Z)',
    (ownEvents.data ?? []).length === 2,
    ownEvents.error?.message
  );
  const bMastery = await b.client
    .from('concept_mastery')
    .select('mastery')
    .eq('concept_id', furosemideId);
  check(
    "user cannot read another user's mastery by guessed concept id",
    (bMastery.data ?? []).length === 0
  );
  const bEvents = await b.client.from('mastery_events').select('id').eq('course_id', courseId);
  check("user cannot read another user's mastery events", (bEvents.data ?? []).length === 0);
  const anonMastery = await userClient()
    .from('concept_mastery')
    .select('mastery')
    .eq('concept_id', furosemideId);
  check('anonymous client reads no mastery rows', (anonMastery.data ?? []).length === 0);
  const anonEvents = await userClient().from('mastery_events').select('id');
  check('anonymous client reads no mastery events', (anonEvents.data ?? []).length === 0);

  // 43. There is NO client write path: the RPC is the sole writer (spec AD).
  const masteryIns = await a.client.from('concept_mastery').insert({
    user_id: a.id,
    course_id: courseId,
    concept_id: furosemideId,
    mastery: 1,
  });
  check('client cannot insert concept_mastery directly', Boolean(masteryIns.error));
  const masteryUpd = await a.client
    .from('concept_mastery')
    .update({ mastery: 1 })
    .eq('concept_id', furosemideId)
    .select('concept_id');
  check(
    'client cannot update own concept_mastery',
    Boolean(masteryUpd.error) || (masteryUpd.data ?? []).length === 0
  );
  const masteryDel = await a.client
    .from('concept_mastery')
    .delete()
    .eq('concept_id', furosemideId)
    .select('concept_id');
  check(
    'client cannot delete concept_mastery',
    Boolean(masteryDel.error) || (masteryDel.data ?? []).length === 0
  );
  const eventForge = await a.client.from('mastery_events').insert({
    attempt_id: crypto.randomUUID(),
    user_id: a.id,
    course_id: courseId,
    concept_id: furosemideId,
    is_correct: true,
    evidence_weight: 2,
    mastery_before: 0,
    mastery_after: 1,
    misconception_severity_after: 0,
    review_stage_after: 4,
    next_review_at: new Date().toISOString(),
    algorithm_version: 1,
  });
  check('client cannot forge mastery_events', Boolean(eventForge.error));
  const eventUpd = await a.client
    .from('mastery_events')
    .update({ mastery_after: 1 })
    .eq('course_id', courseId)
    .select('id');
  check(
    'client cannot rewrite mastery history (spec Z immutability)',
    Boolean(eventUpd.error) || (eventUpd.data ?? []).length === 0
  );

  // 44. The 'adaptive' session type added in M8 is accepted for owners and
  // invalid types are still rejected by the check constraint.
  const adaptiveIns = await a.client
    .from('study_sessions')
    .insert({ course_id: courseId, session_type: 'adaptive', planned_question_count: 5 })
    .select('id, session_type, status')
    .single();
  check(
    "owner starts an 'adaptive' session (M8 session type)",
    !adaptiveIns.error && adaptiveIns.data?.session_type === 'adaptive',
    adaptiveIns.error?.message
  );
  if (adaptiveIns.data?.id) {
    await a.client
      .from('study_sessions')
      .update({ status: 'abandoned', completed_at: new Date().toISOString() })
      .eq('id', adaptiveIns.data.id);
  }
  const badTypeIns = await a.client
    .from('study_sessions')
    .insert({ course_id: courseId, session_type: 'cramming', planned_question_count: 5 });
  check('unknown session types are still rejected', Boolean(badTypeIns.error));
  const bAdaptiveIns = await b.client
    .from('study_sessions')
    .insert({ course_id: courseId, session_type: 'adaptive', planned_question_count: 5 });
  check(
    "user cannot start an adaptive session under another user's course",
    Boolean(bAdaptiveIns.error)
  );

  // 45. M9 daily sessions: requested duration is stored for the owner and the
  // check constraint (1–120 minutes) rejects nonsense values.
  const durationIns = await a.client
    .from('study_sessions')
    .insert({
      course_id: courseId,
      session_type: 'adaptive',
      planned_question_count: 4,
      requested_duration_minutes: 10,
    })
    .select('id, requested_duration_minutes')
    .single();
  check(
    'owner starts a daily session with a requested duration (M9 spec B)',
    !durationIns.error && durationIns.data?.requested_duration_minutes === 10,
    durationIns.error?.message
  );
  const m9SessionId = durationIns.data?.id;
  const badDuration = await a.client.from('study_sessions').insert({
    course_id: courseId,
    session_type: 'adaptive',
    planned_question_count: 4,
    requested_duration_minutes: 500,
  });
  check('durations outside 1–120 minutes are rejected', Boolean(badDuration.error));

  // 46. The stored session plan (M9 spec O) is owner-scoped end to end.
  const planIns = await a.client.from('study_session_plan').insert([
    { session_id: m9SessionId, position: 1, question_id: sbaQuestionId },
    { session_id: m9SessionId, position: 2, question_id: numericQuestionId },
  ]);
  check('owner stores the session plan for resume', !planIns.error, planIns.error?.message);
  const planRead = await a.client
    .from('study_session_plan')
    .select('position, question_id, skipped_at')
    .eq('session_id', m9SessionId)
    .order('position');
  check(
    'owner reads own session plan in order',
    (planRead.data ?? []).length === 2 && planRead.data?.[0]?.position === 1,
    planRead.error?.message
  );
  const bPlanRead = await b.client
    .from('study_session_plan')
    .select('question_id')
    .eq('session_id', m9SessionId);
  check(
    "user cannot read another user's session plan by guessed id",
    (bPlanRead.data ?? []).length === 0
  );
  const anonPlanRead = await userClient().from('study_session_plan').select('question_id');
  check('anonymous client reads no session plans', (anonPlanRead.data ?? []).length === 0);
  const bPlanForge = await b.client
    .from('study_session_plan')
    .insert({ session_id: m9SessionId, position: 3, question_id: sbaQuestionId });
  check("user cannot forge plan rows into another user's session", Boolean(bPlanForge.error));

  // 47. Skips are the ONLY thing a client may change on a plan row (spec AB).
  const skipUpd = await a.client
    .from('study_session_plan')
    .update({ skipped_at: new Date().toISOString() })
    .eq('session_id', m9SessionId)
    .eq('question_id', sbaQuestionId)
    .select('skipped_at');
  check(
    'owner marks a plan row skipped',
    !skipUpd.error && Boolean(skipUpd.data?.[0]?.skipped_at),
    skipUpd.error?.message
  );
  const posUpd = await a.client
    .from('study_session_plan')
    .update({ position: 9 })
    .eq('session_id', m9SessionId)
    .eq('question_id', sbaQuestionId);
  check('plan order cannot be rewritten by the client', Boolean(posUpd.error));
  const bSkipUpd = await b.client
    .from('study_session_plan')
    .update({ skipped_at: new Date().toISOString() })
    .eq('session_id', m9SessionId)
    .eq('question_id', numericQuestionId)
    .select('skipped_at');
  check(
    "user cannot skip rows in another user's plan",
    Boolean(bSkipUpd.error) || (bSkipUpd.data ?? []).length === 0
  );

  // 48. Closed sessions accept no new plan rows, and deleting the session
  // removes its plan (cascade) — no orphaned plan state survives.
  await a.client
    .from('study_sessions')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('id', m9SessionId);
  const lateIns = await a.client
    .from('study_session_plan')
    .insert({ session_id: m9SessionId, position: 3, question_id: sbaQuestionId });
  check('closed sessions accept no new plan rows', Boolean(lateIns.error));
  await admin.from('study_sessions').delete().eq('id', m9SessionId);
  const orphanPlan = await admin
    .from('study_session_plan')
    .select('position')
    .eq('session_id', m9SessionId);
  check('deleting a session cascades to its plan rows', (orphanPlan.data ?? []).length === 0);

  // 49. M10 mode sessions: each mode id is a valid, honestly-labeled
  // session_type; anything else is rejected by the check constraint.
  const modeIds = [
    'rapid_response',
    'find_the_danger',
    'who_first',
    'medication_lab',
    'boss_battle',
  ];
  let modeInsertsOk = true;
  const modeSessionIds = [];
  for (const modeId of modeIds) {
    const ins = await a.client
      .from('study_sessions')
      .insert({ course_id: courseId, session_type: modeId, planned_question_count: 4 })
      .select('id, session_type')
      .single();
    if (ins.error || ins.data?.session_type !== modeId) modeInsertsOk = false;
    if (ins.data?.id) modeSessionIds.push(ins.data.id);
  }
  check('all five M10 mode session types are accepted for own courses', modeInsertsOk);
  const bogusMode = await a.client
    .from('study_sessions')
    .insert({ course_id: courseId, session_type: 'arcade', planned_question_count: 4 });
  check('an invented session_type is rejected by the check constraint', Boolean(bogusMode.error));
  for (const id of modeSessionIds) {
    await admin.from('study_sessions').delete().eq('id', id);
  }

  // 50. M11 simulation cases (spec AB/N/AW): the seeded library is readable
  // metadata-only — the authoritative `definition` (hidden findings, rules,
  // answers) is NOT selectable by any client, and anonymous clients see no
  // cases at all.
  const simCases = await a.client
    .from('simulation_cases')
    .select('id, case_key, status, engine_version')
    .eq('case_key', 'postop_pe');
  const simCaseRow = (simCases.data ?? [])[0];
  check(
    'authenticated user reads the seeded active simulation case metadata',
    Boolean(simCaseRow) && simCaseRow.status === 'active',
    simCases.error?.message
  );
  const simDefLeak = await a.client.from('simulation_cases').select('definition').limit(1);
  check('simulation case definition column is not selectable (spec N)', Boolean(simDefLeak.error));
  const anonSimCases = await userClient().from('simulation_cases').select('id');
  check('anonymous client reads no simulation cases', (anonSimCases.data ?? []).length === 0);

  // 51. start_simulation (spec V/X): owner starts a session on their own
  // course; a second call RESUMES the same session instead of forking.
  const simStart = await a.client.rpc('start_simulation', {
    p_course_id: courseId,
    p_case_key: 'postop_pe',
  });
  const simSessionId = simStart.data?.session_id;
  check(
    'owner starts a simulation session via the RPC',
    !simStart.error && Boolean(simSessionId) && simStart.data?.resumed === false,
    simStart.error?.message
  );
  const simResume = await a.client.rpc('start_simulation', {
    p_course_id: courseId,
    p_case_key: 'postop_pe',
  });
  check(
    'starting again resumes the existing active session (spec X)',
    !simResume.error &&
      simResume.data?.session_id === simSessionId &&
      simResume.data?.resumed === true,
    simResume.error?.message
  );
  const simViewLeak = JSON.stringify(simStart.data?.view ?? {});
  check(
    'the client view leaks no hidden findings or server internals (spec N)',
    !simViewLeak.includes('circumoral cyanosis') &&
      !simViewLeak.includes('deteriorationLevel') &&
      !simViewLeak.includes('firedRules')
  );

  // 52. Cross-user + anonymous isolation (spec AW): User B can neither start
  // on A's course, read A's session, act on it, nor view it.
  const bSimStart = await b.client.rpc('start_simulation', {
    p_course_id: courseId,
    p_case_key: 'postop_pe',
  });
  check("user cannot start a simulation on another user's course", Boolean(bSimStart.error));
  const bSimRead = await b.client.from('simulation_sessions').select('id').eq('id', simSessionId);
  check("user cannot read another user's simulation session", (bSimRead.data ?? []).length === 0);
  const bSimAct = await b.client.rpc('simulation_act', {
    p_session_id: simSessionId,
    p_action_id: 'a_obtain_vitals',
  });
  check("user cannot act on another user's simulation session", Boolean(bSimAct.error));
  const bSimView = await b.client.rpc('get_simulation_view', { p_session_id: simSessionId });
  check("user cannot fetch another user's simulation view", Boolean(bSimView.error));
  const anonSimStart = await userClient().rpc('start_simulation', {
    p_course_id: courseId,
    p_case_key: 'postop_pe',
  });
  check('anonymous client cannot call start_simulation', Boolean(anonSimStart.error));

  // 53. Server-only state (spec N/C): the authoritative session state, the
  // score payload, and per-action events/results are not selectable.
  const simStateLeak = await a.client
    .from('simulation_sessions')
    .select('state')
    .eq('id', simSessionId);
  check('session state column is not selectable by the client', Boolean(simStateLeak.error));
  const simScoreLeak = await a.client
    .from('simulation_sessions')
    .select('score')
    .eq('id', simSessionId);
  check('session score column is not selectable by the client', Boolean(simScoreLeak.error));
  const simEventsLeak = await a.client
    .from('simulation_actions')
    .select('events')
    .eq('session_id', simSessionId);
  check('action events column is not selectable by the client', Boolean(simEventsLeak.error));
  const simResultLeak = await a.client
    .from('simulation_actions')
    .select('result')
    .eq('session_id', simSessionId);
  check('action result column is not selectable by the client', Boolean(simResultLeak.error));

  // 54. No direct write path (spec V/W/BC): even the OWNER cannot insert,
  // update, or delete session or action rows — the RPCs are the only door.
  const simSessForge = await a.client
    .from('simulation_sessions')
    .insert({ user_id: a.id, course_id: courseId, case_id: simCaseRow?.id });
  check('client cannot insert simulation sessions directly', Boolean(simSessForge.error));
  const simSessTamper = await a.client
    .from('simulation_sessions')
    .update({ status: 'completed' })
    .eq('id', simSessionId)
    .select();
  check(
    'client cannot update simulation sessions directly',
    Boolean(simSessTamper.error) || (simSessTamper.data ?? []).length === 0
  );
  const simActForge = await a.client
    .from('simulation_actions')
    .insert({ session_id: simSessionId, seq: 999, action_id: 'a_wait', sim_time_minutes: 0 });
  check('client cannot forge simulation action history (spec W)', Boolean(simActForge.error));

  // 55. simulation_act + idempotency (spec E/W/Y): an accepted action
  // advances simulated time and appends exactly one audited row; replaying
  // the same idempotency key returns the stored result WITHOUT re-running,
  // and rejected submissions are audited too.
  const simAct1 = await a.client.rpc('simulation_act', {
    p_session_id: simSessionId,
    p_action_id: 'a_obtain_vitals',
    p_params: {},
    p_idempotency_key: 'authz-sim-key-1',
  });
  check(
    'owner submits an action and receives visible events + updated view',
    !simAct1.error && simAct1.data?.rejected === null && Array.isArray(simAct1.data?.events),
    simAct1.error?.message
  );
  const simAct1Retry = await a.client.rpc('simulation_act', {
    p_session_id: simSessionId,
    p_action_id: 'a_obtain_vitals',
    p_params: {},
    p_idempotency_key: 'authz-sim-key-1',
  });
  const simActRows1 = await a.client
    .from('simulation_actions')
    .select('id, seq, rejected')
    .eq('session_id', simSessionId);
  check(
    'replaying the same idempotency key does not double-apply the action (spec Y)',
    !simAct1Retry.error &&
      JSON.stringify(simAct1Retry.data) === JSON.stringify(simAct1.data) &&
      (simActRows1.data ?? []).length === 1
  );
  const simActBad = await a.client.rpc('simulation_act', {
    p_session_id: simSessionId,
    p_action_id: 'not_a_real_action',
  });
  const simActRows2 = await a.client
    .from('simulation_actions')
    .select('seq, rejected')
    .eq('session_id', simSessionId)
    .order('seq');
  check(
    'rejected actions change nothing but are still audited (spec W/BC)',
    !simActBad.error &&
      simActBad.data?.rejected === 'unknown_action' &&
      (simActRows2.data ?? []).length === 2 &&
      (simActRows2.data ?? [])[1]?.rejected === 'unknown_action'
  );

  // 56. Debrief gating (spec AQ): the debrief is only available once the
  // session is completed — an active session refuses to reveal it.
  const simDebriefEarly = await a.client.rpc('get_simulation_debrief', {
    p_session_id: simSessionId,
  });
  check('debrief is refused while the session is still active', Boolean(simDebriefEarly.error));

  // 40. Feedback is stored, owner-scoped, and never auto-applied (spec AH).
  const feedbackIns = await a.client
    .from('question_feedback')
    .insert({
      question_id: sbaQuestionId,
      course_id: courseId,
      reason: 'answer_wrong',
      comment: 'Authz fixture feedback.',
    })
    .select('id, reason')
    .single();
  check(
    'owner flags own question with a reason',
    !feedbackIns.error && feedbackIns.data?.reason === 'answer_wrong',
    feedbackIns.error?.message
  );
  const bFeedback = await b.client.from('question_feedback').insert({
    question_id: sbaQuestionId,
    course_id: courseId,
    reason: 'other',
  });
  check("user cannot flag another user's question", Boolean(bFeedback.error));
  const afterFeedback = await admin
    .from('questions')
    .select('status')
    .eq('id', sbaQuestionId)
    .single();
  check(
    'feedback never auto-changes the question (still active)',
    afterFeedback.data?.status === 'active'
  );

  // Deleting a document retires course-grounded questions that lost ALL of
  // their evidence (spec H/Q) — verified via a disposable third document.
  const doc3Ins = await admin
    .from('documents')
    .insert({
      course_id: courseId,
      uploaded_by: a.id,
      filename: 'authz-test-3.txt',
      original_filename: 'authz-test-3.txt',
      mime_type: 'text/plain',
      file_extension: 'txt',
      file_size: 20,
      document_type: 'notes',
      content_hash: null,
    })
    .select()
    .single();
  const doc3Id = doc3Ins.data?.id;
  await admin.rpc('replace_source_chunks', {
    p_document_id: doc3Id,
    p_chunks: [
      {
        ordinal: 0,
        content: 'Authz chunk three: heparin requires aPTT monitoring.',
        token_estimate: 10,
        source_locator: { type: 'txt', sectionIndex: 0 },
        section_start: 0,
        section_end: 0,
        embedding: unitVector,
        embedding_provider: 'authz',
        embedding_model: 'authz-test',
        embedding_version: 'v1',
      },
    ],
  });
  const doc3Chunk = await admin
    .from('source_chunks')
    .select('id')
    .eq('document_id', doc3Id)
    .single();
  const doc3Seed = await admin.rpc('apply_question_generation', {
    p_document_id: doc3Id,
    p_payload: {
      generation: {
        provider: 'authz',
        model: 'authz-test',
        prompt_version: 'p1',
        generation_version: 'v1',
      },
      questions: [
        {
          content_hash: 'd'.repeat(64),
          concept_key: null,
          question_type: 'single_best_answer',
          stem: 'A disposable fixture question whose only evidence lives in document three.',
          difficulty: 'easy',
          cognitive_level: 'recall',
          source_type: 'course_grounded',
          priority_frameworks: [],
          rationale: 'Fixture rationale long enough to satisfy the length constraint.',
          status: 'active',
          safety_flags: [],
          options: [
            { ordinal: 1, text: 'Right', is_correct: true, rationale: null },
            { ordinal: 2, text: 'Wrong', is_correct: false, rationale: null },
          ],
          chunk_ids: [doc3Chunk.data?.id],
        },
      ],
    },
  });
  const doc3QuestionId = (
    await admin
      .from('questions')
      .select('id')
      .eq('course_id', courseId)
      .eq('content_hash', 'd'.repeat(64))
      .single()
  ).data?.id;
  check(
    'third document seeded with an evidence-bound question',
    !doc3Seed.error && Boolean(doc3QuestionId),
    doc3Seed.error?.message
  );
  const doc3Del = await admin.from('documents').delete().eq('id', doc3Id).select('id');
  const doc3QuestionAfter = await admin
    .from('questions')
    .select('status')
    .eq('id', doc3QuestionId)
    .single();
  check(
    'document delete retires the question that lost all its evidence',
    (doc3Del.data ?? []).length === 1 && doc3QuestionAfter.data?.status === 'retired'
  );
  const survivorsAfterDoc3 = await admin
    .from('questions')
    .select('id, status')
    .in('id', [sbaQuestionId, numericQuestionId]);
  check(
    'questions still backed by evidence survive the document delete',
    (survivorsAfterDoc3.data ?? []).every((q) => q.status === 'active')
  );

  // 32. Deleting a document removes its provenance links and prunes AI
  // concepts left without any supporting source (spec M/O). Uses a SECOND
  // document so the course-cascade check below keeps its fixtures.
  const doc2Ins = await admin
    .from('documents')
    .insert({
      course_id: courseId,
      uploaded_by: a.id,
      filename: 'authz-test-2.txt',
      original_filename: 'authz-test-2.txt',
      mime_type: 'text/plain',
      file_extension: 'txt',
      file_size: 20,
      document_type: 'notes',
      content_hash: null,
    })
    .select()
    .single();
  const doc2Id = doc2Ins.data?.id;
  await admin.rpc('replace_source_chunks', {
    p_document_id: doc2Id,
    p_chunks: [
      {
        ordinal: 0,
        content: 'Authz chunk two: docusate is a stool softener.',
        token_estimate: 12,
        source_locator: { type: 'txt', sectionIndex: 0 },
        section_start: 0,
        section_end: 0,
        embedding: unitVector,
        embedding_provider: 'authz',
        embedding_model: 'authz-test',
        embedding_version: 'v1',
      },
    ],
  });
  const doc2Chunk = await admin
    .from('source_chunks')
    .select('id')
    .eq('document_id', doc2Id)
    .single();
  const doc2Seed = await admin.rpc('apply_concept_extraction', {
    p_document_id: doc2Id,
    p_payload: {
      extraction: {
        provider: 'authz',
        model: 'authz-test',
        prompt_version: 'p1',
        extraction_version: 'v1',
      },
      concepts: [
        {
          key: 'docusate',
          name: 'Docusate',
          type: 'medication',
          summary: 'Stool softener (second-document fixture).',
          aliases: [],
          chunk_ids: [doc2Chunk.data?.id],
        },
      ],
      relationships: [],
    },
  });
  const docusateId = await admin
    .from('concepts')
    .select('id')
    .eq('course_id', courseId)
    .eq('normalized_key', 'docusate')
    .maybeSingle();
  check(
    'second document seeded with its own AI concept',
    !doc2Seed.error && Boolean(docusateId.data?.id),
    doc2Seed.error?.message
  );
  const doc2Del = await a.client.from('documents').delete().eq('id', doc2Id).select();
  check('owner deletes the second document', (doc2Del.data ?? []).length === 1);
  const doc2Links = await admin.from('concept_sources').select('id').eq('document_id', doc2Id);
  const docusateAfter = await admin
    .from('concepts')
    .select('id')
    .eq('id', docusateId.data?.id ?? '00000000-0000-0000-0000-000000000000');
  check(
    'document delete removes its concept links and prunes the orphan AI concept',
    (doc2Links.data ?? []).length === 0 && (docusateAfter.data ?? []).length === 0
  );
  const survivors = await admin.from('concepts').select('id').eq('course_id', courseId);
  check(
    'concepts supported by the remaining document survive the prune',
    (survivors.data ?? []).length === 2
  );

  // 18. Deleting a course cascades to its modules/exams/links/documents but
  // never touches the profile. (The app removes storage objects before the
  // course row — SQL cannot cascade into storage, so we clean up here.)
  const aDel = await a.client.from('courses').delete().eq('id', courseId).select();
  check('owner deletes own course', (aDel.data ?? []).length === 1);
  const orphanModules = await admin.from('modules').select('id').eq('course_id', courseId);
  const orphanExams = await admin.from('exams').select('id').eq('course_id', courseId);
  const orphanLinks = await admin.from('exam_modules').select('exam_id').eq('exam_id', examId);
  const orphanDocs = await admin.from('documents').select('id').eq('course_id', courseId);
  // 22/27. Derived content (document_sections AND source_chunks) must also
  // be gone — retrieval never sees deleted material (spec W).
  const orphanSections = await admin
    .from('document_sections')
    .select('id')
    .eq('document_id', docId);
  const orphanChunks = await admin.from('source_chunks').select('id').eq('document_id', docId);
  // 33. The knowledge model (concepts, aliases, sources, relationships) must
  // also be gone — no knowledge outlives the course it came from (spec A).
  const orphanConcepts = await admin.from('concepts').select('id').eq('course_id', courseId);
  const orphanAliases = await admin.from('concept_aliases').select('id').eq('course_id', courseId);
  const orphanConceptSources = await admin
    .from('concept_sources')
    .select('id')
    .eq('course_id', courseId);
  const orphanRelationships = await admin
    .from('concept_relationships')
    .select('id')
    .eq('course_id', courseId);
  // 40 (cont.) The assessment layer must also be gone: questions, options,
  // provenance, sessions, attempts and feedback all die with the course.
  const orphanQuestions = await admin.from('questions').select('id').eq('course_id', courseId);
  const orphanOptions = await admin.from('question_options').select('id').eq('course_id', courseId);
  const orphanQuestionSources = await admin
    .from('question_sources')
    .select('question_id')
    .eq('course_id', courseId);
  const orphanSessions = await admin.from('study_sessions').select('id').eq('course_id', courseId);
  const orphanAttempts = await admin
    .from('question_attempts')
    .select('id')
    .eq('course_id', courseId);
  const orphanFeedback = await admin
    .from('question_feedback')
    .select('id')
    .eq('course_id', courseId);
  // 44 (cont.) The mastery layer must also be gone (spec AD): aggregates and
  // the audit history die with the course.
  const orphanMastery = await admin
    .from('concept_mastery')
    .select('concept_id')
    .eq('course_id', courseId);
  const orphanMasteryEvents = await admin
    .from('mastery_events')
    .select('id')
    .eq('course_id', courseId);
  // 57 (M11). Simulation sessions and their append-only action history must
  // also die with the course (spec V/AW) — no orphaned clinical state.
  const orphanSimSessions = await admin
    .from('simulation_sessions')
    .select('id')
    .eq('course_id', courseId);
  const orphanSimActions = await admin
    .from('simulation_actions')
    .select('id')
    .eq('session_id', simSessionId);
  check(
    'course delete cascades to modules, exams, exam_modules, documents, sections, chunks, concepts and the assessment layer',
    (orphanModules.data ?? []).length === 0 &&
      (orphanExams.data ?? []).length === 0 &&
      (orphanLinks.data ?? []).length === 0 &&
      (orphanDocs.data ?? []).length === 0 &&
      (orphanSections.data ?? []).length === 0 &&
      (orphanChunks.data ?? []).length === 0 &&
      (orphanConcepts.data ?? []).length === 0 &&
      (orphanAliases.data ?? []).length === 0 &&
      (orphanConceptSources.data ?? []).length === 0 &&
      (orphanRelationships.data ?? []).length === 0 &&
      (orphanQuestions.data ?? []).length === 0 &&
      (orphanOptions.data ?? []).length === 0 &&
      (orphanQuestionSources.data ?? []).length === 0 &&
      (orphanSessions.data ?? []).length === 0 &&
      (orphanAttempts.data ?? []).length === 0 &&
      (orphanFeedback.data ?? []).length === 0 &&
      (orphanMastery.data ?? []).length === 0 &&
      (orphanMasteryEvents.data ?? []).length === 0 &&
      (orphanSimSessions.data ?? []).length === 0 &&
      (orphanSimActions.data ?? []).length === 0
  );
  await admin.storage
    .from('course-materials')
    .remove([objectKey])
    .catch(() => {});
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
