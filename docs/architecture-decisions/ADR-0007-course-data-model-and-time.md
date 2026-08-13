# ADR-0007: Course data model — exam-module join table, soft archive, and UTC time

- **Status:** Accepted
- **Date:** 2026-08-12
- **Milestone:** M2

## Context

M2 introduces courses, modules, and exams. Three modeling questions had no single answer in the
governing documents and needed explicit decisions:

1. **Exam ↔ module association.** Playbook §6 defines `courses`, `modules`, and `exams` but no
   association between exams and the modules they cover, while the M2 requirements demand one
   ("an exam covers modules 3–5") with an explicit prohibition on comma-separated ID strings.
2. **Course deletion.** Students finish terms; courses become irrelevant but their history may
   still matter. Deleting everything on a whim is dangerous; keeping everything forever clutters
   the UI.
3. **Exam date/time semantics.** Exam times must be correct in each student's timezone, without
   any hard-coded default (explicitly: no hard-coded US Central), and countdowns must survive
   DST transitions and timezone boundaries.

## Decision

### 1. Normalized `exam_modules` join table

A dedicated join table `exam_modules (exam_id, module_id)` with a composite primary key models
the many-to-many association. Its INSERT policy requires — inside the database policy itself —
that the exam and the module belong to the **same course** and that course belongs to the
caller. Cross-user and cross-course associations are therefore impossible even with forged
requests. No update grant exists on the table; associations are replaced (delete + insert),
which keeps the client logic trivial and the invariant airtight.

Rejected alternative: an array or delimited-string column on `exams`. It cannot be foreign-keyed,
cannot cascade, cannot be policy-checked per-referenced-row, and rots as modules are deleted.

### 2. Soft archive by default, explicit cascading hard delete

`courses.status ∈ {'active','archived'}` (default `active`). Archiving is the recommended,
reversible retirement path: the course and all its data stay, hidden from the active list.
Hard delete exists but is explicit and honest: FK `on delete cascade` removes the course's
modules, exams, and exam-module links in one transaction, the UI states exactly what will be
deleted and requires confirmation, and profile data is never touched (the profile↔course link
only cascades in the other direction, from user deletion).

### 3. Store UTC instants; display and count in the student's timezone

- `exams.exam_at` is a `timestamptz` — one unambiguous UTC instant.
- Entry: the student types a local date and time; `@avidia/domain` converts it from the
  student's timezone (profile timezone if set and valid, otherwise the device's IANA zone from
  `Intl`) to UTC. No timezone is ever hard-coded.
- Display: the same domain package formats the stored instant back in the student's timezone.
- Countdown: "Exam in N days" is a **local calendar-day difference**, not a division of elapsed
  milliseconds by 24 h. This is what makes countdowns DST-stable: across a spring-forward or
  fall-back boundary the number of calendar days is unchanged even though the elapsed hours are
  not. An exam earlier today remains "Exam today", past days are "Exam completed", and invalid
  data degrades to a safe "Date unavailable" label.

Historical exam dates are accepted intentionally (students record past exams); the UI shows a
non-blocking notice and the countdown renders "Exam completed".

## Consequences

- The database is the source of truth for the association invariant; clients cannot weaken it.
- Archive-first UX makes destructive loss an explicit, informed choice.
- All time logic lives in `@avidia/domain` with unit tests covering DST transitions, timezone
  boundaries, invalid zones, and round-trips — screens contain no date arithmetic.
- A future server-rendered surface can reuse the same UTC instants without migration.
