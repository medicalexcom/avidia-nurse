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
  check(
    'course delete cascades to modules, exams, exam_modules, documents, sections and chunks',
    (orphanModules.data ?? []).length === 0 &&
      (orphanExams.data ?? []).length === 0 &&
      (orphanLinks.data ?? []).length === 0 &&
      (orphanDocs.data ?? []).length === 0 &&
      (orphanSections.data ?? []).length === 0 &&
      (orphanChunks.data ?? []).length === 0
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
