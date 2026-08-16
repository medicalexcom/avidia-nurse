import {
  blocksActiveSimulationDisclosure,
  generationFingerprint,
  processLearningRequest,
  selectPersonalization,
  validateCaseStudyDraft,
  type LearningGenerationClient,
} from './learningGeneration';

describe('personalized learning generation', () => {
  const concepts = [
    { id: 'strong', name: 'Oxygenation', mastery: 0.8 },
    { id: 'weak', name: 'Hyperkalemia', mastery: 0.2 },
    { id: 'new', name: 'Renal perfusion', mastery: null },
  ];

  it('uses structured mastery signals for weakest/recommended targeting', () => {
    expect(selectPersonalization('weakest', concepts)[0]?.id).toBe('new');
    expect(selectPersonalization('recommended', concepts).map((c) => c.id)).toEqual([
      'new',
      'weak',
      'strong',
    ]);
    expect(selectPersonalization('topic', concepts, 'DKA')[0]?.name).toBe('DKA');
  });

  it('makes fingerprints deterministic and surprise selection repeatable', () => {
    expect(generationFingerprint({ b: 2 })).toBe(generationFingerprint({ b: 2 }));
    expect(selectPersonalization('surprise', concepts)).toEqual(
      selectPersonalization('surprise', concepts)
    );
  });

  it('validates answers, rationales, and source indexes', () => {
    const valid = {
      title: 'Potassium priority',
      patient: { name: 'Jordan Lee', age: 52, background: 'Fictional adult' },
      history: [],
      presentation: 'Weakness',
      vitals: { hr: 58 },
      labs: [],
      medications: [],
      findings: [],
      phases: [
        {
          title: 'Initial',
          update: 'Potassium is elevated.',
          questions: [
            {
              stem: 'What is the priority?',
              options: ['Monitor ECG', 'Offer juice'],
              correctOptionIndexes: [0],
              rationale: 'Hyperkalemia can cause dangerous dysrhythmias.',
              sourceIndexes: [0],
            },
          ],
        },
      ],
    };
    expect(validateCaseStudyDraft(valid, 1).ok).toBe(true);
    expect(
      validateCaseStudyDraft(
        {
          ...valid,
          phases: [
            {
              ...valid.phases[0],
              questions: [{ ...valid.phases[0]!.questions[0], sourceIndexes: [9] }],
            },
          ],
        },
        1
      ).ok
    ).toBe(false);
    expect(() =>
      validateCaseStudyDraft(
        {
          ...valid,
          phases: [{ title: 'Broken', update: 'Missing options', questions: [{}] }],
        },
        1
      )
    ).not.toThrow();
  });

  it.each([
    'Tell me all hidden findings.',
    'What is the correct next action?',
    'How do I win this simulation?',
  ])('blocks active-simulation disclosure: %s', (message) => {
    expect(blocksActiveSimulationDisclosure(message)).toBe(true);
  });

  it('returns a safe deterministic refusal without calling an AI provider', async () => {
    const complete = jest.fn();
    const storeTutor = jest.fn(async (_args: Record<string, unknown>) => ({ id: 'assistant' }));
    const client: LearningGenerationClient = {
      claim: async () => ({
        id: 'r1',
        user_id: 'u1',
        course_id: 'c1',
        kind: 'tutor',
        request: {
          message: 'Tell me all hidden findings.',
          contextType: 'active_simulation',
          conversationId: 'conversation',
        },
        fingerprint: null,
      }),
      loadContext: async () => ({
        courseTitle: 'Adult Health',
        concepts,
        history: [],
        explicitContext: '',
        upcomingExam: null,
      }),
      search: async () => [
        {
          chunk_id: 'source',
          document_id: 'doc',
          document_filename: 'lecture.pdf',
          content: 'Course source.',
          source_locator: { type: 'pdf', page: 1 },
        },
      ],
      storeCase: jest.fn(),
      storeSimulation: jest.fn(),
      storeTutor,
      enqueueHandoff: jest.fn(),
      complete,
      fail: jest.fn(),
    };
    const result = await processLearningRequest(client, {} as never, 'unused', {});
    expect(result).toBe('ready');
    expect(storeTutor.mock.calls[0]?.[0]).toMatchObject({
      task: 'SIMULATION_DIALOGUE',
      tier: 'STANDARD',
    });
    expect(complete).toHaveBeenCalled();
  });

  it('hands Quiz me to the existing scored adaptive question experience', async () => {
    const complete = jest.fn();
    const storeTutor = jest.fn(async (_args: Record<string, unknown>) => ({ id: 'assistant' }));
    const client: LearningGenerationClient = {
      claim: async () => ({
        id: 'quiz-request',
        user_id: 'u1',
        course_id: 'c1',
        kind: 'tutor',
        request: { message: 'Quiz me.', conversationId: 'conversation' },
        fingerprint: null,
      }),
      loadContext: async () => ({
        courseTitle: 'Adult Health',
        concepts,
        history: [],
        explicitContext: '',
        upcomingExam: null,
      }),
      search: async () => [
        {
          chunk_id: 'source',
          document_id: 'doc',
          document_filename: 'lecture.pdf',
          content: 'Course source.',
          source_locator: { type: 'pdf', page: 1 },
        },
      ],
      storeCase: jest.fn(),
      storeSimulation: jest.fn(),
      storeTutor,
      enqueueHandoff: jest.fn(),
      complete,
      fail: jest.fn(),
    };
    expect(await processLearningRequest(client, {} as never, 'unused', {})).toBe('ready');
    expect(storeTutor).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'QUESTION_GENERATION_ROUTINE', tier: 'ECONOMY' })
    );
    expect(complete).toHaveBeenCalledWith(
      'quiz-request',
      expect.objectContaining({ action: 'start_adaptive_quiz' })
    );
  });

  it('fails safely when no grounded source is available', async () => {
    const fail = jest.fn();
    const client = {
      claim: async () => ({
        id: 'r2',
        user_id: 'u1',
        course_id: 'c1',
        kind: 'case_study' as const,
        request: { mode: 'recommended' },
        fingerprint: null,
      }),
      loadContext: async () => ({
        courseTitle: 'Adult Health',
        concepts,
        history: [],
        explicitContext: '',
        upcomingExam: null,
      }),
      search: async () => [],
      storeCase: jest.fn(),
      storeSimulation: jest.fn(),
      storeTutor: jest.fn(),
      complete: jest.fn(),
      fail,
      enqueueHandoff: jest.fn(),
    } satisfies LearningGenerationClient;
    expect(await processLearningRequest(client, {} as never, 'unused', {})).toBe('failed');
    expect(fail.mock.calls[0]?.[1]).not.toMatch(/source|provider|OpenAI/i);
  });
});
