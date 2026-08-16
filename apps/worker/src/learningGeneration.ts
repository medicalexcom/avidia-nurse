import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  executeAiTask,
  AiTaskFailedError,
  type AiComplexity,
  type AiModelChoice,
  type AiTask,
} from '@avidia/ai-router';
import { validateCase, type SimulationCaseDefinition } from '@avidia/simulation';
import type { EmbeddingProvider, SourceLocator } from '@avidia/rag';

import { toVectorLiteral } from './supabaseIndexerClient';

export const LEARNING_GENERATOR_VERSION = 'v1';
export const LEARNING_PROMPT_VERSION = 'p1';
export const LEARNING_VALIDATOR_VERSION = 'v1';
const SAFE_FAILURE =
  'Avidia could not create that right now. Your stored study tools still work; please try again.';
const MAX_HISTORY = 10;
const MAX_SOURCES = 8;

export type LearningRequestKind = 'case_study' | 'simulation' | 'tutor';
export type TargetMode =
  'recommended' | 'upcoming_exam' | 'weakest' | 'topic' | 'surprise' | 'another';
export type CaseDifficulty = 'foundational' | 'application' | 'advanced' | 'complex';

export interface LearningRequestRow {
  id: string;
  user_id: string;
  course_id: string;
  kind: LearningRequestKind;
  request: Record<string, unknown>;
  fingerprint: string | null;
}

interface SourceRow {
  chunk_id: string;
  document_id: string;
  document_filename: string;
  content: string;
  source_locator: SourceLocator;
}

export interface CaseStudyDraft {
  title: string;
  patient: { name: string; age: number; background: string };
  history: string[];
  presentation: string;
  vitals: Record<string, string | number>;
  labs: Array<{ name: string; value: string; interpretation: string }>;
  medications: string[];
  findings: string[];
  phases: Array<{
    title: string;
    update: string;
    questions: Array<{
      stem: string;
      options: string[];
      correctOptionIndexes: number[];
      rationale: string;
      sourceIndexes: number[];
    }>;
  }>;
}

