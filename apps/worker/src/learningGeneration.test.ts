import {
  blocksActiveSimulationDisclosure,
  buildTutorQuery,
  classifyGrounding,
  generationFingerprint,
  GROUNDING_SIMILARITY_FLOOR,
  processLearningRequest,
  refineSyllabusConcepts,
  selectPersonalization,
  validateCaseStudyDraft,
  validateSyllabusConceptDraft,
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
          similarity: 0.9,
        },
      ],
      storeCase: jest.fn(),
      storeSimulation: jest.fn(),
      storeTutor,
      enqueueHandoff: jest.fn(),
      recoverStale: jest.fn(),
      applySyllabusConcepts: jest.fn(),
      applyOndemandQuestions: jest.fn(),
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
          similarity: 0.9,
        },
      ],
      storeCase: jest.fn(),
      storeSimulation: jest.fn(),
      storeTutor,
      enqueueHandoff: jest.fn(),
      recoverStale: jest.fn(),
      applySyllabusConcepts: jest.fn(),
      applyOndemandQuestions: jest.fn(),
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
        recoverStale: jest.fn(),
        applySyllabusConcepts: jest.fn(),
        applyOndemandQuestions: jest.fn(),
        complete,
        fail,
      };
      const result = await processLearningRequest(client, {} as never, 'test-key', {});
      expect(result).toBe('ready');
      expect(fail).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalled();
      const stored = storeTutor.mock.calls[0]?.[0] as { content: string; sources: unknown[] };
      expect(stored.sources).toEqual([]);
      expect(stored.content).toMatch(/general nursing\/medical knowledge/i);
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
        recoverStale: jest.fn(),
        applySyllabusConcepts: jest.fn(),
        applyOndemandQuestions: jest.fn(),
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

  it('authors a general-nursing case study instead of hard-failing when the course has no relevant source (spec: course-first fallback applies to case_study/simulation too)', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: 'Managing hyperkalemia',
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
                        sourceIndexes: [],
                      },
                    ],
                  },
                ],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    })) as unknown as typeof fetch;
    try {
      const storeCase = jest.fn(async (_args: Record<string, unknown>) => ({ id: 'case-1' }));
      const complete = jest.fn();
      const fail = jest.fn();
      const client: LearningGenerationClient = {
        claim: async () => ({
          id: 'r2',
          user_id: 'u1',
          course_id: 'c1',
          kind: 'case_study',
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
        storeCase,
        storeSimulation: jest.fn(),
        storeTutor: jest.fn(),
        complete,
        fail,
        enqueueHandoff: jest.fn(),
        recoverStale: jest.fn(),
        applySyllabusConcepts: jest.fn(),
        applyOndemandQuestions: jest.fn(),
      };
      expect(await processLearningRequest(client, {} as never, 'test-key', {})).toBe('ready');
      expect(fail).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalled();
      expect(storeCase.mock.calls[0]?.[0]).toMatchObject({
        grounding: 'general_nursing_knowledge',
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('still fails safely (generic message, no provider detail) when generation is genuinely unrecoverable', async () => {
    const originalFetch = global.fetch;
    // Every attempt (initial + the one bounded repair) returns the same
    // structurally invalid draft (no title, no phases), so it can never
    // pass validation — this must still fail safely, distinct from the
    // "no relevant source" case above, which must now succeed.
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ title: '', phases: [] }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    })) as unknown as typeof fetch;
    try {
      const fail = jest.fn();
      const complete = jest.fn();
      const client: LearningGenerationClient = {
        claim: async () => ({
          id: 'r2b',
          user_id: 'u1',
          course_id: 'c1',
          kind: 'case_study',
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
        complete,
        fail,
        enqueueHandoff: jest.fn(),
        recoverStale: jest.fn(),
        applySyllabusConcepts: jest.fn(),
        applyOndemandQuestions: jest.fn(),
      };
      expect(await processLearningRequest(client, {} as never, 'test-key', {})).toBe('failed');
      expect(complete).not.toHaveBeenCalled();
      expect(fail.mock.calls[0]?.[1]).not.toMatch(/source|provider|OpenAI/i);
    } finally {
      global.fetch = originalFetch;
    }
  });

  describe('deterministic grounding classification (spec: "Retrieved ≠ supporting")', () => {
    it('is COURSE_GROUNDED only when every retrieved chunk clears the relevance floor', () => {
      const result = classifyGrounding([
        {
          chunk_id: 'a',
          document_id: 'd',
          document_filename: 'f',
          content: 'x',
          source_locator: { type: 'pdf' },
          similarity: 0.9,
        },
        {
          chunk_id: 'b',
          document_id: 'd',
          document_filename: 'f',
          content: 'y',
          source_locator: { type: 'pdf' },
          similarity: GROUNDING_SIMILARITY_FLOOR,
        },
      ]);
      expect(result.mode).toBe('course_grounded');
      expect(result.relevantSources).toHaveLength(2);
    });

    it('is GENERAL_KNOWLEDGE when retrieval only surfaced off-topic chunks (the live HIV/hypocretin case)', () => {
      const result = classifyGrounding([
        {
          chunk_id: 'a',
          document_id: 'd',
          document_filename: 'f',
          content: 'Hypocretins and orexins regulate sleep.',
          source_locator: { type: 'pdf' },
          similarity: 0.18,
        },
        {
          chunk_id: 'b',
          document_id: 'd',
          document_filename: 'f',
          content: 'Parosmia and presbycusis.',
          source_locator: { type: 'pdf' },
          similarity: 0.12,
        },
      ]);
      expect(result.mode).toBe('general_knowledge');
      expect(result.relevantSources).toHaveLength(0);
    });

    it('is MIXED when only some retrieved chunks are relevant', () => {
      const result = classifyGrounding([
        {
          chunk_id: 'a',
          document_id: 'd',
          document_filename: 'f',
          content: 'relevant',
          source_locator: { type: 'pdf' },
          similarity: 0.8,
        },
        {
          chunk_id: 'b',
          document_id: 'd',
          document_filename: 'f',
          content: 'irrelevant',
          source_locator: { type: 'pdf' },
          similarity: 0.1,
        },
      ]);
      expect(result.mode).toBe('mixed');
      expect(result.relevantSources.map((s) => s.chunk_id)).toEqual(['a']);
    });
  });

  describe('tutor follow-up query retention (spec: "Go deeper" must stay on topic)', () => {
    it('passes a substantive question through unchanged', () => {
      expect(buildTutorQuery('When is HIV considered AIDS?', [])).toBe(
        'When is HIV considered AIDS?'
      );
    });

    it('combines a bare follow-up preset with the last substantive student question', () => {
      const history = [
        { role: 'user', content: 'When is HIV considered AIDS?' },
        { role: 'assistant', content: 'HIV is classified as AIDS once CD4 falls below 200.' },
      ];
      expect(buildTutorQuery('Go deeper.', history)).toBe(
        'When is HIV considered AIDS? Go deeper.'
      );
    });

    it('skips over other generic follow-ups to find the real question', () => {
      const history = [
        { role: 'user', content: 'When is HIV considered AIDS?' },
        { role: 'assistant', content: 'HIV is classified as AIDS once CD4 falls below 200.' },
        { role: 'user', content: 'Simplify.' },
        { role: 'assistant', content: 'AIDS = HIV plus a very low CD4 count.' },
      ];
      expect(buildTutorQuery('Go deeper.', history)).toBe(
        'When is HIV considered AIDS? Go deeper.'
      );
    });
  });

  it('never refuses on an HIV/AIDS question that only retrieves off-topic course chunks — answers from general knowledge and discloses it, without displaying the irrelevant chunks as grounding', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                answer: 'HIV is classified as AIDS once the CD4 count falls below 200 cells/mm3.',
              }),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    })) as unknown as typeof fetch;
    try {
      const storeTutor = jest.fn(async (_args: Record<string, unknown>) => ({ id: 'assistant' }));
      const complete = jest.fn();
      const fail = jest.fn();
      const client: LearningGenerationClient = {
        claim: async () => ({
          id: 'r-hiv',
          user_id: 'u1',
          course_id: 'c1',
          kind: 'tutor',
          request: { message: 'When is HIV considered AIDS?', conversationId: 'conversation' },
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
            chunk_id: 'off-topic-1',
            document_id: 'doc',
            document_filename: 'sleep.pdf',
            content: 'Hypocretins (orexins) regulate wakefulness.',
            source_locator: { type: 'pdf', page: 4 },
            similarity: 0.15,
          },
          {
            chunk_id: 'off-topic-2',
            document_id: 'doc',
            document_filename: 'ent.pdf',
            content: 'Parosmia and presbycusis are disorders of smell and hearing.',
            source_locator: { type: 'pdf', page: 9 },
            similarity: 0.1,
          },
        ],
        storeCase: jest.fn(),
        storeSimulation: jest.fn(),
        storeTutor,
        enqueueHandoff: jest.fn(),
        recoverStale: jest.fn(),
        applySyllabusConcepts: jest.fn(),
        applyOndemandQuestions: jest.fn(),
        complete,
        fail,
      };
      const result = await processLearningRequest(client, {} as never, 'test-key', {});
      expect(result).toBe('ready');
      expect(fail).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalled();
      const stored = storeTutor.mock.calls[0]?.[0] as {
        content: string;
        sources: unknown[];
        grounding: string;
      };
      // Never shown as "grounded" — the retrieved chunks were about sleep
      // and ENT disorders, not HIV/AIDS.
      expect(stored.sources).toEqual([]);
      expect(stored.grounding).toBe('general_knowledge');
      expect(stored.content).toMatch(/general nursing\/medical knowledge/i);
      expect(stored.content).toMatch(/CD4/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('retrieves using the prior substantive question, not the bare preset text, on "Go deeper."', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ answer: 'Deeper mechanism...' }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    })) as unknown as typeof fetch;
    try {
      const search = jest.fn(async () => []);
      const client: LearningGenerationClient = {
        claim: async () => ({
          id: 'r-deeper',
          user_id: 'u1',
          course_id: 'c1',
          kind: 'tutor',
          request: { message: 'Go deeper.', conversationId: 'conversation' },
          fingerprint: null,
        }),
        loadContext: async () => ({
          courseTitle: 'Adult Health',
          concepts,
          history: [
            { role: 'user', content: 'When is HIV considered AIDS?' },
            { role: 'assistant', content: 'HIV is classified as AIDS once CD4 falls below 200.' },
          ],
          explicitContext: '',
          upcomingExam: null,
        }),
        search,
        storeCase: jest.fn(),
        storeSimulation: jest.fn(),
        storeTutor: jest.fn(async () => ({ id: 'assistant' })),
        enqueueHandoff: jest.fn(),
        recoverStale: jest.fn(),
        applySyllabusConcepts: jest.fn(),
        applyOndemandQuestions: jest.fn(),
        complete: jest.fn(),
        fail: jest.fn(),
      };
      expect(await processLearningRequest(client, {} as never, 'test-key', {})).toBe('ready');
      expect(search).toHaveBeenCalledWith('c1', 'When is HIV considered AIDS? Go deeper.');
    } finally {
      global.fetch = originalFetch;
    }
  });

  describe('"Why was I wrong?" requires question-attempt context', () => {
    it('answers with guidance instead of a meaningless evaluation when no questionId is present, without calling the AI provider', async () => {
      const fetchSpy = jest.fn();
      const originalFetch = global.fetch;
      global.fetch = fetchSpy as unknown as typeof fetch;
      try {
        const storeTutor = jest.fn(async (_args: Record<string, unknown>) => ({ id: 'assistant' }));
        const complete = jest.fn();
        const client: LearningGenerationClient = {
          claim: async () => ({
            id: 'r-wrong-no-ctx',
            user_id: 'u1',
            course_id: 'c1',
            kind: 'tutor',
            request: { message: 'Why was I wrong?', conversationId: 'conversation' },
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
          recoverStale: jest.fn(),
          applySyllabusConcepts: jest.fn(),
          applyOndemandQuestions: jest.fn(),
          complete,
          fail: jest.fn(),
        };
        expect(await processLearningRequest(client, {} as never, 'test-key', {})).toBe('ready');
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(complete).toHaveBeenCalled();
        expect(storeTutor.mock.calls[0]?.[0]).toMatchObject({
          task: 'RAG_ANSWER',
          grounding: 'general_knowledge',
        });
        const content = (storeTutor.mock.calls[0]?.[0] as { content: string }).content;
        expect(content).toMatch(/question's review screen/i);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('routes to CLINICAL_REASONING_EVALUATION when question-attempt context is present', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ answer: 'You missed...' }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      })) as unknown as typeof fetch;
      try {
        const storeTutor = jest.fn(async (_args: Record<string, unknown>) => ({ id: 'assistant' }));
        const client: LearningGenerationClient = {
          claim: async () => ({
            id: 'r-wrong-ctx',
            user_id: 'u1',
            course_id: 'c1',
            kind: 'tutor',
            request: {
              message: 'Why was I wrong?',
              conversationId: 'conversation',
              questionId: 'question-1',
            },
            fingerprint: null,
          }),
          loadContext: async () => ({
            courseTitle: 'Adult Health',
            concepts,
            history: [],
            explicitContext: 'Submitted question review context: ...',
            upcomingExam: null,
          }),
          search: async () => [],
          storeCase: jest.fn(),
          storeSimulation: jest.fn(),
          storeTutor,
          enqueueHandoff: jest.fn(),
          recoverStale: jest.fn(),
          applySyllabusConcepts: jest.fn(),
          applyOndemandQuestions: jest.fn(),
          complete: jest.fn(),
          fail: jest.fn(),
        };
        expect(await processLearningRequest(client, {} as never, 'test-key', {})).toBe('ready');
        expect(storeTutor.mock.calls[0]?.[0]).toMatchObject({
          task: 'CLINICAL_REASONING_EVALUATION',
        });
      } finally {
        global.fetch = originalFetch;
      }
    });
  });
});

describe('question_set (no-upload question generation)', () => {
  // Matches @avidia/assessment's RawGeneratedQuestion schema exactly — chunk
  // indexes are always empty here since chunkCount is 0 for this kind
  // (nothing was ever retrieved to cite).
  const rawQuestion = (conceptKey: string) => ({
    question_type: 'single_best_answer',
    stem: `The nurse is caring for a client with findings consistent with ${conceptKey}. What is the priority action?`,
    difficulty: 'moderate',
    cognitive_level: 'application',
    concept_key: conceptKey,
    priority_frameworks: ['safety'],
    rationale:
      'Verifying current status directs every subsequent intervention safely and correctly.',
    options: [
      {
        text: 'Reassess the client now',
        is_correct: true,
        correct_position: null,
        rationale: 'Correct: current data first.',
      },
      {
        text: 'Chart later in the shift',
        is_correct: false,
        correct_position: null,
        rationale: 'Delays needed action.',
      },
      {
        text: 'Ask a peer to check in an hour',
        is_correct: false,
        correct_position: null,
        rationale: 'Not the nurse’s priority delegation.',
      },
    ],
    expected_value: null,
    tolerance: null,
    answer_unit: null,
    rounding_note: null,
    chunk_indexes: [],
  });

  function fetchSequence(
    bodies: unknown[],
    seenRequestBodies?: Array<{ messages: Array<{ content: string }>; response_format?: unknown }>
  ): typeof fetch {
    let call = 0;
    return jest.fn(async (_url: unknown, init: unknown) => {
      if (seenRequestBodies) {
        seenRequestBodies.push(JSON.parse((init as { body: string }).body));
      }
      const content = bodies[Math.min(call, bodies.length - 1)];
      call += 1;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(content) } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      };
    }) as unknown as typeof fetch;
  }

  it('proposes a syllabus concept list from the course title, then generates general-knowledge questions, when the course has no concepts yet', async () => {
    const originalFetch = global.fetch;
    // Regression test for the same live-only bug documented on the tutor
    // suite above: OpenAI's response_format: { type: 'json_object' } is
    // rejected with an HTTP 400 unless the literal word "json" appears
    // somewhere in `messages`. The syllabus-concept and on-demand-question
    // system prompts both use json_object mode (via openAiJson/
    // generateValidated), so both request bodies below are asserted on
    // directly — a mock that only returns canned content, and never
    // inspects what was actually sent, let exactly this bug through once
    // already (the on-demand-question prompt shipped without the word
    // "json" anywhere in it, and every real request failed on both the
    // primary and fallback model while this suite stayed green).
    const seenRequestBodies: Array<{
      messages: Array<{ content: string }>;
      response_format?: unknown;
    }> = [];
    global.fetch = fetchSequence(
      [
        {
          concepts: [
            { name: 'Diabetic Ketoacidosis', type: 'disease_disorder', summary: 'DKA overview' },
            { name: 'Heart Failure', type: 'disease_disorder' },
          ],
        },
        { questions: [rawQuestion('diabetic ketoacidosis'), rawQuestion('heart failure')] },
      ],
      seenRequestBodies
    );
    try {
      const applySyllabusConcepts = jest.fn(
        async (_courseId: string, _payload: Record<string, unknown>) => ({
          concepts: [
            { id: 'concept-1', key: 'diabetic ketoacidosis', name: 'Diabetic Ketoacidosis' },
            { id: 'concept-2', key: 'heart failure', name: 'Heart Failure' },
          ],
          newConcepts: 2,
        })
      );
      const applyOndemandQuestions = jest.fn(
        async (_courseId: string, _payload: Record<string, unknown>) => ({
          inserted: 2,
          skipped: 0,
        })
      );
      const complete = jest.fn();
      const fail = jest.fn();
      const client: LearningGenerationClient = {
        claim: async () => ({
          id: 'r-qset-1',
          user_id: 'u1',
          course_id: 'c1',
          kind: 'question_set',
          request: {},
          fingerprint: null,
        }),
        loadContext: async () => ({
          courseTitle: 'Med-Surg Nursing',
          concepts: [],
          history: [],
          explicitContext: '',
          upcomingExam: null,
        }),
        search: async () => [],
        storeCase: jest.fn(),
        storeSimulation: jest.fn(),
        storeTutor: jest.fn(),
        enqueueHandoff: jest.fn(),
        recoverStale: jest.fn(),
        applySyllabusConcepts,
        applyOndemandQuestions,
        complete,
        fail,
      };
      const result = await processLearningRequest(client, {} as never, 'test-key', {});
      expect(result).toBe('ready');
      expect(fail).not.toHaveBeenCalled();
      expect(applySyllabusConcepts).toHaveBeenCalledTimes(1);
      const [courseId, payload] = applySyllabusConcepts.mock.calls[0]!;
      expect(courseId).toBe('c1');
      expect((payload as { concepts: unknown[] }).concepts).toHaveLength(2);
      expect(applyOndemandQuestions).toHaveBeenCalledTimes(1);
      const [, questionPayload] = applyOndemandQuestions.mock.calls[0]!;
      expect((questionPayload as { questions: unknown[] }).questions).toHaveLength(2);
      expect(complete).toHaveBeenCalledWith(
        'r-qset-1',
        expect.objectContaining({ newConcepts: 2, questionsGenerated: 2, inserted: 2 })
      );
      expect(seenRequestBodies).toHaveLength(2);
      for (const body of seenRequestBodies) {
        expect(body.response_format).toEqual({ type: 'json_object' });
        const allText = body.messages.map((m) => m.content).join(' ');
        expect(allText.toLowerCase()).toContain('json');
      }
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('reuses existing concepts instead of proposing a new syllabus when the course already has some', async () => {
    const originalFetch = global.fetch;
    global.fetch = fetchSequence([{ questions: [rawQuestion('oxygenation')] }]);
    try {
      const applySyllabusConcepts = jest.fn();
      const applyOndemandQuestions = jest.fn(async () => ({ inserted: 1, skipped: 0 }));
      const complete = jest.fn();
      const client: LearningGenerationClient = {
        claim: async () => ({
          id: 'r-qset-2',
          user_id: 'u1',
          course_id: 'c1',
          kind: 'question_set',
          request: {},
          fingerprint: null,
        }),
        loadContext: async () => ({
          courseTitle: 'Adult Health',
          concepts: [{ id: 'existing-1', name: 'Oxygenation', mastery: null }],
          history: [],
          explicitContext: '',
          upcomingExam: null,
        }),
        search: async () => [],
        storeCase: jest.fn(),
        storeSimulation: jest.fn(),
        storeTutor: jest.fn(),
        enqueueHandoff: jest.fn(),
        recoverStale: jest.fn(),
        applySyllabusConcepts,
        applyOndemandQuestions,
        complete,
        fail: jest.fn(),
      };
      const result = await processLearningRequest(client, {} as never, 'test-key', {});
      expect(result).toBe('ready');
      expect(applySyllabusConcepts).not.toHaveBeenCalled();
      expect(applyOndemandQuestions).toHaveBeenCalledTimes(1);
      expect(complete).toHaveBeenCalledWith(
        'r-qset-2',
        expect.objectContaining({ newConcepts: 0 })
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('fails safely instead of generating questions for an empty concept list when every proposed topic is meaningless', async () => {
    const originalFetch = global.fetch;
    global.fetch = fetchSequence([
      { concepts: [{ name: 'Nursing' }, { name: 'Patient Care' }] },
      { concepts: [{ name: 'Nursing' }, { name: 'Patient Care' }] },
    ]);
    try {
      const applySyllabusConcepts = jest.fn();
      const applyOndemandQuestions = jest.fn();
      const complete = jest.fn();
      const fail = jest.fn();
      const client: LearningGenerationClient = {
        claim: async () => ({
          id: 'r-qset-3',
          user_id: 'u1',
          course_id: 'c1',
          kind: 'question_set',
          request: {},
          fingerprint: null,
        }),
        loadContext: async () => ({
          courseTitle: 'Foundations',
          concepts: [],
          history: [],
          explicitContext: '',
          upcomingExam: null,
        }),
        search: async () => [],
        storeCase: jest.fn(),
        storeSimulation: jest.fn(),
        storeTutor: jest.fn(),
        enqueueHandoff: jest.fn(),
        recoverStale: jest.fn(),
        applySyllabusConcepts,
        applyOndemandQuestions,
        complete,
        fail,
      };
      const result = await processLearningRequest(client, {} as never, 'test-key', {});
      expect(result).toBe('failed');
      expect(fail).toHaveBeenCalledWith('r-qset-3', expect.stringContaining('could not create'));
      expect(applySyllabusConcepts).not.toHaveBeenCalled();
      expect(applyOndemandQuestions).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('validateSyllabusConceptDraft rejects malformed shapes and accepts a well-formed proposal', () => {
    expect(validateSyllabusConceptDraft({ concepts: [] }).ok).toBe(false);
    expect(validateSyllabusConceptDraft({ concepts: [{ name: '' }] }).ok).toBe(false);
    expect(validateSyllabusConceptDraft({ concepts: 'nope' }).ok).toBe(false);
    const valid = validateSyllabusConceptDraft({
      concepts: [{ name: 'Diabetic Ketoacidosis', type: 'disease_disorder', summary: 'overview' }],
    });
    expect(valid.ok).toBe(true);
  });

  it('refineSyllabusConcepts drops generic terms and dedupes by normalized key', () => {
    const refined = refineSyllabusConcepts([
      { name: 'Nursing' },
      { name: 'Diabetic Ketoacidosis', type: 'disease_disorder' },
      { name: 'DIABETIC   ketoacidosis' },
      { name: 'Heart Failure', type: 'not_a_real_type' },
    ]);
    expect(refined.map((c) => c.name)).toEqual(['Diabetic Ketoacidosis', 'Heart Failure']);
    expect(refined.find((c) => c.name === 'Heart Failure')?.type).toBe('other');
  });
});
