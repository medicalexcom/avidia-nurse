import { fireEvent, render, screen } from '@testing-library/react-native';

import { applyAction, startState } from '@avidia/simulation/src/engine';
import { clientView } from '@avidia/simulation/src/redact';
import { postopPeCase } from '@avidia/simulation/src/cases';

import { bufferedEvents, resetAnalytics } from '../../../lib/analytics';
import { SimulationLibraryScreen } from './SimulationLibraryScreen';
import { SimulationSessionScreen } from './SimulationSessionScreen';
import { SimulationDebriefScreen } from './SimulationDebriefScreen';

/**
 * Simulation UI tests — M11 (spec N/X/Y/AJ/AQ/BE).
 *
 * The views these screens render are produced by the REAL engine + redaction
 * (the executable spec), so what the tests prove about hidden information is
 * exactly what the server enforces: unrevealed findings never reach the
 * screen, vitals show observation-time staleness, resuming renders from the
 * server view, and only the four allowed analytics events fire.
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
const mockRouter = router as unknown as { push: jest.Mock; replace: jest.Mock; back: jest.Mock };

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
jest.mock('../simulationApi', () => ({
  ...jest.requireActual('../simulationApi'),
  listSimulationCases: jest.fn(),
  listOwnSimulationSessions: jest.fn(),
  startSimulation: jest.fn(),
  submitSimulationAction: jest.fn(),
  getSimulationView: jest.fn(),
  abandonSimulation: jest.fn(),
  getSimulationDebrief: jest.fn(),
}));

import * as coursesApi from '../../courses/coursesApi';
import * as simulationApi from '../simulationApi';

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

const caseRow = {
  id: 'case-1',
  case_key: 'postop_pe',
  case_version: 1,
  engine_version: 1,
  status: 'active',
  title: postopPeCase.title,
  description: postopPeCase.description,
  difficulty: 'moderate',
  scenario_type: 'deterioration',
  estimated_duration_minutes: 20,
};

/** Real engine states → real redacted views (the pinned no-leak spec). */
const initialState = startState(postopPeCase);
const initialView = clientView(postopPeCase, initialState);
const afterVitals = applyAction(postopPeCase, initialState, { actionId: 'a_obtain_vitals' });
const afterVitalsView = clientView(postopPeCase, afterVitals.state);
const afterAssess = applyAction(postopPeCase, afterVitals.state, { actionId: 'a_assess_resp' });
const afterAssessView = clientView(postopPeCase, afterAssess.state);

beforeEach(() => {
  jest.clearAllMocks();
  resetAnalytics();
  mocked(coursesApi.fetchOwnCourse).mockResolvedValue(course);
  mocked(simulationApi.listSimulationCases).mockResolvedValue([caseRow]);
  mocked(simulationApi.listOwnSimulationSessions).mockResolvedValue([]);
});

describe('SimulationLibraryScreen', () => {
  it('lists the case library with honest metadata (spec AF)', async () => {
    await render(<SimulationLibraryScreen courseId="course-1" />);
    await screen.findByText(postopPeCase.title);
    expect(screen.getByText(postopPeCase.description)).toBeTruthy();
    expect(screen.getByText(/moderate · deterioration · about 20 min/)).toBeTruthy();
    expect(screen.getByText('Start simulation')).toBeTruthy();
  });

  it('offers Resume when an active session exists (spec X)', async () => {
    mocked(simulationApi.listOwnSimulationSessions).mockResolvedValue([
      {
        id: 'session-1',
        course_id: 'course-1',
        case_id: 'case-1',
        case_version: 1,
        engine_version: 1,
        status: 'active',
        outcome_id: null,
        started_at: '2026-08-14T00:00:00.000Z',
        completed_at: null,
      },
    ]);
    await render(<SimulationLibraryScreen courseId="course-1" />);
    await screen.findByText('Resume simulation');
    expect(screen.queryByText('Start simulation')).toBeNull();
  });

  it('starts a session, records ONLY simulation_started, and navigates (spec BE)', async () => {
    mocked(simulationApi.startSimulation).mockResolvedValue({
      session_id: 'session-1',
      resumed: false,
      status: 'active',
      view: initialView,
    });
    await render(<SimulationLibraryScreen courseId="course-1" />);
    await screen.findByText('Start simulation');
    await fireEvent.press(screen.getByText('Start simulation'));
    await screen.findByText(postopPeCase.title);
    expect(mocked(simulationApi.startSimulation)).toHaveBeenCalledWith(
      expect.anything(),
      'course-1',
      'postop_pe'
    );
    expect(mockRouter.push).toHaveBeenCalledWith('/simulation/session-1');
    expect(bufferedEvents()).toEqual([
      { name: 'simulation_started', caseKey: 'postop_pe', resumed: false },
    ]);
  });
});

