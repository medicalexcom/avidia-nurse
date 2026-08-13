# ADR-0008: Material storage — object-path convention, upload architecture, and processing state machine

- **Status:** Accepted
- **Date:** 2026-08-12
- **Milestone:** M3

## Context

M3 introduces course-material upload and storage. Four design questions had to be settled in a
way that survives M4 (ingestion) and the security model (per-student isolation enforced by the
backend, never by obscurity):

1. Where do uploaded bytes live, and how is the object path structured?
2. In what order do the database write and the storage write happen, and what happens when one
   of them fails?
3. How is the document lifecycle modeled so M4 can attach processing without schema churn —
   without building any fake processing now?
4. How are duplicates detected across platforms where hashing capabilities differ?

## Decision

### 1. Object-path convention: `user_id/course_id/document_id/filename`

One private bucket (`course-materials`), objects keyed as
`user_id/course_id/document_id/sanitized_filename`.

- **Segment 1 (`user_id`)** makes storage policies a one-liner:
  `(storage.foldername(name))[1] = auth.uid()::text`. Isolation is structural, not
  convention-by-honor.
- **Segment 2 (`course_id`)** is verified at INSERT time against course ownership, and lets an
  M4 worker enumerate a course's corpus by prefix.
- **Segment 3 (`document_id`)** guarantees uniqueness — two uploads of `notes.pdf` never
  collide — and links object to row bidirectionally.
- **Segment 4** is the sanitized filename, kept so signed-URL downloads have a human name.

A database CHECK (`documents_storage_key_matches_owner`) requires every stored key to match
`uploaded_by/course_id/id/…`, so even a forged client cannot record a row pointing into someone
else's folder. The bucket has **no storage UPDATE policy**: objects are immutable, which
eliminates in-place replacement attacks; changing a file means a new document.

Rejected alternatives: random/UUID-only keys (authorization would then depend on a DB join for
every storage policy evaluation, and prefix-listing a course corpus in M4 would be impossible);
a public bucket with unguessable names (security by obscurity — explicitly forbidden).

### 2. Upload order of operations: row first, bytes second, promote third

`validate → duplicate check → INSERT row (status 'uploading') → upload bytes → UPDATE row
(storage_key, status 'uploaded')`.

The row goes first because the object path needs the database-assigned document id, and because
a visible `uploading`/`failed` row is honest UI state with a retry affordance. The failure
modes are all benign: a crash before the bytes land leaves a `failed`/`uploading` row and no
object; a crash after the bytes land but before promotion leaves an object the retry path
replaces under a new document id and the delete path can remove. **Deletion is the mirror:
object first, then row** — both operations are idempotent, so the recovery for any partial
failure is "delete again"; the reverse order could orphan an unreachable object.

Signed URLs (TTL 300 s) are minted on demand and never persisted; the database stores only the
storage key.

### 3. Processing state machine, defined now, exercised later

`uploading → uploaded|failed`, `uploaded → queued`, `queued → processing`,
`processing → ready|failed`, `failed → uploading|queued`, `ready` terminal — encoded in the
domain layer (`canTransitionStatus`) and unit-tested, including the absence of shortcuts.

M3 only ever produces `uploading`, `uploaded`, and `failed`. The later states are _defined_ so
that M4 attaches at exactly one seam — `uploaded → queued` — with no schema migration and no
state-machine rework. Nothing simulates processing: no fake worker, no dead code. The rejected
alternative (add states when M4 needs them) would make M3's status column a lie the moment M4
starts and force a data migration over live rows.

### 4. Duplicate detection: content hash where possible, honest fallback elsewhere

`content_hash` stores a SHA-256 of the bytes, computed via WebCrypto on web. Hermes (native)
lacks `crypto.subtle`, and hand-rolling a JS hash over 50 MB files is slow and fragile, so on
native the hasher returns `null` (a documented deferment behind the `ContentHasher` interface)
and duplicate matching falls back to `original_filename + file_size` within the course. In both
cases a suspected duplicate is surfaced to the student, who explicitly consents ("Upload
anyway") or cancels — never a silent re-upload, never a silent drop. A native implementation
(e.g. `expo-crypto`) can replace the fallback later without touching any caller.

## Consequences

- Storage policies, DB RLS, and the storage-key CHECK enforce the same ownership invariant at
  three independent layers; the authz harness attacks all three.
- M4 ingestion has a precise, pre-tested entry point and a prefix-enumerable corpus per course.
- Objects are immutable; "replace" as a product feature would require a deliberate new design.
- Native uploads may occasionally miss a duplicate that web would catch (renamed identical
  file) until native hashing lands — accepted, since the consequence is only a consented
  re-upload prompt not appearing.
