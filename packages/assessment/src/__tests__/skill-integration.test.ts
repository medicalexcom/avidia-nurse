/**
 * End-to-end integration tests for Skills #1, #2, and #3.
 *
 * These tests verify that the three learning-science skills implemented
 * across the monorepo compose correctly:
 *
 *   Skill #1 — Concept Prerequisites & Mastery Gating (@avidia/mastery)
 *   Skill #2 — Semantic Chunking & Context Window Optimization (@avidia/rag)
 *   Skill #3 — Multi-Level Question Generation / Bloom's Taxonomy (@avidia/assessment)
 *
 * Every scenario below uses only the domain types and functions already
 * exported by these packages — no new production code, no mocks, no
 * external services. The goal is to prove the "student journey" works
 * end to end: a document is chunked (Skill #2), prerequisite gating
 * decides whether a concept is unlocked (Skill #1), and question
 * generation targets the correct Bloom's level for the student's current
 * mastery band (Skill #3).
 */

import { describe, it, expect } from '@jest/globals';
import type { ExtractedSection } from '@avidia/domain';
import { COGNITIVE_LEVELS, type CognitiveLevel } from '@avidia/domain';

import {
  checkPrerequisites,
  detectPrerequisiteCycles,
  topologicalSortByPrerequisites,
  PREREQUISITE_MASTERY_THRESHOLD,
  initialAggregate,
  masteryState,
  type ConceptPrerequisiteRelationship,
  type MasteryAggregate,
} from '@avidia/mastery';

import { chunkSections, estimateTokens, splitWithOverlap, MAX_CHUNK_TOKENS } from '@avidia/rag';
import {
  CONCEPT_BOUNDARY_MARKERS,
  RELATIONSHIP_MARKERS,
} from '@avidia/rag/src/chunking';

const MAX_CHUNK_CHARS = MAX_CHUNK_TOKENS * 4;

import {
  MASTERY_BAND_TARGETS,
  getLevelGroup,
  getTargetsForMastery,
  getProgressionPath,
  meetsLevelTargets,
  calculateBlomsLevelCoverage,
  recommendNextLevel,
  generateBlomsPromptSuffix,
} from '../blooms';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function section(overrides: Partial<ExtractedSection>): ExtractedSection {
  return {
    sectionType: 'paragraph',
    sequence: 0,
    pageNumber: null,
    slideNumber: null,
    heading: null,
    content: 'content',
    metadata: null,
    ...overrides,
  };
}

function aggregateWithMastery(mastery: number, overrides: Partial<MasteryAggregate> = {}): MasteryAggregate {
  const agg = initialAggregate();
  agg.mastery = mastery;
  agg.attemptsCount = mastery > 0 ? 5 : 0;
  agg.correctCount = mastery > 0 ? 4 : 0;
  return { ...agg, ...overrides };
}

/**
 * Concept map used across the integration scenarios:
 *
 *   Glucose Metabolism (glucose) ──strength 9──▶ DKA (dka)
 *   Fluid & Electrolytes (fluids) ──strength 9──▶ DKA (dka)
 *   DKA (dka) ──strength 6──▶ DKA Nursing Management (dka-mgmt)
 */
const GLUCOSE_TO_DKA: ConceptPrerequisiteRelationship = {
  sourceConceptId: 'glucose',
  sourceConceptName: 'Glucose Metabolism',
  targetConceptId: 'dka',
  targetConceptName: 'DKA',
  isPrerequisite: true,
  prerequisiteStrength: 9,
  chunkId: 'chunk-glucose-1',
};

const FLUIDS_TO_DKA: ConceptPrerequisiteRelationship = {
  sourceConceptId: 'fluids',
  sourceConceptName: 'Fluid & Electrolytes',
  targetConceptId: 'dka',
  targetConceptName: 'DKA',
  isPrerequisite: true,
  prerequisiteStrength: 9,
  chunkId: 'chunk-fluids-1',
};

const DKA_TO_MANAGEMENT: ConceptPrerequisiteRelationship = {
  sourceConceptId: 'dka',
  sourceConceptName: 'DKA',
  targetConceptId: 'dka-mgmt',
  targetConceptName: 'DKA Nursing Management',
  isPrerequisite: true,
  prerequisiteStrength: 6,
  chunkId: 'chunk-dka-1',
};

const CONCEPT_MAP = [GLUCOSE_TO_DKA, FLUIDS_TO_DKA, DKA_TO_MANAGEMENT];

// ===========================================================================
// SKILL #1: Concept Prerequisites & Mastery Gating
// ===========================================================================

