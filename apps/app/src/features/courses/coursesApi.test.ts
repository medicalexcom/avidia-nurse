import type { SupabaseClient } from '@supabase/supabase-js';

import {
  createCourse,
  deleteOwnCourse,
  fetchOwnCourse,
  listOwnCourses,
  sanitizeCourseUpdate,
  updateOwnCourse,
} from './coursesApi';
import { createModule, saveModuleOrder } from './modulesApi';
import { createExam, sanitizeExamUpdate, setExamModules } from './examsApi';

/**
 * Chainable, awaitable fake of the supabase-js query builder. Records every
 * call so tests can assert that data access is always owner-scoped and only
 * writes allowed fields. (RLS is verified against a real database by
 * scripts/authz-check.mjs; these tests cover the client-side discipline.)
 */
function makeFakeDb(result: unknown = null) {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, args: unknown[]) => {
    (calls[name] ??= []).push(args);
  };
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'insert', 'update', 'delete', 'eq', 'order']) {
    builder[method] = jest.fn((...args: unknown[]) => {
      record(method, args);
      return builder;
    });
  }
  for (const terminal of ['single', 'maybeSingle']) {
    builder[terminal] = jest.fn((...args: unknown[]) => {
      record(terminal, args);
      return Promise.resolve({ data: result, error: null });
    });
  }
  // Awaiting the builder itself (e.g. delete().eq(...)) resolves like a query.
  builder.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data: result, error: null }).then(resolve);
  const client = {
    from: jest.fn((table: string) => {
      record('from', [table]);
      return builder;
    }),
  } as unknown as SupabaseClient;
  return { client, calls };
}

const course = {
  id: 'course-1',
  user_id: 'user-1',
  title: 'Pharmacology',
  term: 'Fall 2026',
  institution_name: null,
  status: 'active',
  created_at: '2026-08-12T00:00:00Z',
  updated_at: '2026-08-12T00:00:00Z',
};

describe('course ownership scoping', () => {
  it('listOwnCourses queries only the caller’s courses', async () => {
    const { client, calls } = makeFakeDb([]);
    await listOwnCourses(client, 'user-1');
    expect(calls.from).toEqual([['courses']]);
    expect(calls.eq).toEqual([['user_id', 'user-1']]);
  });

  it('fetchOwnCourse scopes by id AND owner', async () => {
    const { client, calls } = makeFakeDb(course);
    await fetchOwnCourse(client, 'user-1', 'course-1');
    expect(calls.eq).toEqual([
      ['id', 'course-1'],
      ['user_id', 'user-1'],
    ]);
  });

  it('createCourse always inserts with the caller as owner', async () => {
    const { client, calls } = makeFakeDb(course);
    await createCourse(client, 'user-1', {
      title: 'Pharmacology',
      term: null,
      institution_name: null,
    });
    expect(calls.insert?.[0]).toEqual([
      { title: 'Pharmacology', term: null, institution_name: null, user_id: 'user-1' },
    ]);
  });

  it('updateOwnCourse scopes the update and strips disallowed fields', async () => {
    const { client, calls } = makeFakeDb(course);
    await updateOwnCourse(client, 'user-1', 'course-1', {
      title: 'Pharm II',
      // @ts-expect-error deliberate privilege-escalation attempt
      user_id: 'attacker',
      id: 'other-course',
    });
    expect(calls.update?.[0]).toEqual([{ title: 'Pharm II' }]);
    expect(calls.eq).toEqual([
      ['id', 'course-1'],
      ['user_id', 'user-1'],
    ]);
  });

  it('deleteOwnCourse scopes the delete to the caller', async () => {
    const { client, calls } = makeFakeDb();
    await deleteOwnCourse(client, 'user-1', 'course-1');
    expect(calls.delete).toHaveLength(1);
    expect(calls.eq).toEqual([
      ['id', 'course-1'],
      ['user_id', 'user-1'],
    ]);
  });
});

describe('sanitizers block privilege escalation', () => {
  it('sanitizeCourseUpdate keeps only allowed fields', () => {
    expect(
      sanitizeCourseUpdate({ title: 'T', status: 'archived', user_id: 'x', role: 'admin' })
    ).toEqual({ title: 'T', status: 'archived' });
  });

  it('sanitizeExamUpdate keeps only allowed fields', () => {
    expect(
      sanitizeExamUpdate({ title: 'T', exam_at: 'iso', weight: 10, course_id: 'other' })
    ).toEqual({ title: 'T', exam_at: 'iso', weight: 10 });
  });
});

describe('modules and exams data access', () => {
  it('createModule inserts under the given course with a sequence', async () => {
    const { client, calls } = makeFakeDb({ id: 'm1' });
    await createModule(client, 'course-1', 'Cardiac', 3);
    expect(calls.from).toEqual([['modules']]);
    expect(calls.insert?.[0]).toEqual([{ course_id: 'course-1', title: 'Cardiac', sequence: 3 }]);
  });

  it('saveModuleOrder writes one sequence per module', async () => {
    const { client, calls } = makeFakeDb();
    await saveModuleOrder(client, [
      { id: 'a', sequence: 0 },
      { id: 'b', sequence: 1 },
    ]);
    expect(calls.update).toEqual([[{ sequence: 0 }], [{ sequence: 1 }]]);
    expect(calls.eq).toEqual([
      ['id', 'a'],
      ['id', 'b'],
    ]);
  });

  it('createExam inserts the exam then its module associations', async () => {
    const { client, calls } = makeFakeDb({ id: 'exam-1', course_id: 'course-1' });
    await createExam(
      client,
      'course-1',
      { title: 'Exam 1', exam_at: '2026-09-04T14:00:00.000Z', weight: null },
      ['m1', 'm2']
    );
    expect(calls.from).toEqual([['exams'], ['exam_modules'], ['exam_modules']]);
    expect(calls.insert?.[0]).toEqual([
      { title: 'Exam 1', exam_at: '2026-09-04T14:00:00.000Z', weight: null, course_id: 'course-1' },
    ]);
    expect(calls.insert?.[1]).toEqual([
      [
        { exam_id: 'exam-1', module_id: 'm1' },
        { exam_id: 'exam-1', module_id: 'm2' },
      ],
    ]);
  });

  it('setExamModules replaces associations (delete then insert)', async () => {
    const { client, calls } = makeFakeDb();
    await setExamModules(client, 'exam-1', ['m1']);
    expect(calls.delete).toHaveLength(1);
    expect(calls.eq?.[0]).toEqual(['exam_id', 'exam-1']);
    expect(calls.insert?.[0]).toEqual([[{ exam_id: 'exam-1', module_id: 'm1' }]]);
  });

  it('setExamModules with no modules only clears associations', async () => {
    const { client, calls } = makeFakeDb();
    await setExamModules(client, 'exam-1', []);
    expect(calls.delete).toHaveLength(1);
    expect(calls.insert).toBeUndefined();
  });
});
