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
const openAiTimeoutMs = (task: AiTask): number =>
  task === 'SIMULATION_CASE_GENERATION'
    ? 240_000
    : task === 'CASE_STUDY_GENERATION'
      ? 150_000
      : 90_000; // SIMULATION_CASE_GENERATION is always ADVANCED with no fallback tier (tiers.ts) - 3 attempts x 240s = 12 min, safely under the worker job's 20-minute cap. CASE_STUDY_GENERATION can fall back STANDARD -> ADVANCED (6 attempts total), so it gets a smaller ceiling (6 x 150s = 15 min) to stay under that same cap - both timeouts confirmed against live worker run #254 (2026-08-18) and PR #5 review.

// A retrieved chunk counts as genuinely SUPPORTING an answer only above this
// cosine-similarity floor. search_course_chunks() is called with
// p_min_similarity: 0 (broad recall, so the lexical leg and lightly-related
// vector neighbors still surface for the model to consider), which means the
// vector leg always returns its v_pool nearest neighbors regardless of how
// distant they actually are — hence the live bug where an HIV/AIDS question
// "retrieved" 8 chunks about hypocretins/orexins/sleep disorders and the UI
// still said "Grounded in 8 course sources." Retrieved is not the same claim
// as supporting; this floor is what turns the former into the latter. 0.45
// is a deliberately conservative deterministic cut for OpenAI text-embedding
// cosine similarity: on-topic course material for a question typically
// scores well above this, unrelated material well below it.
export const GROUNDING_SIMILARITY_FLOOR = 0.45;

export type GroundingMode = 'course_grounded' | 'mixed' | 'general_knowledge';

// Short, exact-match presets ("Go deeper.", "Simplify.", ...) carry zero
// retrieval signal on their own — searching for the literal text "Go
// deeper." finds nothing about the actual topic being discussed, and (before
// this fix) silently fell back to a mastery-ranked concept list instead,
// which is how a live "Go deeper" on an HIV/AIDS answer surfaced sources
// about parosmia and presbycusis. Recovering the prior substantive student
// question keeps a follow-up grounded in the same topic.
const GENERIC_FOLLOWUP_RE =
  /^(go deeper\.?|simplify\.?|explain (?:this|that)\.?|give me an example\.?|why was i wrong\??)$/i;

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
  /** Cosine similarity of the vector leg (0 when only the lexical leg hit). */
  similarity: number;
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

/**
 * Deterministic provenance decision (never derived from the model's own
 * claim — that is what let a refusal display "Grounded in 8 course
 * sources"). COURSE_GROUNDED only when every retrieved chunk clears the
 * relevance floor; GENERAL_KNOWLEDGE when none do (course material simply
 * doesn't cover this — never a reason to refuse); MIXED otherwise.
 */
export function classifyGrounding(sources: SourceRow[]): {
  mode: GroundingMode;
  relevantSources: SourceRow[];
} {
  const relevantSources = sources.filter((s) => s.similarity >= GROUNDING_SIMILARITY_FLOOR);
  if (relevantSources.length === 0) return { mode: 'general_knowledge', relevantSources };
  if (relevantSources.length === sources.length)
    return { mode: 'course_grounded', relevantSources };
  return { mode: 'mixed', relevantSources };
}

/**
 * The retrieval query for a tutor turn. A bare follow-up preset carries no
 * topic on its own, so it is combined with the most recent substantive
 * student question in the bounded conversation history — otherwise "Go
 * deeper" re-retrieves from scratch with only the words "Go deeper" and
 * drifts onto whatever the mastery-ranked concept list would have picked,
 * unrelated to what the student was actually asking about.
 */
