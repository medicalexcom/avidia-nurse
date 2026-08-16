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

  it('answers tutor questions from general knowledge, honestly labeled, when no course source matches', async () => {
    // Regression test for the Ask Avidia bug: a tutor request used to hard
    // -fail (and never produce an assistant message) whenever retrieval
    // found zero course-grounded chunks, even though the student still
    // deserves an answer. case_study/simulation must still require sources
    // (see "fails safely when no grounded source is available" below).
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ answer: 'HIV progresses to AIDS.' }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    })) as unknown as typeof fetch;
    try {
      const complete = jest.fn();
      const fail = jest.fn();
      const storeTutor = jest.fn(async (_args: Record<string, unknown>) => ({ id: 'assistant' }));
      const client: LearningGenerationClient = {
        claim: async () => ({
          id: 'r3',
          user_id: 'u1',
          course_id: 'c1',
          kind: 'tutor',
          request: { message: 'when does HIV is considered AIDS?', conversationId: 'conversation' },
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
        storeTutor,
        enqueueHandoff: jest.fn(),
        complete,
        fail,
      };
      const result = await processLearningRequest(client, {} as never, 'test-key', {});
      expect(result).toBe('ready');
      expect(fail).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalled();
      const stored = storeTutor.mock.calls[0]?.[0] as { content: string; sources: unknown[] };
      expect(stored.sources).toEqual([]);
      expect(stored.content).toMatch(/general nursing knowledge/i);
      expect(stored.content).toMatch(/HIV progresses to AIDS/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('sends OpenAI messages that contain the word "json" for every json_object request', async () => {
    // Regression test for a live-only bug: OpenAI's chat completions API
    // rejects response_format: { type: 'json_object' } with an HTTP 400
    // unless the literal word "json" appears somewhere in `messages`. The
    // tutor system prompt used to describe the required shape
    // (`{"answer":"..."}`) without ever using the word "json", so every
    // real tutor call failed while this suite's mocked fetch (which never
    // validates the request body) stayed green. Assert on the actual
    // request payload so this class of bug cannot hide behind a mock again.
    const originalFetch = global.fetch;
    const seenBodies: Array<{ messages: Array<{ content: string }>; response_format?: unknown }> =
      [];
    global.fetch = jest.fn(async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body);
      seenBodies.push(body);
      return {
        ok: true,
        json: async () => ({
          choices: [
            { message: { content: JSON.stringify({ answer: 'AIDS is diagnosed when...' }) } },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      };
    }) as unknown as typeof fetch;
    try {
      const client: LearningGenerationClient = {
        claim: async () => ({
          id: 'r-json-mode',
          user_id: 'u1',
          course_id: 'c1',
          kind: 'tutor',
          request: { message: 'when does HIV is considered AIDS?', conversationId: 'conversation' },
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
        storeTutor: jest.fn(async () => ({ id: 'assistant' })),
        enqueueHandoff: jest.fn(),
        complete: jest.fn(),
        fail: jest.fn(),
      };
      const result = await processLearningRequest(client, {} as never, 'test-key', {});
      expect(result).toBe('ready');
      expect(seenBodies.length).toBeGreaterThan(0);
      for (const body of seenBodies) {
        if ((body.response_format as { type?: string } | undefined)?.type !== 'json_object')
          continue;
        const combined = body.messages.map((m) => m.content).join('\n');
        expect(combined.toLowerCase()).toContain('json');
      }
    } finally {
      global.fetch = originalFetch;
    }
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