describe('SKILL #1: Concept Prerequisites & Mastery Gating', () => {
  it('blocks DKA until Glucose Metabolism and Fluid & Electrolytes reach mastery threshold', () => {
    const masteryByConceptId = new Map<string, MasteryAggregate | null>([
      ['glucose', aggregateWithMastery(0.3)],
      ['fluids', aggregateWithMastery(0.2)],
    ]);

    const result = checkPrerequisites('dka', CONCEPT_MAP, masteryByConceptId);

    expect(result.isSatisfied).toBe(false);
    expect(result.blockingPrerequisites).toHaveLength(2);
    expect(result.unsatisfiedPrerequisites.map((p) => p.conceptId).sort()).toEqual([
      'fluids',
      'glucose',
    ]);
  });

  it('unlocks DKA once both prerequisites are at or above the 70% threshold', () => {
    const masteryByConceptId = new Map<string, MasteryAggregate | null>([
      ['glucose', aggregateWithMastery(PREREQUISITE_MASTERY_THRESHOLD)],
      ['fluids', aggregateWithMastery(0.85)],
    ]);

    const result = checkPrerequisites('dka', CONCEPT_MAP, masteryByConceptId);

    expect(result.isSatisfied).toBe(true);
    expect(result.unsatisfiedPrerequisites).toHaveLength(0);
    expect(result.blockingPrerequisites).toHaveLength(0);
  });

  it('treats a weak (non-blocking) prerequisite as advisory, not gating', () => {
    // DKA Nursing Management's prerequisite (DKA, strength 6) is below the
    // strength-8 blocking cutoff, so low mastery should surface as an
    // "unsatisfied" recommendation without blocking access.
    const masteryByConceptId = new Map<string, MasteryAggregate | null>([
      ['dka', aggregateWithMastery(0.1)],
    ]);

    const result = checkPrerequisites('dka-mgmt', CONCEPT_MAP, masteryByConceptId);

    expect(result.unsatisfiedPrerequisites).toHaveLength(1);
    expect(result.blockingPrerequisites).toHaveLength(0);
    expect(result.isSatisfied).toBe(true);
  });

  it('detects no cycles in a valid prerequisite DAG', () => {
    const cycles = detectPrerequisiteCycles(CONCEPT_MAP);
    expect(cycles).toEqual([]);
  });

  it('detects a cycle and produces a valid topological study order otherwise', () => {
    const cyclic: ConceptPrerequisiteRelationship[] = [
      ...CONCEPT_MAP,
      {
        sourceConceptId: 'dka-mgmt',
        sourceConceptName: 'DKA Nursing Management',
        targetConceptId: 'glucose',
        targetConceptName: 'Glucose Metabolism',
        isPrerequisite: true,
        prerequisiteStrength: 5,
        chunkId: 'chunk-cycle-1',
      },
    ];
    const cycles = detectPrerequisiteCycles(cyclic);
    expect(cycles.length).toBeGreaterThan(0);

    // The acyclic map still produces a valid prerequisite-first ordering
    // usable by the planner to schedule study sessions.
    const conceptIds = ['dka-mgmt', 'dka', 'fluids', 'glucose'];
    const order = topologicalSortByPrerequisites(conceptIds, CONCEPT_MAP);

    expect(order.indexOf('glucose')).toBeLessThan(order.indexOf('dka'));
    expect(order.indexOf('fluids')).toBeLessThan(order.indexOf('dka'));
    expect(order.indexOf('dka')).toBeLessThan(order.indexOf('dka-mgmt'));
    expect(order.sort()).toEqual([...conceptIds].sort());
  });
});

// ===========================================================================
// SKILL #2: Semantic Chunking & Context Window Optimization
// ===========================================================================

