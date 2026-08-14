import { pickDefaultCourseId } from './todayApi';
import type { CourseSummary } from '../courses/coursesApi';

/**
 * Intelligent course defaulting (M9 spec P). Pure logic: exam pressure wins,
 * then active recency, then anything — never a hard-coded first course.
 */

const NOW = new Date('2026-08-13T12:00:00.000Z');

function makeCourse(
  id: string,
  status: string,
  exams: { id: string; title: string; exam_at: string }[] = []
): CourseSummary {
  return {
    id,
    user_id: 'user-1',
    title: `Course ${id}`,
    term: null,
    institution_name: null,
    status,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    module_count: 0,
    exams,
  } as CourseSummary;
}

describe('pickDefaultCourseId (spec P)', () => {
  it('returns null when the student has no courses', () => {
    expect(pickDefaultCourseId([], NOW)).toBeNull();
  });

  it('prefers the active course whose next exam is soonest', () => {
    const courses = [
      makeCourse('a', 'active', [
        { id: 'e1', title: 'Final', exam_at: '2026-09-20T09:00:00.000Z' },
      ]),
      makeCourse('b', 'active', [
        { id: 'e2', title: 'Midterm', exam_at: '2026-08-20T09:00:00.000Z' },
      ]),
    ];
    expect(pickDefaultCourseId(courses, NOW)).toBe('b');
  });

  it('ignores exams that already happened', () => {
    const courses = [
      makeCourse('a', 'active', [{ id: 'e1', title: 'Past', exam_at: '2026-07-01T09:00:00.000Z' }]),
      makeCourse('b', 'active', [
        { id: 'e2', title: 'Future', exam_at: '2026-10-01T09:00:00.000Z' },
      ]),
    ];
    expect(pickDefaultCourseId(courses, NOW)).toBe('b');
  });

  it('falls back to the newest active course when no future exams exist', () => {
    // listOwnCourses orders newest-first; the first candidate wins.
    const courses = [makeCourse('newest', 'active'), makeCourse('older', 'active')];
    expect(pickDefaultCourseId(courses, NOW)).toBe('newest');
  });

  it('considers non-active courses only when no active courses exist', () => {
    const archivedOnly = [makeCourse('archived-1', 'archived')];
    expect(pickDefaultCourseId(archivedOnly, NOW)).toBe('archived-1');

    const mixed = [
      makeCourse('archived-1', 'archived', [
        { id: 'e1', title: 'Soon', exam_at: '2026-08-15T09:00:00.000Z' },
      ]),
      makeCourse('active-1', 'active'),
    ];
    expect(pickDefaultCourseId(mixed, NOW)).toBe('active-1');
  });
});