export function buildTutorQuery(
  message: string,
  history: Array<{ role: string; content: string }>
): string {
  const trimmed = message.trim();
  if (!GENERIC_FOLLOWUP_RE.test(trimmed)) return trimmed;
  const priorQuestion = [...history]
    .reverse()
    .find((m) => m.role === 'user' && !GENERIC_FOLLOWUP_RE.test(m.content.trim()));
  return priorQuestion ? `${priorQuestion.content} ${trimmed}` : trimmed;
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
      // A general-knowledge draft (sourceCount === 0, spec: course-first,
      // general-knowledge-fallback — a course simply not covering a topic
      // must never be a hard failure) has no sources to cite; requiring a
      // non-empty sourceIndexes in that case made every such draft
      // unvalidatable by construction. With real sources available, the
      // original strict requirement still applies unchanged.
      if (sourceCount === 0) {
        if (q.sourceIndexes?.length)
          errors.push(`question ${pi}.${qi} cites a source but none were provided`);
      } else if (
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
  messages: Array<{ role: string; content: string }>,
  timeoutMs: number
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
      signal: AbortSignal.timeout(timeoutMs),
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
      attempt: (choice) => openAiJson(args.apiKey, choice, messages, openAiTimeoutMs(args.task)),
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
    const message = String(row.request.message ?? '').trim();
    // Tutor retrieval must search for what the student actually asked, not
    // a mastery-ranked concept list disconnected from the question — that
    // mismatch was the root cause of an HIV/AIDS question retrieving
    // hypocretin/orexin/sleep-disorder chunks (mode defaults to
    // 'recommended' for every chat message, since the chat UI never sets
    // it, so `selected` was always the three lowest-mastery course
    // concepts regardless of what was typed). It also fed directly into
    // "Create a simulation on this" / "Give me a case" handoffs below,
    // which is why a live simulation request was found queued with
    // topic "hypocretins (orexins) parosmia presbycusis..." instead of HIV.
    const query =
      row.kind === 'tutor'
        ? buildTutorQuery(message, context.history) || context.courseTitle
        : ((mode === 'upcoming_exam' ? context.upcomingExam : null) ??
          (selected.map((c) => c.name).join(' ') || message || context.courseTitle));
    void embeddings; // retrieval implementation owns query embedding; retained as an explicit server-only dependency.
    const retrieved = await client.search(row.course_id, query);
    // Retrieved ≠ supporting. search_course_chunks() always returns its best
    // available neighbors (p_min_similarity: 0 — broad recall by design), so
    // "N chunks came back" is never itself evidence the course covers this
    // question. Only chunks clearing GROUNDING_SIMILARITY_FLOOR count as
    // course grounding, for every request kind alike.
    const { mode: groundingMode, relevantSources: sources } = classifyGrounding(retrieved);
    // Course-first, general-knowledge-fallback policy: a topic the course
    // doesn't cover (or only partly covers) is never a hard failure — for
    // case_study/simulation authoring same as for tutor replies — it is a
    // clearly, honestly labeled general nursing/medical knowledge answer or
    // artifact instead. Never fabricate course citations either way.
    const groundingNote =
      groundingMode === 'course_grounded'
        ? ''
        : groundingMode === 'mixed'
          ? "\nSome retrieved material was not relevant and has been excluded below. Use the remaining numbered sources where they apply, and general nursing/medical knowledge for anything they do not cover. Disclose plainly which parts are not grounded in the student's course material."
          : '\nNo retrieved course source was relevant to this question. This topic was not found in the course material retrieved, so answer from general nursing/medical knowledge only and say so plainly. Do not refuse, and never invent a course citation.';
    const base = `Course: ${context.courseTitle}\nTarget mode: ${mode}${context.upcomingExam ? `\nUpcoming exam: ${context.upcomingExam}` : ''}\nSelected structured concepts: ${selected.map((c) => c.name).join(', ')}\n${context.explicitContext}${groundingNote}\nSources:\n${sourcePrompt(sources)}`;
    const artifactGrounding =
      groundingMode === 'general_knowledge' ? 'general_nursing_knowledge' : groundingMode;

    if (row.kind === 'case_study') {
      const complexity: AiComplexity =
        difficulty === 'complex' ? 'HIGH' : difficulty === 'foundational' ? 'LOW' : 'MEDIUM';
      const generated = await generateValidated({
        apiKey,
        task: 'CASE_STUDY_GENERATION',
        complexity,
        env,
        system:
          'Author a fictional ABSN nursing case study. Prefer the numbered course sources when they are relevant. When they are absent or not relevant, author from general nursing knowledge instead and say so — never fabricate a citation to course material that was not provided. Return JSON with title, patient{name,age,background}, history, presentation, vitals, labs{name,value,interpretation}, medications, findings, phases{title,update,questions{stem,options,correctOptionIndexes,rationale,sourceIndexes}}. If no numbered sources are provided, leave every sourceIndexes empty. Never include real patient data.',
        user: `${base}\nDifficulty: ${difficulty}.`,
        validate: (v) => validateCaseStudyDraft(v, sources.length),
      });
      const result = await client.storeCase({
        row,
        draft: generated.value,
        sources,
        selected,
        difficulty,
        grounding: artifactGrounding,
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
        system: `Author a complete SimulationCaseDefinition JSON for Avidia M11 engineVersion 1. AI only authors this closed rulebook; runtime is deterministic. Prefer the numbered course sources when they are relevant; when absent or not relevant, author from general nursing knowledge instead and say so in the description — never fabricate a course citation. Include a fictional adult, valid physiologic values, controlled actions/rules, reachable terminating outcomes, critical/unsafe actions, scoring, and conceptMappings. Every conceptMappings[].conceptName must be exactly one of these (do not invent other names): ${selected.map((c) => c.name).join(', ') || '(none — omit conceptMappings)'}. Structural gotcha: "phases" must be a flat array of phase-id strings, e.g. ["triage","assessment","stabilization"] — never an object or a list of phase objects. "phaseFlow" is the separate field that maps each phase id to its array of legal next-phase ids, e.g. {"triage":["assessment"]}. Do not merge the two or turn "phases" into a keyed object. Every one of these top-level keys is required in the JSON and must be an array (use [] if genuinely empty, never omit the key): findings, labs, medicationOrders, actions, dialogue, statements, rules, outcomes, criticalActions, scoring, conceptMappings, debriefRecommendations. Return JSON only.`,
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
          } catch (err) {
            // validateCase() can throw a raw error on malformed model JSON instead of returning descriptive errors (confirmed live in worker run #257, 2026-08-18) - surface err.message so logs and the repair-retry prompt see the real problem, not a generic string.
            const detail = err instanceof Error ? err.message : String(err);
            return {
              ok: false as const,
              errors: [`draft does not match the SimulationCaseDefinition schema: ${detail}`],
            };
          }
        },
      });
      const result = await client.storeSimulation({
        row,
        definition: generated.value,
        sources,
        selected,
        grounding: artifactGrounding,
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

    const activeSimulation = row.request.contextType === 'active_simulation';
    if (activeSimulation && blocksActiveSimulationDisclosure(message)) {
      const result = await client.storeTutor({
        row,
        content:
          'I can help you interpret information you have already revealed, but I cannot expose hidden findings, scoring rules, or the correct next action during an active simulation.',
        sources: [],
        grounding: 'general_knowledge',
        task: 'SIMULATION_DIALOGUE',
        tier: 'STANDARD',
      });
      await client.complete(row.id, result);
      return 'ready';
    }
    // "Why was I wrong?" is only meaningful with question-attempt context
    // (the app already disables the preset button without one, but the
    // worker must not trust that — nothing stops a request with this text
    // and no questionId from reaching the queue some other way). Without
    // context there is nothing to evaluate; guide the student instead of
    // spending a model call producing a generic, unhelpful answer.
    if (
      /why was i wrong|evaluate my reasoning|my reasoning/i.test(message) &&
      typeof row.request.questionId !== 'string'
    ) {
      const result = await client.storeTutor({
        row,
        content:
          "I can explain why an answer was right or wrong once you ask this from a specific question's review screen, so I have the question, your response, and the correct answer to reference. Try it from there, or ask me to explain the concept directly.",
        sources: [],
        grounding: 'general_knowledge',
        task: 'RAG_ANSWER',
        tier: 'ECONOMY',
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
        grounding: groundingMode,
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
        grounding: groundingMode,
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
        // OpenAI's json_object response_format rejects the request with a
        // 400 unless the literal word "JSON" appears somewhere in the
        // messages sent — this was the actual, previously-unlogged cause of
        // every live Ask Avidia reply failing (both the primary and
        // fallback model attempts hit this same 400, surfaced only as
        // failureReason "other" before the improved error logging added
        // here). Say so explicitly instead of only showing the shape.
        //
        // Course-first, general-knowledge-fallback (spec): prefer numbered
        // course sources when relevant, but a topic the course doesn't
        // cover is never a reason to refuse — answer from general
        // nursing/medical knowledge instead and disclose that plainly. The
        // live HIV/AIDS refusal happened because the model was only ever
        // told to "state when evidence is insufficient," which it
        // (correctly, given no other instruction) read as license to
        // decline rather than fall back.
        'You are Ask Avidia, a course-aware nursing tutor. Prefer the numbered course sources when they are relevant. When they are absent or not relevant to the student\'s question, you MUST still answer using your general nursing/medical knowledge — never refuse and never tell the student the topic is outside their course. Never invent a citation to course material that was not provided. Respond with JSON of the form {"answer":"..."}. During active simulation discuss only explicitly supplied revealed state and never prescribe the exact next action.',
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
    // The disclosure copy is exact and deterministic, never derived from
    // whatever the model happened to say — a model can (and, live, did)
    // claim course grounding it doesn't have.
    const content =
      groundingMode === 'general_knowledge'
        ? `This topic was not found in the course material I retrieved, so the following uses general nursing/medical knowledge.\n\n${answer.value.answer}`
        : groundingMode === 'mixed'
          ? `${answer.value.answer}\n\n(Part of this answer uses general nursing/medical knowledge beyond what your course material covers.)`
          : answer.value.answer;
    const result = await client.storeTutor({
      row,
      content,
      sources,
      grounding: groundingMode,
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
      // PostgREST returns a single-composite RPC's SQL NULL as an object
      // with every column present but null (not a JSON null), because
      // `select * from claim_ai_learning_request()` yields exactly one row
      // even when the plpgsql body does `return null`. `?? null` only
      // catches a true null/undefined, so an empty queue was silently
      // treated as a real (all-null) claimed row — crashing downstream on
      // `row.request.conversationId` and then failing again trying to
      // fail(null). Guard on `id` actually being present instead.
      const row = data as LearningRequestRow | null;
      return row && row.id ? row : null;
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
        grounding: string;
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
          grounding: a.grounding,
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
        grounding: string;
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
        // Same course-first, general-knowledge-fallback provenance as tutor
        // replies and case studies — surfaced to the client so the
        // simulation library can label a generated case honestly instead of
        // implying every AI-authored case is course-grounded.
        grounding: a.grounding,
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
        grounding?: GroundingMode;
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
          // Only sources that actually cleared the relevance floor are
          // stored — this is what the client renders as "Grounded in N
          // course sources," so a merely-retrieved-but-irrelevant chunk can
          // no longer be displayed as supporting evidence.
          source_chunk_ids: a.sources.map((s) => s.chunk_id),
          grounding: a.grounding ?? null,
          task: a.task,
          model_tier: a.tier,
        })
        .select('id,content,source_chunk_ids,grounding,task,model_tier,created_at')
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