export interface LearningGenerationClient {
  claim(): Promise<LearningRequestRow | null>;
  loadContext(row: LearningRequestRow): Promise<{
    courseTitle: string;
    concepts: Array<{ id: string; name: string; mastery: number | null }>;
    history: Array<{ role: string; content: string }>;
    explicitContext: string;
    upcomingExam: string | null;
  }>;
  search(courseId: string, query: string): Promise<SourceRow[]>;
  storeCase(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  storeSimulation(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  storeTutor(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  enqueueHandoff(
    row: LearningRequestRow,
    kind: 'case_study' | 'simulation',
    topic: string
  ): Promise<string>;
  complete(id: string, result: Record<string, unknown>): Promise<void>;
  fail(id: string, message: string): Promise<void>;
}

export function generationFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function selectPersonalization(
  mode: TargetMode,
  concepts: Array<{ id: string; name: string; mastery: number | null }>,
  topic?: string
): Array<{ id: string; name: string }> {
  if (mode === 'topic' && topic?.trim()) return [{ id: '', name: topic.trim() }];
  const ordered = [...concepts].sort((a, b) => (a.mastery ?? -1) - (b.mastery ?? -1));
  if (mode === 'surprise') {
    const seed = topic ?? concepts.map((c) => c.id).join('|');
    const index =
      parseInt(generationFingerprint(seed).slice(0, 8), 16) % Math.max(ordered.length, 1);
    return ordered[index] ? [{ id: ordered[index]!.id, name: ordered[index]!.name }] : [];
  }
  return ordered.slice(0, mode === 'recommended' ? 3 : 1).map(({ id, name }) => ({ id, name }));
}

export function validateCaseStudyDraft(
  value: unknown,
  sourceCount: number
): { ok: true; value: CaseStudyDraft } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const draft = value as Partial<CaseStudyDraft> | null;
  if (!draft || typeof draft !== 'object')
    return { ok: false, errors: ['draft must be an object'] };
  if (!draft.title?.trim()) errors.push('title is required');
  if (!draft.patient || !draft.patient.name?.trim() || !Number.isInteger(draft.patient.age))
    errors.push('fictional patient is invalid');
  if (!Array.isArray(draft.phases) || draft.phases.length === 0)
    errors.push('at least one phase is required');
  for (const [pi, phase] of (draft.phases ?? []).entries()) {
    if (!phase.title?.trim() || !phase.update?.trim()) errors.push(`phase ${pi} is incomplete`);
    if (!Array.isArray(phase.questions) || phase.questions.length === 0)
      errors.push(`phase ${pi} needs questions`);
    for (const [qi, q] of (phase.questions ?? []).entries()) {
      const optionCount = Array.isArray(q.options) ? q.options.length : 0;
      if (!q.stem?.trim() || optionCount < 2 || !q.rationale?.trim())
        errors.push(`question ${pi}.${qi} is incomplete`);
      if (
        !q.correctOptionIndexes?.length ||
        q.correctOptionIndexes.some((i) => !Number.isInteger(i) || i < 0 || i >= optionCount)
      )
        errors.push(`question ${pi}.${qi} answer is invalid`);
      if (
        !q.sourceIndexes?.length ||
        q.sourceIndexes.some((i) => !Number.isInteger(i) || i < 0 || i >= sourceCount)
      )
        errors.push(`question ${pi}.${qi} source is invalid`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: draft as CaseStudyDraft };
}

export function blocksActiveSimulationDisclosure(message: string): boolean {
  return /hidden findings?|correct next action|how (?:do|can) i win|critical actions?|scoring conditions?|future events?/i.test(
    message
  );
}

function taskForTutor(message: string): { task: AiTask; complexity: AiComplexity } {
  if (/why was i wrong|evaluate my reasoning|my reasoning/i.test(message))
    return { task: 'CLINICAL_REASONING_EVALUATION', complexity: 'HIGH' };
  if (/go deeper|membrane potential|pathophysiolog|mechanism/i.test(message))
    return { task: 'DEEP_TUTORING', complexity: 'HIGH' };
  if (/simpl(?:e|ify)|basic|brief/i.test(message))
    return { task: 'BASIC_EXPLANATION', complexity: 'LOW' };
  return { task: 'RAG_ANSWER', complexity: 'MEDIUM' };
}

async function openAiJson(
  apiKey: string,
  choice: AiModelChoice,
  messages: Array<{ role: string; content: string }>
): Promise<
  | { ok: true; value: unknown; usage?: { inputTokens: number; outputTokens: number } }
  | {
      ok: false;
      reason:
        | 'http_429'
        | 'http_5xx'
        | 'timeout'
        | 'network_error'
        | 'quota_exceeded'
        | 'invalid_response'
        | 'other';
      retryableSameModel: boolean;
      detail: string;
    }
> {
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: choice.model,
        messages,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      const reason =
        response.status === 429
          ? 'http_429'
          : response.status >= 500
            ? 'http_5xx'
            : response.status === 402
              ? 'quota_exceeded'
              : 'other';
      // The status code alone ("other") is not enough to diagnose a live
      // failure — OpenAI's error body names the actual cause (bad request,
      // auth, model access). Safe to log: it's OpenAI's own response, never
      // our secret key or student content beyond what we already sent.
      let bodySnippet = '';
      try {
        bodySnippet = (await response.text()).slice(0, 500);
      } catch {
        // best-effort only
      }
      return {
        ok: false,
        reason,
        retryableSameModel: response.status === 429 || response.status >= 500,
        detail: `OpenAI HTTP ${response.status}${bodySnippet ? `: ${bodySnippet}` : ''}`,
      };
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content)
      return {
        ok: false,
        reason: 'invalid_response',
        retryableSameModel: false,
        detail: 'empty completion',
      };
    try {
      return {
        ok: true,
        value: JSON.parse(content),
        usage: {
          inputTokens: payload.usage?.prompt_tokens ?? 0,
          outputTokens: payload.usage?.completion_tokens ?? 0,
        },
      };
    } catch {
      return {
        ok: false,
        reason: 'invalid_response',
        retryableSameModel: false,
        detail: 'invalid JSON',
      };
    }
  } catch (error) {
    const timeout = error instanceof Error && error.name === 'TimeoutError';
    return {
      ok: false,
      reason: timeout ? 'timeout' : 'network_error',
      retryableSameModel: true,
      detail: timeout ? 'timeout' : 'network failure',
    };
  }
}

async function generateValidated<T>(args: {
  apiKey: string;
  task: AiTask;
  complexity: AiComplexity;
  system: string;
  user: string;
  validate: (value: unknown) => { ok: true; value: T } | { ok: false; errors: string[] };
  env: Record<string, string | undefined>;
}): Promise<{ value: T; choice: AiModelChoice }> {
  const run = async (messages: Array<{ role: string; content: string }>) =>
    executeAiTask({
      request: { task: args.task, complexity: args.complexity },
      env: args.env,
      attempt: (choice) => openAiJson(args.apiKey, choice, messages),
    });
  const first = await run([
    { role: 'system', content: args.system },
    { role: 'user', content: args.user },
  ]);
  const checked = args.validate(first.value);
  if (checked.ok) return { value: checked.value, choice: first.choice };
  const repaired = await run([
    { role: 'system', content: args.system },
    { role: 'user', content: args.user },
    { role: 'assistant', content: JSON.stringify(first.value) },
    {
      role: 'user',
      content: `Repair only these validation errors and return the entire corrected JSON: ${checked.errors.slice(0, 20).join('; ')}`,
    },
  ]);
  const rechecked = args.validate(repaired.value);
  if (!rechecked.ok)
    throw new Error(`invalid after bounded repair: ${rechecked.errors.slice(0, 5).join('; ')}`);
  return { value: rechecked.value, choice: repaired.choice };
}

function sourcePrompt(sources: SourceRow[]): string {
  return sources
    .map(
      (s, i) => `[${i}] ${s.document_filename} ${JSON.stringify(s.source_locator)}\n${s.content}`
    )
    .join('\n\n');
}

export async function processLearningRequest(
  client: LearningGenerationClient,
  embeddings: EmbeddingProvider,
  apiKey: string,
  env: Record<string, string | undefined>
): Promise<'idle' | 'ready' | 'failed'> {
  const row = await client.claim();
  if (!row) return 'idle';
  try {
    const context = await client.loadContext(row);
    const mode = String(row.request.mode ?? 'recommended') as TargetMode;
    const difficulty = String(row.request.difficulty ?? 'application') as CaseDifficulty;
    const selected = selectPersonalization(mode, context.concepts, String(row.request.topic ?? ''));
    const query =
      (mode === 'upcoming_exam' ? context.upcomingExam : null) ??
      (selected.map((c) => c.name).join(' ') || String(row.request.message ?? context.courseTitle));
    void embeddings; // retrieval implementation owns query embedding; retained as an explicit server-only dependency.
    const sources = await client.search(row.course_id, query);
    // case_study/simulation authoring must stay course-grounded (unchanged
    // behavior). Ask Avidia tutor replies must NOT hard-fail just because a
    // question falls outside the uploaded course material — that produced a
    // silent, permanent failure with no assistant message ever appearing.
    // Fall back to clearly-labeled general nursing knowledge instead.
    if (!sources.length && row.kind !== 'tutor') throw new Error('no grounded course sources');
    const groundingNote = sources.length
      ? ''
      : "\nNo matching course sources were found for this question. Answer from general nursing knowledge only, and say plainly that this is not grounded in the student's uploaded course material.";
    const base = `Course: ${context.courseTitle}\nTarget mode: ${mode}${context.upcomingExam ? `\nUpcoming exam: ${context.upcomingExam}` : ''}\nSelected structured concepts: ${selected.map((c) => c.name).join(', ')}\n${context.explicitContext}${groundingNote}\nSources:\n${sourcePrompt(sources)}`;

    if (row.kind === 'case_study') {
      const complexity: AiComplexity =
        difficulty === 'complex' ? 'HIGH' : difficulty === 'foundational' ? 'LOW' : 'MEDIUM';
      const generated = await generateValidated({
        apiKey,
        task: 'CASE_STUDY_GENERATION',
        complexity,
        env,
        system:
          'Author a fictional ABSN nursing case study grounded only in numbered sources. Return JSON with title, patient{name,age,background}, history, presentation, vitals, labs{name,value,interpretation}, medications, findings, phases{title,update,questions{stem,options,correctOptionIndexes,rationale,sourceIndexes}}. Never include real patient data.',
        user: `${base}\nDifficulty: ${difficulty}.`,
        validate: (v) => validateCaseStudyDraft(v, sources.length),
      });
      const result = await client.storeCase({
        row,
        draft: generated.value,
        sources,
        selected,
        difficulty,
        choice: generated.choice,
        fingerprint:
          row.fingerprint ??
          generationFingerprint({
            course: row.course_id,
            mode,
            difficulty,
            selected,
            sources: sources.map((s) => s.chunk_id),
          }),
      });
      await client.complete(row.id, result);
      return 'ready';
    }

    if (row.kind === 'simulation') {
      const generated = await generateValidated<SimulationCaseDefinition>({
        apiKey,
        task: 'SIMULATION_CASE_GENERATION',
        complexity: 'HIGH',
        env,
        system:
          'Author a complete SimulationCaseDefinition JSON for Avidia M11 engineVersion 1. AI only authors this closed rulebook; runtime is deterministic. Include a fictional adult, valid physiologic values, controlled actions/rules, reachable terminating outcomes, critical/unsafe actions, scoring, and conceptMappings. Return JSON only.',
        user: `${base}\nRequested difficulty: ${difficulty}. Source chunk ids available: ${sources.map((s) => s.chunk_id).join(', ')}.`,
        validate: (v) => {
          try {
            const checked = validateCase(v as SimulationCaseDefinition);
            const def = v as SimulationCaseDefinition;
            const conceptNames = new Set(selected.map((c) => c.name.toLowerCase()));
            const referenceErrors = (def?.conceptMappings ?? [])
              .filter((m) => !conceptNames.has(m.conceptName.toLowerCase()))
              .map((m) => `unsupported concept ${m.conceptName}`);
            const errors = [...checked.errors, ...referenceErrors];
            return errors.length
              ? { ok: false as const, errors }
              : { ok: true as const, value: def };
          } catch {
            return {
              ok: false as const,
              errors: ['draft does not match the SimulationCaseDefinition schema'],
            };
          }
        },
      });
      const result = await client.storeSimulation({
        row,
        definition: generated.value,
        sources,
        selected,
        choice: generated.choice,
        fingerprint:
          row.fingerprint ??
          generationFingerprint({
            course: row.course_id,
            mode,
            difficulty,
            selected,
            sources: sources.map((s) => s.chunk_id),
          }),
      });
      await client.complete(row.id, result);
      return 'ready';
    }

    const message = String(row.request.message ?? '').trim();
    const activeSimulation = row.request.contextType === 'active_simulation';
    if (activeSimulation && blocksActiveSimulationDisclosure(message)) {
      const result = await client.storeTutor({
        row,
        content:
          'I can help you interpret information you have already revealed, but I cannot expose hidden findings, scoring rules, or the correct next action during an active simulation.',
        sources: [],
        task: 'SIMULATION_DIALOGUE',
        tier: 'STANDARD',
      });
      await client.complete(row.id, result);
      return 'ready';
    }
    if (/\bquiz me(?: again)?\b/i.test(message)) {
      const result = await client.storeTutor({
        row,
        content:
          'Your scored adaptive quiz is ready. It uses your existing validated question bank and the same deterministic scoring and mastery pipeline as Study.',
        sources,
        task: 'QUESTION_GENERATION_ROUTINE',
        tier: 'ECONOMY',
      });
      await client.complete(row.id, { ...result, action: 'start_adaptive_quiz' });
      return 'ready';
    }
    const handoffKind = /create (?:a )?simulation|simulation on this/i.test(message)
      ? 'simulation'
      : /give me a case|create (?:a )?case/i.test(message)
        ? 'case_study'
        : null;
    if (handoffKind) {
      const handoffId = await client.enqueueHandoff(row, handoffKind, query);
      const result = await client.storeTutor({
        row,
        content:
          handoffKind === 'simulation'
            ? 'I sent this to the simulation authoring pipeline. It will be validated before it appears in your simulation library.'
            : 'I sent this to the case-study authoring pipeline. It will appear in Case Studies after validation.',
        sources,
        task: handoffKind === 'simulation' ? 'SIMULATION_CASE_GENERATION' : 'CASE_STUDY_GENERATION',
        tier: handoffKind === 'simulation' ? 'ADVANCED' : 'STANDARD',
        handoffId,
      });
      await client.complete(row.id, { ...result, handoffId, handoffKind });
      return 'ready';
    }
    const routed = taskForTutor(message);
    const answer = await generateValidated<{ answer: string }>({
      apiKey,
      ...routed,
      env,
      system:
        'You are Ask Avidia, a course-aware nursing tutor. Answer from numbered course sources, state when evidence is insufficient, never invent citations, and return {"answer":"..."}. During active simulation discuss only explicitly supplied revealed state and never prescribe the exact next action.',
      user: `${base}\nBounded conversation:\n${context.history
        .slice(-MAX_HISTORY)
        .map((m) => `${m.role}: ${m.content}`)
        .join('\n')}\nStudent: ${message}`,
      validate: (v) =>
        typeof (v as { answer?: unknown })?.answer === 'string' &&
        (v as { answer: string }).answer.trim()
          ? { ok: true, value: v as { answer: string } }
          : { ok: false, errors: ['answer is required'] },
    });
    const content = sources.length
      ? answer.value.answer
      : `${answer.value.answer}\n\n(This answer draws on general nursing knowledge — no matching source was found in your uploaded course material.)`;
    const result = await client.storeTutor({
      row,
      content,
      sources,
      task: routed.task,
      tier: answer.choice.tier,
    });
    await client.complete(row.id, result);
    return 'ready';
  } catch (error) {
    // The student-facing message must stay generic (SAFE_FAILURE); the real
    // cause still needs to reach logs or every live failure is a black box.
    // AiTaskFailedError carries the provider-level detail (HTTP status +
    // body) in `.detail` — never in `.message`, which is student-safe.
    const detail =
      error instanceof AiTaskFailedError
        ? error.detail
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(`[worker] learning request ${row.id} (${row.kind}) failed: ${detail}`);
    await client.fail(row.id, SAFE_FAILURE);
    return 'failed';
  }
}

export function createSupabaseLearningGenerationClient(
  supabase: SupabaseClient,
  embeddings: EmbeddingProvider
): LearningGenerationClient {
  return {
    async claim() {
      const { data, error } = await supabase.rpc('claim_ai_learning_request');
      if (error) throw error;
      return (data as LearningRequestRow | null) ?? null;
    },
    async loadContext(row) {
      const [{ data: course }, { data: concepts }, { data: mastery }, { data: exams }] =
        await Promise.all([
          supabase.from('courses').select('title').eq('id', row.course_id).single(),
          supabase
            .from('concepts')
            .select('id, canonical_name')
            .eq('course_id', row.course_id)
            .eq('status', 'active'),
          supabase
            .from('concept_mastery')
            .select('concept_id, mastery')
            .eq('user_id', row.user_id)
            .eq('course_id', row.course_id),
          supabase
            .from('exams')
            .select('title,exam_at')
            .eq('course_id', row.course_id)
            .gte('exam_at', new Date().toISOString())
            .order('exam_at')
            .limit(1),
        ]);
      const masteryMap = new Map(
        (mastery ?? []).map((m: { concept_id: string; mastery: number }) => [
          m.concept_id,
          Number(m.mastery),
        ])
      );
      let history: Array<{ role: string; content: string }> = [];
      let explicitContext = '';
      const conversationId = row.request.conversationId;
      if (typeof conversationId === 'string') {
        const { data } = await supabase
          .from('tutor_messages')
          .select('role, content')
          .eq('conversation_id', conversationId)
          .order('created_at', { ascending: false })
          .limit(MAX_HISTORY);
        history = [...((data ?? []) as typeof history)].reverse();
      }
      const questionId = row.request.questionId;
      if (typeof questionId === 'string') {
        const { data: question } = await supabase
          .from('questions')
          .select('stem,rationale,concept_id')
          .eq('id', questionId)
          .eq('course_id', row.course_id)
          .maybeSingle();
        const { data: attempt } = await supabase
          .from('question_attempts')
          .select('response,is_correct')
          .eq('question_id', questionId)
          .eq('course_id', row.course_id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        const { data: correctOptions } = await supabase
          .from('question_options')
          .select('option_text,is_correct,correct_position')
          .eq('question_id', questionId)
          .or('is_correct.eq.true,correct_position.not.is.null')
          .order('ordinal');
        if (question)
          explicitContext = `Submitted question review context: ${question.stem}\nStored rationale: ${question.rationale}`;
        if (attempt)
          explicitContext += `\nStudent response: ${JSON.stringify(attempt.response)}\nScored correct: ${String(attempt.is_correct)}`;
        if (correctOptions?.length)
          explicitContext += `\nCorrect answer after submission: ${correctOptions.map((option: { option_text: string }) => option.option_text).join(' → ')}`;
      }
      const revealed = row.request.revealedState;
      if (
        row.request.contextType === 'active_simulation' &&
        revealed &&
        typeof revealed === 'object'
      ) {
        explicitContext += `\nClient-safe revealed simulation state only: ${JSON.stringify(revealed).slice(0, 6000)}`;
      }
      return {
        courseTitle: String(course?.title ?? 'Course'),
        concepts: (concepts ?? []).map((c: { id: string; canonical_name: string }) => ({
          id: c.id,
          name: c.canonical_name,
          mastery: masteryMap.get(c.id) ?? null,
        })),
        history,
        explicitContext,
        upcomingExam: exams?.[0]
          ? `${String(exams[0].title)} on ${String(exams[0].exam_at)}`
          : null,
      };
    },
    async search(courseId, query) {
      const vector = await embeddings.embedQuery(query);
      const { data, error } = await supabase.rpc('search_course_chunks', {
        p_course_id: courseId,
        p_query: query,
        p_query_embedding: toVectorLiteral(vector),
        p_top_k: MAX_SOURCES,
        p_min_similarity: 0,
        p_document_id: null,
      });
      if (error) throw error;
      return (data ?? []) as SourceRow[];
    },
    async storeCase(args) {
      const a = args as unknown as {
        row: LearningRequestRow;
        draft: CaseStudyDraft;
        difficulty: CaseDifficulty;
        selected: Array<{ id: string }>;
        sources: SourceRow[];
        choice: AiModelChoice;
        fingerprint: string;
      };
      const { data, error } = await supabase
        .from('generated_case_studies')
        .upsert({
          request_id: a.row.id,
          user_id: a.row.user_id,
          course_id: a.row.course_id,
          title: a.draft.title,
          difficulty: a.difficulty,
          grounding: 'course_grounded',
          content: a.draft,
          concept_ids: a.selected.map((c) => c.id).filter(Boolean),
          source_chunk_ids: a.sources.map((s) => s.chunk_id),
          provider: a.choice.provider,
          model: a.choice.model,
          model_tier: a.choice.tier,
          prompt_version: LEARNING_PROMPT_VERSION,
          generator_version: LEARNING_GENERATOR_VERSION,
          validator_version: LEARNING_VALIDATOR_VERSION,
          fingerprint: a.fingerprint,
        })
        .select('id,title,difficulty,grounding,content,source_chunk_ids')
        .single();
      if (error) throw error;
      return { artifactType: 'case_study', ...data };
    },
    async storeSimulation(args) {
      const a = args as unknown as {
        row: LearningRequestRow;
        definition: SimulationCaseDefinition;
        selected: Array<{ id: string }>;
        sources: SourceRow[];
        choice: AiModelChoice;
        fingerprint: string;
      };
      const def = a.definition;
      const key = `generated_${a.row.user_id.slice(0, 8)}_${a.fingerprint.slice(0, 24)}`;
      const metadata = {
        provider: a.choice.provider,
        model: a.choice.model,
        modelTier: a.choice.tier,
        promptVersion: LEARNING_PROMPT_VERSION,
        generatorVersion: LEARNING_GENERATOR_VERSION,
        validatorVersion: LEARNING_VALIDATOR_VERSION,
        fingerprint: a.fingerprint,
        conceptIds: a.selected.map((c) => c.id).filter(Boolean),
        sourceChunkIds: a.sources.map((s) => s.chunk_id),
      };
      const { data, error } = await supabase
        .from('simulation_cases')
        .upsert(
          {
            case_key: key,
            case_version: def.caseVersion,
            engine_version: def.engineVersion,
            status: 'active',
            title: def.title,
            description: def.description,
            difficulty: def.difficulty,
            scenario_type: def.scenarioType,
            estimated_duration_minutes: def.estimatedDurationMinutes,
            definition: def,
            owner_id: a.row.user_id,
            course_id: a.row.course_id,
            generation_metadata: metadata,
          },
          { onConflict: 'case_key' }
        )
        .select('id,case_key,title,difficulty,scenario_type,estimated_duration_minutes')
        .single();
      if (error) throw error;
      return { artifactType: 'simulation', ...data, generationMetadata: metadata };
    },
    async storeTutor(args) {
      const a = args as unknown as {
        row: LearningRequestRow;
        content: string;
        sources: SourceRow[];
        task: AiTask;
        tier: string;
      };
      const conversationId = a.row.request.conversationId;
      if (typeof conversationId !== 'string') throw new Error('conversation required');
      const { data, error } = await supabase
        .from('tutor_messages')
        .insert({
          conversation_id: conversationId,
          user_id: a.row.user_id,
          role: 'assistant',
          content: a.content,
          source_chunk_ids: a.sources.map((s) => s.chunk_id),
          task: a.task,
          model_tier: a.tier,
        })
        .select('id,content,source_chunk_ids,task,model_tier,created_at')
        .single();
      if (error) throw error;
      return { artifactType: 'tutor_message', ...data };
    },
    async enqueueHandoff(row, kind, topic) {
      const request = {
        mode: 'topic',
        topic,
        difficulty: kind === 'simulation' ? 'advanced' : 'application',
        requestedFromConversation: row.request.conversationId,
      };
      const fingerprint = generationFingerprint({
        userId: row.user_id,
        courseId: row.course_id,
        kind,
        request,
      });
      const { data, error } = await supabase
        .from('ai_learning_requests')
        .insert({
          user_id: row.user_id,
          course_id: row.course_id,
          kind,
          request,
          fingerprint,
        })
        .select('id')
        .single();
      if (error) throw error;
      return String(data.id);
    },
    async complete(id, result) {
      const { error } = await supabase
        .from('ai_learning_requests')
        .update({
          status: 'ready',
          result,
          error_message: null,
          completed_at: new Date().toISOString(),
        })
        .eq('id', id);
      if (error) throw error;
    },
    async fail(id, message) {
      const { error } = await supabase
        .from('ai_learning_requests')
        .update({
          status: 'failed',
          error_message: message,
          completed_at: new Date().toISOString(),
        })
        .eq('id', id);
      if (error) throw error;
    },
  };
}