describe('SimulationSessionScreen', () => {
  beforeEach(() => {
    mocked(simulationApi.getSimulationView).mockResolvedValue({
      session_id: 'session-1',
      status: 'active',
      started_at: '2026-08-14T00:00:00.000Z',
      completed_at: null,
      view: initialView,
    });
  });

  it('renders the chart from the server view and hides unobserved vitals (spec N/M)', async () => {
    await render(<SimulationSessionScreen sessionId="session-1" />);
    await screen.findByText(/Mr\. Ortiz, 54/);
    expect(screen.getByText(/No vitals on the chart yet/)).toBeTruthy();
    // Hidden findings (present but unrevealed) never reach the screen.
    expect(screen.queryByText(/calf is swollen/)).toBeNull();
    expect(screen.queryByText(/Acute dyspnea at rest/)).toBeNull();
    // The action catalog is the case's controlled list (spec F).
    expect(screen.getByText(/Focused respiratory assessment \(2 min\)/)).toBeTruthy();
  });

  it('submits an action with a fresh idempotency key and updates the chart (spec Y)', async () => {
    mocked(simulationApi.submitSimulationAction).mockResolvedValue({
      rejected: null,
      events: afterVitals.events.filter((e) => e.visible),
      view: afterVitalsView,
    });
    await render(<SimulationSessionScreen sessionId="session-1" />);
    await screen.findByText(/Mr\. Ortiz, 54/);
    await fireEvent.press(screen.getByText(/Obtain a full set of vital signs/));
    await screen.findByText(/Taken at 2 min/);
    const call = mocked(simulationApi.submitSimulationAction).mock.calls[0];
    expect(call[2]).toBe('a_obtain_vitals');
    expect(typeof call[4]).toBe('string');
    expect(call[4].length).toBeGreaterThanOrEqual(32);
    // SpO2 87% now on the chart (true initial vitals at observation time).
    expect(screen.getByText('87 %')).toBeTruthy();
  });

  it('marks an old vitals set as stale instead of silently updating it (spec M)', async () => {
    mocked(simulationApi.getSimulationView).mockResolvedValue({
      session_id: 'session-1',
      status: 'active',
      started_at: '2026-08-14T00:00:00.000Z',
      completed_at: null,
      view: afterAssessView, // vitals taken at t=2, now t=4
    });
    await render(<SimulationSessionScreen sessionId="session-1" />);
    await screen.findByText(/this set is not current/);
    // The revealed respiratory findings ARE now documented.
    expect(screen.getByText(/Acute dyspnea at rest/)).toBeTruthy();
  });

  it('renders the completion banner and records simulation_completed (spec AP/BE)', async () => {
    let state = initialState;
    for (const actionId of [
      'a_assess_resp',
      'a_obtain_vitals',
      'a_apply_o2',
      'a_notify_provider',
      'a_wait',
    ]) {
      state = applyAction(postopPeCase, state, { actionId }).state;
    }
    const final = applyAction(postopPeCase, state, { actionId: 'a_reassess' });
    mocked(simulationApi.submitSimulationAction).mockResolvedValue({
      rejected: null,
      events: final.events.filter((e) => e.visible),
      view: clientView(postopPeCase, final.state),
    });
    await render(<SimulationSessionScreen sessionId="session-1" />);
    await screen.findByText(/Mr\. Ortiz, 54/);
    await fireEvent.press(screen.getByText(/Reassess the patient/));
    await screen.findByText('Patient stabilized');
    expect(screen.getByText('View your debrief')).toBeTruthy();
    // Actions are gone once completed (spec BB: completed sessions are final).
    expect(screen.queryByText('What do you do?')).toBeNull();
    expect(bufferedEvents()).toEqual([
      {
        name: 'simulation_completed',
        caseKey: 'postop_pe',
        outcomeKind: 'stabilized',
        durationMinutes: 17,
      },
    ]);
  });

  it('abandoning requires an explicit second tap and records simulation_abandoned', async () => {
    mocked(simulationApi.abandonSimulation).mockResolvedValue(undefined);
    await render(<SimulationSessionScreen sessionId="session-1" />);
    await screen.findByText('Leave simulation');
    await fireEvent.press(screen.getByText('Leave simulation'));
    expect(mocked(simulationApi.abandonSimulation)).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByText('Tap again to leave without finishing'));
    expect(mocked(simulationApi.abandonSimulation)).toHaveBeenCalled();
    expect(bufferedEvents()).toEqual([{ name: 'simulation_abandoned', caseKey: 'postop_pe' }]);
  });
});

