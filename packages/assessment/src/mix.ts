/**
 * Balanced question mixing (M7 spec V/Z — deliberately NOT adaptive).
 *
 * Two pure, deterministic helpers:
 *
 *   - pickGenerationConcepts: which concepts a generation run should cover
 *     (bounded, emphasis-ordered — spec Y cost control, spec AA emphasis as
 *     metadata only).
 *   - buildSessionQuestionOrder: which questions a practice session shows and
 *     in what order. Seeded, so a session is reproducible from its id, and
 *     round-robin across concepts so one heavily-covered concept cannot
 *     monopolize a session. There is no mastery input anywhere here — that
 *     is M8 (spec AL).
 */

export interface MixableQuestion {
  id: string;
  conceptId: string | null;
  questionType: string;
  difficulty: string;
}

/** Deterministic 32-bit hash of a string seed (FNV-1a). */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Mulberry32 — small deterministic PRNG; quality is irrelevant, repeatability is not. */
function createRandom(seed: string): () => number {
  let state = hashSeed(seed) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}

/**
 * Bounded concept selection for one generation run (spec Y): highest-emphasis
 * concepts first (spec AA — a mixing signal, never a promise about exams),
 * capped so a single document never triggers unbounded generation.
 */
export function pickGenerationConcepts<T extends { key: string; emphasisScore: number }>(
  concepts: readonly T[],
  limit: number
): T[] {
  return [...concepts]
    .sort((a, b) => b.emphasisScore - a.emphasisScore || a.key.localeCompare(b.key))
    .slice(0, Math.max(0, limit));
}

/**
 * Session selection (spec V/Z): seeded shuffle, then round-robin across
 * concepts so the session spreads over the course rather than drilling one
 * concept, then a final seeded shuffle so the presentation order does not
 * expose the grouping. Deterministic for a given (seed, pool).
 */
export function buildSessionQuestionOrder<T extends MixableQuestion>(
  pool: readonly T[],
  count: number,
  seed: string
): T[] {
  if (count <= 0 || pool.length === 0) {
    return [];
  }
  const random = createRandom(seed);
  // Stable base order first so the result depends only on ids + seed.
  const shuffled = shuffle(
    [...pool].sort((a, b) => a.id.localeCompare(b.id)),
    random
  );
  const byConcept = new Map<string, T[]>();
  for (const question of shuffled) {
    const key = question.conceptId ?? '(none)';
    const bucket = byConcept.get(key);
    if (bucket) {
      bucket.push(question);
    } else {
      byConcept.set(key, [question]);
    }
  }
  const buckets = [...byConcept.values()];
  const picked: T[] = [];
  let depth = 0;
  while (picked.length < count) {
    let pickedAny = false;
    for (const bucket of buckets) {
      const question = bucket[depth];
      if (question !== undefined && picked.length < count) {
        picked.push(question);
        pickedAny = true;
      }
    }
    if (!pickedAny) {
      break; // pool exhausted
    }
    depth += 1;
  }
  return shuffle(picked, random);
}
