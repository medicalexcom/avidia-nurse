/**
 * Prerequisite gating and validation — learning path scaffolding.
 *
 * A student cannot advance to mastery of a topic until prerequisites are
 * satisfied (default: ≥70% mastery). This implements learning science
 * principles of scaffolding and prerequisite mastery.
 *
 * Spec: Concept prerequisites prevent "DKA before Glucose Metabolism"
 * by gating topic access, suggesting prerequisite review, and front-loading
 * prerequisites in study schedules.
 */

import type { MasteryAggregate } from './update';

export const PREREQUISITE_MASTERY_THRESHOLD = 0.7;

/**
 * Relationship between two concepts with prerequisite metadata.
 * Extracted from course materials and stored in concept_relationships.
 */
export interface ConceptPrerequisiteRelationship {
  sourceConceptId: string;
  sourceConceptName: string;
  targetConceptId: string;
  targetConceptName: string;
  isPrerequisite: boolean;
  /** Strength 1-10: how essential this prerequisite is (9-10 = blocking, 5-6 = helpful) */
  prerequisiteStrength: number | null;
  /** Evidence: which chunk evidences this relationship */
  chunkId: string;
}

/**
 * Prerequisite check result: is the target concept's prerequisites satisfied?
 */
export interface PrerequisiteCheckResult {
  isSatisfied: boolean;
  /** Prerequisite mastery values (only includes is_prerequisite=true relationships) */
  unsatisfiedPrerequisites: Array<{
    conceptName: string;
    conceptId: string;
    currentMastery: number | null;
    requiredMastery: number;
    strength: number | null;
  }>;
  blockingPrerequisites: Array<{
    conceptName: string;
    conceptId: string;
    strength: number | null;
  }>;
}

/**
 * Check whether a student can advance to a concept given prerequisite mastery.
 *
 * `prerequisites`: all prerequisites for `targetConceptId`
 * `masteryByConceptId`: current mastery aggregate for each concept (null = unassessed)
 *
 * Returns { isSatisfied: true } if all prerequisites ≥ PREREQUISITE_MASTERY_THRESHOLD
 * (or no prerequisites exist).
 * Otherwise returns unsatisfied and blocking prerequisites for UI feedback.
 */
export function checkPrerequisites(
  targetConceptId: string,
  prerequisites: ConceptPrerequisiteRelationship[],
  masteryByConceptId: Map<string, MasteryAggregate | null>
): PrerequisiteCheckResult {
  const prereqsForTarget = prerequisites.filter((r) => r.targetConceptId === targetConceptId && r.isPrerequisite);

  if (prereqsForTarget.length === 0) {
    return { isSatisfied: true, unsatisfiedPrerequisites: [], blockingPrerequisites: [] };
  }

  const unsatisfied: PrerequisiteCheckResult['unsatisfiedPrerequisites'] = [];
  const blocking: PrerequisiteCheckResult['blockingPrerequisites'] = [];

  for (const prereq of prereqsForTarget) {
    const mastery = masteryByConceptId.get(prereq.sourceConceptId);
    const masteryValue = mastery?.mastery ?? null;
    const isSatisfied = masteryValue !== null && masteryValue >= PREREQUISITE_MASTERY_THRESHOLD;

    if (!isSatisfied) {
      unsatisfied.push({
        conceptName: prereq.sourceConceptName,
        conceptId: prereq.sourceConceptId,
        currentMastery: masteryValue,
        requiredMastery: PREREQUISITE_MASTERY_THRESHOLD,
        strength: prereq.prerequisiteStrength,
      });

      // Blocking = strength 8+ (essential prerequisites)
      if (prereq.prerequisiteStrength !== null && prereq.prerequisiteStrength >= 8) {
        blocking.push({
          conceptName: prereq.sourceConceptName,
          conceptId: prereq.sourceConceptId,
          strength: prereq.prerequisiteStrength,
        });
      }
    }
  }

  return {
    isSatisfied: blocking.length === 0,
    unsatisfiedPrerequisites: unsatisfied,
    blockingPrerequisites: blocking,
  };
}

/**
 * Detect cycles in prerequisite relationships (DAG validation).
 * Returns empty array if valid DAG, otherwise returns cycle path.
 *
 * Example cycle: A → B → C → A would be invalid.
 */
export function detectPrerequisiteCycles(
  relationships: ConceptPrerequisiteRelationship[]
): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recursionStack = new Map<string, string[]>();

  const dfs = (conceptId: string, path: string[]): void => {
    visited.add(conceptId);
    recursionStack.set(conceptId, path);

    const outgoing = relationships.filter(
      (r) => r.sourceConceptId === conceptId && r.isPrerequisite
    );

    for (const edge of outgoing) {
      const nextId = edge.targetConceptId;
      const nextPath = [...path, nextId];

      if (!visited.has(nextId)) {
        dfs(nextId, nextPath);
      } else if (recursionStack.has(nextId)) {
        // Cycle found
        const cycleStart = recursionStack.get(nextId)!.indexOf(nextId);
        if (cycleStart !== -1) {
          cycles.push(recursionStack.get(nextId)!.slice(cycleStart).concat(conceptId, nextId));
        }
      }
    }

    recursionStack.delete(conceptId);
  };

  // Check all nodes in case graph is disconnected
  const allConceptIds = new Set<string>();
  for (const rel of relationships) {
    allConceptIds.add(rel.sourceConceptId);
    allConceptIds.add(rel.targetConceptId);
  }

  for (const conceptId of allConceptIds) {
    if (!visited.has(conceptId)) {
      dfs(conceptId, [conceptId]);
    }
  }

  return cycles;
}

/**
 * Topological sort of concepts respecting prerequisite order.
 * Concepts with no prerequisites come first, then concepts whose
 * prerequisites are already satisfied.
 *
 * Used by planner to schedule prerequisites before dependents.
 * Returns concept IDs in dependency order (prerequisites before dependents).
 */
export function topologicalSortByPrerequisites(
  conceptIds: string[],
  relationships: ConceptPrerequisiteRelationship[]
): string[] {
  const inDegree = new Map<string, number>();
  const adjacencyList = new Map<string, string[]>();

  // Initialize
  for (const id of conceptIds) {
    inDegree.set(id, 0);
    adjacencyList.set(id, []);
  }

  // Build graph: prerequisite → dependent
  for (const rel of relationships) {
    if (rel.isPrerequisite && conceptIds.includes(rel.sourceConceptId) && conceptIds.includes(rel.targetConceptId)) {
      const list = adjacencyList.get(rel.sourceConceptId) || [];
      if (!list.includes(rel.targetConceptId)) {
        list.push(rel.targetConceptId);
        adjacencyList.set(rel.sourceConceptId, list);
      }
      inDegree.set(rel.targetConceptId, (inDegree.get(rel.targetConceptId) || 0) + 1);
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const id of conceptIds) {
    if ((inDegree.get(id) || 0) === 0) {
      queue.push(id);
    }
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);

    for (const neighbor of adjacencyList.get(node) || []) {
      const newDegree = (inDegree.get(neighbor) || 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  // Handle cycles (shouldn't happen if detectPrerequisiteCycles passed)
  const remaining = conceptIds.filter((id) => !sorted.includes(id));
  return [...sorted, ...remaining];
}
