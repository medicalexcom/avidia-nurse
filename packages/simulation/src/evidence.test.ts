/**
 * Simulation → M8 evidence tests (spec T/U): one mastery model, bounded
 * deterministic evidence, no parallel "simulation mastery".
 */

import { applyAction, startState } from './engine';
import { EVIDENCE_CORRECT_THRESHOLD, simulationEvidence } from './evidence';
import { scoreSession } from './score';
import { postopPeCase } from './cases';
import type { PatientState, SimulationEvent } from './types';

const COMPLETED_AT = '2026-08-13T12:00:00.000Z';

function scoreRun(actionIds: string[]) {
  let state: PatientState = startState(postopPeCase);
  const events: SimulationEvent[] = [];
  for (const actionId of actionIds) {
    const result = applyAction(postopPeCase, state, { actionId });
    if (result.rejected) break;
    state = result.state;
    events.push(...result.events);
  }
  return scoreSession(postopPeCase, state, events as unknown as Array<Record<string, unknown>>);
}

const OPTIMAL = [
  'a_assess_resp',
  'a_obtain_vitals',
  'a_apply_o2',
  'a_notify_provider',
  'a_wait',
  'a_reassess',
];

describe('simulationEvidence', () => {
  it('produces one PerformanceEvent per mapped concept, in M8 shape (spec U)', () => {
    const items = simulationEvidence(postopPeCase, scoreRun(OPTIMAL), COMPLETED_AT);
    expect(items.map((i) => i.conceptKey)).toEqual([
      'pulmonary embolism',
      'oxygen therapy',
      'clinical deterioration',
    ]);
    for (const item of items) {
      expect(item.event).toEqual({
        isCorrect: expect.any(Boolean),
        difficulty: expect.any(String),
        cognitiveLevel: expect.any(String),
        confidence: null,
        answeredAt: COMPLETED_AT,
      });
      expect(item.possible).toBeGreaterThan(0);
    }
  });

  it('marks a concept correct when the earned ratio meets the threshold', () => {
    const items = simulationEvidence(postopPeCase, scoreRun(OPTIMAL), COMPLETED_AT);
    for (const item of items) {
      expect(item.event.isCorrect).toBe(item.earned / item.possible >= EVIDENCE_CORRECT_THRESHOLD);
    }
    // The optimal run is strong evidence for every mapped concept.
    expect(items.every((i) => i.event.isCorrect)).toBe(true);
  });

  it('marks concepts incorrect after a failed session', () => {
    const items = simulationEvidence(postopPeCase, scoreRun(Array(8).fill('a_wait')), COMPLETED_AT);
    expect(items.every((i) => i.event.isCorrect)).toBe(false);
  });

  it('is deterministic: same session, same evidence', () => {
    const a = simulationEvidence(postopPeCase, scoreRun(OPTIMAL), COMPLETED_AT);
    const b = simulationEvidence(postopPeCase, scoreRun(OPTIMAL), COMPLETED_AT);
    expect(a).toEqual(b);
  });

  it('yields no evidence for concepts whose dimensions carry no points', () => {
    const caseDef = {
      ...postopPeCase,
      conceptMappings: [
        {
          conceptName: 'Pointless concept',
          conceptKey: 'pointless concept',
          difficulty: 'easy' as const,
          cognitiveLevel: 'recall' as const,
          dimensions: ['analyze_cues' as const],
        },
      ],
      scoring: postopPeCase.scoring.filter((s) => s.dimension !== 'analyze_cues'),
    };
    const score = scoreSession(caseDef, startState(caseDef), []);
    expect(simulationEvidence(caseDef, score, COMPLETED_AT)).toEqual([]);
  });
});