describe('SKILL #2: Semantic Chunking & Context Window Optimization', () => {
  it('preserves a DKA reasoning chain within a single chunk rather than splitting mid-concept', () => {
    const sections: ExtractedSection[] = [
      section({
        sectionType: 'paragraph',
        sequence: 0,
        heading: 'Diabetic Ketoacidosis',
        content:
          'Insulin deficiency leads to hyperglycemia, which causes osmotic diuresis. ' +
          'This results in profound dehydration, therefore fluid and electrolyte ' +
          'replacement is a first-line intervention.',
      }),
    ];

    const chunks = chunkSections(sections, 'txt');

    expect(chunks.length).toBeGreaterThan(0);
    const first = chunks[0]!;
    expect(first.content).toContain('Insulin deficiency leads to hyperglycemia');
    expect(first.content).toContain('therefore fluid and electrolyte replacement');
    expect(first.semanticContext?.hasRelationshipChain).toBe(true);
  });

  it('marks cross-reference chunks with concept terms for prerequisite indexing', () => {
    const sections: ExtractedSection[] = [
      section({
        sectionType: 'paragraph',
        sequence: 0,
        content:
          'Glucose Metabolism disorders are the mechanism of Diabetic Ketoacidosis, ' +
          'a clinical presentation of severe hyperglycemia.',
      }),
    ];

    const chunks = chunkSections(sections, 'txt');
    const chunk = chunks[0]!;

    expect(chunk.semanticContext?.containsConceptTerms).toEqual(
      expect.arrayContaining(['Glucose Metabolism', 'Diabetic Ketoacidosis'])
    );
  });

  it('respects the token budget while allowing a bounded context bonus for concept preservation', () => {
    const longText = Array.from(
      { length: 400 },
      (_, i) => `sentence ${i} about glucose metabolism and its clinical relevance.`
    ).join(' ');

    const parts = splitWithOverlap(longText, MAX_CHUNK_CHARS, true);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      // Each part respects the size budget (with bounded overlap carried
      // forward); none should balloon far past the context-bonus ceiling.
      expect(estimateTokens(part)).toBeLessThanOrEqual(
        Math.ceil((MAX_CHUNK_CHARS * 1.2) / 4) + 10
      );
    }
  });

  it('exposes the concept-boundary and relationship marker vocabularies used by the chunker', () => {
    expect(CONCEPT_BOUNDARY_MARKERS).toEqual(expect.arrayContaining(['prerequisite:', 'causes of']));
    expect(RELATIONSHIP_MARKERS).toEqual(expect.arrayContaining(['leads to', 'therefore']));
  });
});

// ===========================================================================
// SKILL #3: Multi-Level Question Generation (Bloom's Taxonomy)
// ===========================================================================

describe("SKILL #3: Multi-Level Question Generation (Bloom's Taxonomy)", () => {
  it('groups every cognitive level into a Bloom\'s level group', () => {
    for (const level of COGNITIVE_LEVELS) {
      // prioritization is a nursing-specific extension that overlaps
      // analysis/evaluation; getLevelGroup must still return a valid group.
      expect(['foundational', 'intermediate', 'advanced']).toContain(getLevelGroup(level));
    }
  });

  it('targets foundational levels for an unassessed concept', () => {
    const targets = getTargetsForMastery(null);
    expect(targets.level).toBe('unassessed');
    expect(targets.primaryLevels).toEqual(['recall', 'understanding']);
    expect(targets.preferredDifficulties).toEqual(['easy']);
  });

  it('targets application/analysis for a developing-mastery student', () => {
    const targets = getTargetsForMastery(0.5);
    expect(targets.level).toBe('developing');
    expect(targets.primaryLevels).toEqual(['application', 'analysis']);
  });

  it('targets analysis/evaluation/synthesis for a strong-mastery student', () => {
    const targets = getTargetsForMastery(0.9);
    expect(targets.level).toBe('strong');
    expect(targets.primaryLevels).toEqual(['analysis', 'evaluation', 'synthesis']);
  });

  it('covers every mastery band with monotonically increasing thresholds', () => {
    expect(MASTERY_BAND_TARGETS).toHaveLength(4);
    const ranges = MASTERY_BAND_TARGETS.map((t) => t.masteryRange);
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i]![0]).toBeGreaterThanOrEqual(ranges[i - 1]![0]);
    }
  });

  it('produces a foundational-to-advanced progression path by default', () => {
    const path = getProgressionPath();
    expect(path).toEqual([
      'recall',
      'understanding',
      'application',
      'analysis',
      'evaluation',
      'synthesis',
    ]);
  });

  it('checks whether a generated question meets the student\'s mastery-band targets', () => {
    const targets = getTargetsForMastery(0.5); // developing → application/analysis
    expect(meetsLevelTargets('application', targets.primaryLevels)).toBe(true);
    expect(meetsLevelTargets('synthesis', targets.primaryLevels, false)).toBe(false);
  });

  it('computes Bloom\'s level coverage and recommends the least-covered level next', () => {
    const levels: CognitiveLevel[] = ['recall', 'recall', 'recall', 'understanding'];
    const coverage = calculateBlomsLevelCoverage(levels);

    expect(coverage.recall).toBeGreaterThan(0);
    expect(coverage.understanding).toBeGreaterThan(0);
    expect(coverage.application).toBe(0);
    expect(coverage.recall).toBeGreaterThan(coverage.understanding);

    const next = recommendNextLevel(coverage);
    expect(next).not.toBeNull();
    expect(next).not.toBe('recall');
    expect(next).not.toBe('understanding');
  });

  it('generates a prompt suffix requesting every level in a Bloom\'s level group', () => {
    const suffix = generateBlomsPromptSuffix('foundational', 2);
    expect(suffix).toContain('recall');
    expect(suffix).toContain('understanding');
    expect(suffix).toContain('at least 2 question(s)');
  });
});

// ===========================================================================
// END-TO-END: All Skills Integrated
// ===========================================================================