describe('SimulationDebriefScreen', () => {
  it('shows outcome, dimension scores, missed cues, and the timeline replay (spec AQ/AR)', async () => {
    mocked(simulationApi.getSimulationDebrief).mockResolvedValue({
      session_id: 'session-1',
      case: {
        caseKey: 'postop_pe',
        title: postopPeCase.title,
        caseVersion: 1,
        engineVersion: 1,
        difficulty: 'moderate',
        scenarioType: 'deterioration',
      },
      outcome: {
        outcomeId: 'o_stabilized',
        label: 'Patient stabilized',
        kind: 'stabilized',
        summary: 'Oxygen was applied early and the provider was notified promptly.',
        atMinutes: 17,
      },
      durationMinutes: 17,
      score: {
        algorithmVersion: 1,
        earned: 15,
        possible: 22,
        dimensions: {
          recognize_cues: { earned: 4, possible: 4 },
          analyze_cues: { earned: 0, possible: 2 },
          prioritize_hypotheses: { earned: 2, possible: 2 },
          generate_solutions: { earned: 2, possible: 2 },
          take_action: { earned: 6, possible: 6 },
          evaluate_outcomes: { earned: 1, possible: 6 },
        },
        entries: [
          {
            id: 's_cue_calf',
            dimension: 'analyze_cues',
            points: 2,
            earned: false,
            label:
              'Connected the respiratory event to its likely source by assessing the legs (DVT).',
          },
        ],
        missedCriticalActions: [],
        unsafeActionsTaken: [],
      },
      timeline: [
        {
          seq: 1,
          actionId: 'a_assess_resp',
          label: 'Focused respiratory assessment',
          params: {},
          rejected: null,
          atMinutes: 2,
          events: [
            {
              type: 'finding_revealed',
              text: 'Acute dyspnea at rest; speaking in short sentences.',
            },
            {
              type: 'rule_fired',
              description:
                'Beginning a focused assessment moved the encounter into the assessment phase.',
            },
          ],
        },
      ],
      keyCues: [
        {
          id: 'f_dyspnea',
          system: 'respiratory',
          text: 'Acute dyspnea at rest; speaking in short sentences.',
          revealed: true,
        },
        {
          id: 'f_calf_swelling',
          system: 'peripheral_vascular',
          text: 'Right calf is swollen, warm, and tender compared to the left.',
          revealed: false,
        },
      ],
      missedCriticalActions: [],
      unsafeActionsTaken: [],
      evidence: [
        {
          conceptId: 'concept-1',
          conceptName: 'Pulmonary embolism',
          isCorrect: true,
          masteryBefore: 0.4,
          masteryAfter: 0.55,
        },
      ],
      recommendations: ['Virchow’s triad and postoperative VTE risk'],
    });
    await render(<SimulationDebriefScreen sessionId="session-1" />);
    await screen.findByText('Patient stabilized');
    expect(screen.getByText('15 / 22 points')).toBeTruthy();
    expect(screen.getByText('Analyze cues')).toBeTruthy();
    expect(screen.getByText(/Not found: Right calf is swollen/)).toBeTruthy();
    expect(screen.getByText(/2 min — Focused respiratory assessment/)).toBeTruthy();
    // Hidden mechanics are revealed here — and only here (spec AR/AS).
    expect(screen.getByText(/Behind the scenes: Beginning a focused assessment/)).toBeTruthy();
    expect(screen.getByText(/Pulmonary embolism: 40% → 55%/)).toBeTruthy();
    expect(screen.getByText(/Virchow’s triad/)).toBeTruthy();
  });

  it('explains when a debrief is not yet available', async () => {
    mocked(simulationApi.getSimulationDebrief).mockRejectedValue(new Error('active'));
    await render(<SimulationDebriefScreen sessionId="session-1" />);
    await screen.findByText(/only available after a simulation is completed/);
  });
});
