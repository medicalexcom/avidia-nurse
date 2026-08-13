import { fireEvent, render, screen } from '@testing-library/react-native';

import { ConceptsScreen } from './ConceptsScreen';
import { ConceptDetailScreen, groupEvidence } from './ConceptDetailScreen';
import type { ConceptDetail, ConceptListRow } from '../conceptsApi';

/**
 * Concept screens tests (M6 spec P/Q/X: UI). Router, auth, supabase and the
 * data-access module are mocked; these tests verify the student-facing flows:
 * emphasis-ordered list, empty state, evidence display grouped by document
 * with human locators, aliases, relationships, and honest not-found handling
 * (a cross-user guessed id renders exactly like a nonexistent one).
 */

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual('react');
  return {
    router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
    useFocusEffect: (cb: () => void) => {
      useEffect(() => {
        cb();
      }, [cb]);
    },
  };
});

import { router } from 'expo-router';
const mockRouter = router as unknown as { push: jest.Mock; replace: jest.Mock };

jest.mock('../../auth/AuthProvider', () => {
  const user = { id: 'user-1', email: 'student@example.com' };
  return { useAuth: () => ({ user }) };
});

jest.mock('../../../lib/supabase', () => ({
  getSupabase: () => ({ mocked: true }),
}));

jest.mock('../../courses/coursesApi', () => ({
  fetchOwnCourse: jest.fn(),
}));
jest.mock('../conceptsApi', () => ({
  listConcepts: jest.fn(),
  fetchConceptDetail: jest.fn(),
}));

import * as coursesApi from '../../courses/coursesApi';
import * as conceptsApi from '../conceptsApi';

const mocked = <T,>(fn: T) => fn as jest.Mock;

const course = {
  id: 'course-1',
  user_id: 'user-1',
  title: 'Adult Health I',
  term: 'Fall 2026',
  institution_name: null,
  status: 'active',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
};

const hyperkalemia: ConceptListRow = {
  id: 'concept-1',
  course_id: 'course-1',
  canonical_name: 'Hyperkalemia',
  concept_type: 'laboratory',
  summary: 'Serum potassium above 5.0 mEq/L; risk of dysrhythmias.',
  status: 'active',
  emphasis_score: 9,
  source_count: 4,
};

const furosemide: ConceptListRow = {
  id: 'concept-2',
  course_id: 'course-1',
  canonical_name: 'Furosemide',
  concept_type: 'medication',
  summary: null,
  status: 'active',
  emphasis_score: 5,
  source_count: 2,
};

const detail: ConceptDetail = {
  concept: hyperkalemia,
  aliases: [{ id: 'alias-1', alias: 'High K+' }],
  evidence: [
    {
      chunk_id: 'chunk-1',
      document_id: 'doc-1',
      document_name: 'Module 2 Electrolytes.pdf',
      locator: { type: 'pptx', slide: 18 },
    },
    {
      chunk_id: 'chunk-2',
      document_id: 'doc-1',
      document_name: 'Module 2 Electrolytes.pdf',
      locator: { type: 'pptx', slide: 21 },
    },
    {
      chunk_id: 'chunk-3',
      document_id: 'doc-2',
      document_name: 'Renal Study Guide.docx',
      locator: null,
    },
  ],
  relationships: [
    {
      id: 'relationship-1',
      relationship_type: 'may_cause',
      other_name: 'Cardiac Dysrhythmia',
      other_id: 'concept-9',
      direction: 'outgoing',
    },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  mocked(coursesApi.fetchOwnCourse).mockResolvedValue(course);
});

describe('ConceptsScreen', () => {
  it('shows the empty state before any concepts are extracted', async () => {
    mocked(conceptsApi.listConcepts).mockResolvedValue([]);
    await render(<ConceptsScreen courseId="course-1" />);
    await screen.findByText(/No concepts identified yet/);
  });

  it('lists concepts with type labels and source counts, and opens the detail', async () => {
    mocked(conceptsApi.listConcepts).mockResolvedValue([hyperkalemia, furosemide]);
    await render(<ConceptsScreen courseId="course-1" />);
    await screen.findByText('Hyperkalemia');
    expect(screen.getByText('Laboratory')).toBeTruthy();
    expect(screen.getByText('Medication')).toBeTruthy();
    expect(screen.getByText('Found in 4 places in your materials')).toBeTruthy();
    expect(screen.getByText('Found in 2 places in your materials')).toBeTruthy();

    await fireEvent.press(screen.getByText('Hyperkalemia'));
    expect(mockRouter.push).toHaveBeenCalledWith('/course/course-1/concept/concept-1');
  });

  it('shows an honest error with a way back when loading fails', async () => {
    mocked(conceptsApi.listConcepts).mockRejectedValue(new Error('network'));
    await render(<ConceptsScreen courseId="course-1" />);
    await screen.findByText('We could not load the concepts. Please try again.');
    expect(screen.getByText('Back to courses')).toBeTruthy();
  });
});

describe('ConceptDetailScreen', () => {
  it('shows the concept with aliases and evidence grouped by document (spec Q)', async () => {
    mocked(conceptsApi.fetchConceptDetail).mockResolvedValue(detail);
    await render(<ConceptDetailScreen courseId="course-1" conceptId="concept-1" />);
    await screen.findByText('Hyperkalemia');
    expect(screen.getByText('Also called: High K+')).toBeTruthy();
    expect(screen.getByText('Found in your materials')).toBeTruthy();
    expect(screen.getByText('Module 2 Electrolytes.pdf')).toBeTruthy();
    expect(screen.getByText('slide 18; slide 21')).toBeTruthy();
    expect(screen.getByText('Renal Study Guide.docx')).toBeTruthy();
  });

  it('shows material-supported relationships and navigates between concepts', async () => {
    mocked(conceptsApi.fetchConceptDetail).mockResolvedValue(detail);
    await render(<ConceptDetailScreen courseId="course-1" conceptId="concept-1" />);
    await screen.findByText('Related concepts in this course');
    expect(screen.getByText('Hyperkalemia may cause Cardiac Dysrhythmia')).toBeTruthy();

    await fireEvent.press(screen.getByText('Open Cardiac Dysrhythmia'));
    expect(mockRouter.push).toHaveBeenCalledWith('/course/course-1/concept/concept-9');
  });

  it('treats a guessed or foreign concept id exactly like not-found (spec R)', async () => {
    mocked(conceptsApi.fetchConceptDetail).mockResolvedValue(null);
    await render(<ConceptDetailScreen courseId="course-1" conceptId="someone-elses-id" />);
    await screen.findByText('This concept could not be found.');
    expect(screen.getByText('Back to concepts')).toBeTruthy();
  });
});

describe('groupEvidence', () => {
  it('groups by document and deduplicates repeated locations', () => {
    const groups = groupEvidence([
      ...detail.evidence,
      {
        chunk_id: 'chunk-4',
        document_id: 'doc-1',
        document_name: 'Module 2 Electrolytes.pdf',
        locator: { type: 'pptx', slide: 18 }, // duplicate location
      },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({
      documentId: 'doc-1',
      documentName: 'Module 2 Electrolytes.pdf',
      locations: ['slide 18', 'slide 21'],
    });
    expect(groups[1]!.locations).toEqual(['in this document']);
  });
});