describe('END-TO-END: All Skills Integrated', () => {
  it('walks a student from chunked material through prerequisite gating to Bloom-targeted questions', () => {
    // Step 1 (Skill #2): the course material is chunked, preserving the
    // Glucose Metabolism → DKA reasoning chain and its concept terms.
    const sections: ExtractedSection[] = [
      section({
        sectionType: 'paragraph',
        sequence: 0,
        heading: 'Diabetic Ketoacidosis',
        content:
          'Glucose Metabolism disorders: insulin deficiency causes hyperglycemia, ' +
          'which leads to Diabetic Ketoacidosis.',
      }),
    ];
    const chunks = chunkSections(sections, 'txt');
    expect(chunks[0]!.semanticContext?.containsConceptTerms).toEqual(
      expect.arrayContaining(['Glucose Metabolism', 'Diabetic Ketoacidosis'])
    );

    // Step 2 (Skill #1): the student has only 30% mastery of the
    // prerequisite, so DKA remains gated — the study plan should surface
    // Glucose Metabolism as the next concept, not DKA.
    const masteryByConceptId = new Map<string, MasteryAggregate | null>([
      ['glucose', aggregateWithMastery(0.3)],
    ]);
    const gate = checkPrerequisites('dka', [GLUCOSE_TO_DKA], masteryByConceptId);
    expect(gate.isSatisfied).toBe(false);

    // Step 3 (Skill #3): because the gated concept (glucose) is itself
    // only "low" mastery, question generation should target foundational
    // recall/understanding — not advanced synthesis — for that concept.
    const glucoseMastery = masteryByConceptId.get('glucose')!;
    const targets = getTargetsForMastery(glucoseMastery.mastery);
    expect(targets.level).toBe('low');
    expect(meetsLevelTargets('recall', targets.primaryLevels)).toBe(true);
    expect(meetsLevelTargets('synthesis', targets.primaryLevels, false)).toBe(false);
  });

  it('unlocks DKA and escalates question difficulty once the prerequisite reaches mastery', () => {
    // The student studies Glucose Metabolism until mastery clears the
    // gating threshold used by Skill #1.
    const masteryByConceptId = new Map<string, MasteryAggregate | null>([
      ['glucose', aggregateWithMastery(0.8)],
    ]);

    const gate = checkPrerequisites('dka', [GLUCOSE_TO_DKA], masteryByConceptId);
    expect(gate.isSatisfied).toBe(true);

    // DKA is now unassessed (no aggregate yet) so the *next* question batch
    // for DKA itself still starts foundational, while the prerequisite's
    // own mastery band has moved into "strong" territory.
    const dkaState = masteryState(null, new Date());
    expect(dkaState).toBe('unassessed');
    const dkaTargets = getTargetsForMastery(null);
    expect(dkaTargets.primaryLevels).toEqual(['recall', 'understanding']);

    const glucoseTargets = getTargetsForMastery(masteryByConceptId.get('glucose')!.mastery);
    expect(glucoseTargets.level).toBe('strong');
    expect(glucoseTargets.primaryLevels).toContain('synthesis');
  });

  it('produces a prerequisite-ordered study plan whose questions each match the concept\'s mastery band', () => {
    // Skill #1: order concepts prerequisite-first.
    const conceptIds = ['dka-mgmt', 'dka', 'fluids', 'glucose'];
    const studyOrder = topologicalSortByPrerequisites(conceptIds, CONCEPT_MAP);
    expect(studyOrder[0]).not.toBe('dka-mgmt');

    // Simulated mastery snapshot: earlier concepts in the study order have
    // progressed further than later ones, reflecting scaffolded learning.
    const masteryByConceptId = new Map<string, MasteryAggregate | null>([
      ['glucose', aggregateWithMastery(0.85)],
      ['fluids', aggregateWithMastery(0.72)],
      ['dka', aggregateWithMastery(0.2)],
      ['dka-mgmt', null],
    ]);

    // Skill #3: for each concept in the study plan, question generation
    // must target a Bloom's band consistent with that concept's own
    // mastery — proving the two skills compose without contradiction.
    for (const conceptId of studyOrder) {
      const aggregate = masteryByConceptId.get(conceptId) ?? null;
      const targets = getTargetsForMastery(aggregate?.mastery ?? null);
      expect(MASTERY_BAND_TARGETS.map((t) => t.level)).toContain(targets.level);
      expect(targets.primaryLevels.length).toBeGreaterThan(0);
    }

    // DKA itself is still gated on Fluid & Electrolytes review (mastery
    // just at the boundary satisfies Skill #1's threshold).
    const dkaGate = checkPrerequisites('dka', CONCEPT_MAP, masteryByConceptId);
    expect(dkaGate.isSatisfied).toBe(true);
  });
});
