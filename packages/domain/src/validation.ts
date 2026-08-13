/**
 * Course / module / exam validation (M2 domain layer).
 *
 * All rules mirror the database constraints in migration 0002 so users get a
 * friendly message before the request is ever sent; the database remains the
 * authority. Every function returns user-safe error strings (never raw
 * provider/database errors).
 */

export const COURSE_TITLE_MAX = 120;
export const COURSE_TERM_MAX = 60;
export const COURSE_INSTITUTION_MAX = 120;
export const MODULE_TITLE_MAX = 120;
export const EXAM_TITLE_MAX = 120;

export const COURSE_STATUSES = ['active', 'archived'] as const;
export type CourseStatus = (typeof COURSE_STATUSES)[number];

export interface CourseInput {
  title: string;
  term?: string | null;
  institutionName?: string | null;
}

export interface ValidatedCourse {
  title: string;
  term: string | null;
  institution_name: string | null;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function validateCourse(input: CourseInput): Validation<ValidatedCourse> {
  const errors: string[] = [];
  const title = input.title.trim();
  const term = trimmedOrNull(input.term);
  const institution = trimmedOrNull(input.institutionName);
  if (title.length === 0) errors.push('Course title is required.');
  if (title.length > COURSE_TITLE_MAX)
    errors.push(`Course title must be ${COURSE_TITLE_MAX} characters or fewer.`);
  if (term && term.length > COURSE_TERM_MAX)
    errors.push(`Term must be ${COURSE_TERM_MAX} characters or fewer.`);
  if (institution && institution.length > COURSE_INSTITUTION_MAX)
    errors.push(`Institution name must be ${COURSE_INSTITUTION_MAX} characters or fewer.`);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { title, term, institution_name: institution } };
}

export function validateModuleTitle(rawTitle: string): Validation<string> {
  const title = rawTitle.trim();
  if (title.length === 0) return { ok: false, errors: ['Module title is required.'] };
  if (title.length > MODULE_TITLE_MAX) {
    return { ok: false, errors: [`Module title must be ${MODULE_TITLE_MAX} characters or fewer.`] };
  }
  return { ok: true, value: title };
}

export interface ExamInput {
  title: string;
  /** UTC instant, or null when the entered date/time could not be interpreted. */
  examAt: Date | null;
  /** Raw weight text from the form; empty means "no weight". */
  weightText?: string | null;
}

export interface ValidatedExam {
  title: string;
  exam_at: string;
  weight: number | null;
}

export function validateExam(input: ExamInput): Validation<ValidatedExam> {
  const errors: string[] = [];
  const title = input.title.trim();
  if (title.length === 0) errors.push('Exam title is required.');
  if (title.length > EXAM_TITLE_MAX)
    errors.push(`Exam title must be ${EXAM_TITLE_MAX} characters or fewer.`);

  if (!input.examAt || Number.isNaN(input.examAt.getTime())) {
    errors.push('Enter a valid exam date and time.');
  }

  let weight: number | null = null;
  const weightText = (input.weightText ?? '').trim();
  if (weightText.length > 0) {
    const parsed = Number(weightText);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
      errors.push('Weight must be a number between 0 and 100.');
    } else {
      weight = parsed;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { title, exam_at: (input.examAt as Date).toISOString(), weight } };
}

/**
 * Assign gapless sequence numbers (0, 1, 2, …) to modules in display order.
 * Used both for appending ("next sequence") and for reordering.
 */
export function resequence<T extends { id: string }>(
  orderedModules: readonly T[]
): { id: string; sequence: number }[] {
  return orderedModules.map((m, index) => ({ id: m.id, sequence: index }));
}

/** Move the item at `from` to position `to`, returning a new array. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as T);
  return next;
}
