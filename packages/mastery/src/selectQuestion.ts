/**
 * Adaptive question selection — M8 (spec U/V/W/X/Y/AN).
 *
 * Builds an adaptive session's question order from the PERSISTED M7 bank:
 * no AI generation per selection, no network, no randomness beyond a seeded
 * deterministic PRNG (same session seed ⇒ same order, spec AB/V).
 *
 * Selection preferences, in order:
 *   1. concepts by descending study priority (from the recommendation
 *      ranking), interleaved for diversity (spec W);
 *   2. within a concept, questions matching the mastery-appropriate target
 *      characteristics (spec U), unseen before seen (avoid immediate
 *      repeats), then stable seeded shuffle;
 *   3. graceful fallback: when preferred questions run out, ANY remaining
 *      question is acceptable — a session never fails for lack of ideal
 *      items (spec AN), it only reports QUESTION_SUPPLY_LOW upstream.
 *
 * Diversity bounds (spec W, config.DIVERSITY): at most
 * MAX_CONSECUTIVE_SAME_CONCEPT in a row, and no concept exceeds
 * ceil(size × MAX_CONCEPT_SHARE) of the session when others have supply.
 */

import type { CognitiveLevel, QuestionDifficulty } from '@avidia/domain';
import { DIVERSITY } from './config';
import type { StudyRecommendation } from './recommend';

export interface SelectableQuestion {
  questionId: string;
  conceptId: string | null;
  difficulty: QuestionDifficulty;
  cognitiveLevel: CognitiveLevel;
  /** Already answered by this student in any prior session. */
  seen: boolean;
}

/** Deterministic 32-bit string hash (FNV-1a) — no node built-ins. */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — small deterministic PRNG. */
function mulberry32(state: number): () => number {
  let a = state >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    // i and j are always in bounds; index access is safe here.
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function matchScore(
  question: SelectableQuestion,
  recommendation: StudyRecommendation | undefined
): number {
  if (!recommendation) return 0;
  const target = recommendation.recommendedQuestionCharacteristics;
  let score = 0;
  if (target.difficulties.includes(question.difficulty)) score += 1;
  if (target.cognitiveLevels.includes(question.cognitiveLevel)) score += 1;
  return score;
}

export interface AdaptiveSelectionInput {
  questions: readonly SelectableQuestion[];
  /** Ranked concepts, highest priority first (rankConcepts output). */
  ranked: readonly StudyRecommendation[];
  sessionSize: number;
  /** Session seed (e.g. the session id) — determinism anchor (spec V/AB). */
  seed: string;
}

/**
 * Deterministic adaptive question order (spec U/V/W). Returns at most
 * sessionSize question ids; fewer when the whole bank is smaller (the
 * caller surfaces QUESTION_SUPPLY_LOW, spec Y — never an AI call).
 */
export function buildAdaptiveQuestionOrder(input: AdaptiveSelectionInput): string[] {
  const { questions, ranked, sessionSize, seed } = input;
  if (sessionSize <= 0 || questions.length === 0) return [];

  const rand = mulberry32(hashSeed(seed));
  const byRecommendation = new Map(ranked.map((r) => [r.conceptId, r]));
  const conceptOrder: (string | null)[] = ranked.map((r) => r.conceptId);
  // Questions without a concept (or whose concept is unranked) form a
  // trailing pool — usable, lowest preference.
  const rankedIds = new Set(conceptOrder);
  const hasUnranked = questions.some((q) => q.conceptId === null || !rankedIds.has(q.conceptId));
  if (hasUnranked) conceptOrder.push(null);

  // Per-concept queues: preferred-characteristic unseen → other unseen →
  // seen, each bucket seeded-shuffled for variety, order stable per seed.
  const queues = new Map<string | null, SelectableQuestion[]>();
  for (const key of conceptOrder) {
    const pool = questions.filter((q) =>
      key === null ? q.conceptId === null || !rankedIds.has(q.conceptId) : q.conceptId === key
    );
    const rec = key === null ? undefined : byRecommendation.get(key);
    const shuffled = seededShuffle(pool, rand);
    shuffled.sort((a, b) => {
      const seenDiff = Number(a.seen) - Number(b.seen);
      if (seenDiff !== 0) return seenDiff; // unseen first (spec U)
      return matchScore(b, rec) - matchScore(a, rec); // better match first
    });
    if (shuffled.length > 0) queues.set(key, shuffled);
  }

  const maxShare = Math.ceil(sessionSize * DIVERSITY.MAX_CONCEPT_SHARE);
  const picked: string[] = [];
  const conceptCounts = new Map<string | null, number>();
  let lastConcept: string | null | undefined;
  let consecutive = 0;

  while (picked.length < sessionSize) {
    let chosen: { key: string | null; question: SelectableQuestion } | null = null;
    let relaxedChoice: { key: string | null; question: SelectableQuestion } | null = null;

    for (const key of conceptOrder) {
      const queue = queues.get(key);
      if (!queue || queue.length === 0) continue;
      const candidate = { key, question: queue[0]! }; // length checked above
      if (relaxedChoice === null) relaxedChoice = candidate;
      const count = conceptCounts.get(key) ?? 0;
      const wouldExceedRun =
        key === lastConcept && consecutive >= DIVERSITY.MAX_CONSECUTIVE_SAME_CONCEPT;
      const wouldExceedShare = count >= maxShare;
      if (!wouldExceedRun && !wouldExceedShare) {
        chosen = candidate;
        break;
      }
    }
    // Diversity bounds only bind while alternatives exist; with a single
    // remaining supply the session still fills (spec W bounded, spec AN).
    const pick = chosen ?? relaxedChoice;
    if (pick === null) break;

    const queue = queues.get(pick.key)!;
    queue.shift();
    picked.push(pick.question.questionId);
    conceptCounts.set(pick.key, (conceptCounts.get(pick.key) ?? 0) + 1);
    if (pick.key === lastConcept) {
      consecutive += 1;
    } else {
      lastConcept = pick.key;
      consecutive = 1;
    }
  }

  return picked;
}
