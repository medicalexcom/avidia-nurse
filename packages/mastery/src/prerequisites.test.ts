import { describe, it, expect } from '@jest/globals';
import {
  checkPrerequisites,
  detectPrerequisiteCycles,
  topologicalSortByPrerequisites,
  type ConceptPrerequisiteRelationship,
} from './prerequisites';
import { initialAggregate } from './update';

describe('Prerequisites', () => {
  describe('checkPrerequisites', () => {
    it('returns satisfied=true when no prerequisites exist', () => {
      const result = checkPrerequisites('concept-1', [], new Map());
      expect(result.isSatisfied).toBe(true);
      expect(result.unsatisfiedPrerequisites).toHaveLength(0);
    });

    it('returns satisfied=true when all prerequisites >= 70%', () => {
      const prereqs: ConceptPrerequisiteRelationship[] = [
        {
          sourceConceptId: 'glucose',
          sourceConceptName: 'Glucose Metabolism',
          targetConceptId: 'dka',
          targetConceptName: 'DKA',
          isPrerequisite: true,
          prerequisiteStrength: 9,
          chunkId: 'chunk-1',
        },
      ];

      const mastery = initialAggregate();
      mastery.mastery = 0.75;
      const masteryMap = new Map([['glucose', mastery]]);

      const result = checkPrerequisites('dka', prereqs, masteryMap);
      expect(result.isSatisfied).toBe(true);
      expect(result.unsatisfiedPrerequisites).toHaveLength(0);
    });

    it('returns unsatisfied when prerequisite < 70%', () => {
      const prereqs: ConceptPrerequisiteRelationship[] = [
        {
          sourceConceptId: 'glucose',
          sourceConceptName: 'Glucose Metabolism',
          targetConceptId: 'dka',
          targetConceptName: 'DKA',
          isPrerequisite: true,
          prerequisiteStrength: 9,
          chunkId: 'chunk-1',
        },
      ];

      const mastery = initialAggregate();
      mastery.mastery = 0.5;
      const masteryMap = new Map([['glucose', mastery]]);

      const result = checkPrerequisites('dka', prereqs, masteryMap);
      expect(result.isSatisfied).toBe(false);
      expect(result.unsatisfiedPrerequisites).toHaveLength(1);
      expect(result.unsatisfiedPrerequisites[0].conceptName).toBe('Glucose Metabolism');
      expect(result.unsatisfiedPrerequisites[0].currentMastery).toBe(0.5);
    });

    it('marks as blocking when strength >= 8 and unsatisfied', () => {
      const prereqs: ConceptPrerequisiteRelationship[] = [
        {
          sourceConceptId: 'glucose',
          sourceConceptName: 'Glucose Metabolism',
          targetConceptId: 'dka',
          targetConceptName: 'DKA',
          isPrerequisite: true,
          prerequisiteStrength: 9, // Essential
          chunkId: 'chunk-1',
        },
      ];

      const mastery = initialAggregate();
      mastery.mastery = 0.5;
      const masteryMap = new Map([['glucose', mastery]]);

      const result = checkPrerequisites('dka', prereqs, masteryMap);
      expect(result.blockingPrerequisites).toHaveLength(1);
      expect(result.blockingPrerequisites[0].conceptName).toBe('Glucose Metabolism');
    });

    it('ignores non-prerequisite relationships', () => {
      const prereqs: ConceptPrerequisiteRelationship[] = [
        {
          sourceConceptId: 'glucose',
          sourceConceptName: 'Glucose Metabolism',
          targetConceptId: 'dka',
          targetConceptName: 'DKA',
          isPrerequisite: false, // NOT a prerequisite
          prerequisiteStrength: null,
          chunkId: 'chunk-1',
        },
      ];

      const masteryMap = new Map();
      const result = checkPrerequisites('dka', prereqs, masteryMap);
      expect(result.isSatisfied).toBe(true);
      expect(result.unsatisfiedPrerequisites).toHaveLength(0);
    });
  });

  describe('detectPrerequisiteCycles', () => {
    it('returns empty array for DAG', () => {
      const rels: ConceptPrerequisiteRelationship[] = [
        {
          sourceConceptId: 'a',
          sourceConceptName: 'A',
          targetConceptId: 'b',
          targetConceptName: 'B',
          isPrerequisite: true,
          prerequisiteStrength: 5,
          chunkId: 'chunk-1',
        },
        {
          sourceConceptId: 'b',
          sourceConceptName: 'B',
          targetConceptId: 'c',
          targetConceptName: 'C',
          isPrerequisite: true,
          prerequisiteStrength: 5,
          chunkId: 'chunk-2',
        },
      ];

      const cycles = detectPrerequisiteCycles(rels);
      expect(cycles).toHaveLength(0);
    });

    it('detects 3-node cycle', () => {
      const rels: ConceptPrerequisiteRelationship[] = [
        {
          sourceConceptId: 'a',
          sourceConceptName: 'A',
          targetConceptId: 'b',
          targetConceptName: 'B',
          isPrerequisite: true,
          prerequisiteStrength: 5,
          chunkId: 'chunk-1',
        },
        {
          sourceConceptId: 'b',
          sourceConceptName: 'B',
          targetConceptId: 'c',
          targetConceptName: 'C',
          isPrerequisite: true,
          prerequisiteStrength: 5,
          chunkId: 'chunk-2',
        },
        {
          sourceConceptId: 'c',
          sourceConceptName: 'C',
          targetConceptId: 'a',
          targetConceptName: 'A',
          isPrerequisite: true,
          prerequisiteStrength: 5,
          chunkId: 'chunk-3',
        },
      ];

      const cycles = detectPrerequisiteCycles(rels);
      expect(cycles.length).toBeGreaterThan(0);
    });
  });

  describe('topologicalSortByPrerequisites', () => {
    it('sorts prerequisites before dependents', () => {
      const rels: ConceptPrerequisiteRelationship[] = [
        {
          sourceConceptId: 'glucose',
          sourceConceptName: 'Glucose',
          targetConceptId: 'insulin',
          targetConceptName: 'Insulin',
          isPrerequisite: true,
          prerequisiteStrength: 9,
          chunkId: 'chunk-1',
        },
        {
          sourceConceptId: 'insulin',
          sourceConceptName: 'Insulin',
          targetConceptId: 'dka',
          targetConceptName: 'DKA',
          isPrerequisite: true,
          prerequisiteStrength: 9,
          chunkId: 'chunk-2',
        },
      ];

      const sorted = topologicalSortByPrerequisites(['glucose', 'insulin', 'dka'], rels);
      expect(sorted).toEqual(['glucose', 'insulin', 'dka']);
    });

    it('handles multiple independent chains', () => {
      const rels: ConceptPrerequisiteRelationship[] = [
        {
          sourceConceptId: 'a',
          sourceConceptName: 'A',
          targetConceptId: 'b',
          targetConceptName: 'B',
          isPrerequisite: true,
          prerequisiteStrength: 5,
          chunkId: 'chunk-1',
        },
        {
          sourceConceptId: 'c',
          sourceConceptName: 'C',
          targetConceptId: 'd',
          targetConceptName: 'D',
          isPrerequisite: true,
          prerequisiteStrength: 5,
          chunkId: 'chunk-2',
        },
      ];

      const sorted = topologicalSortByPrerequisites(['a', 'b', 'c', 'd'], rels);
      expect(sorted).toContain('a');
      expect(sorted).toContain('b');
      expect(sorted.indexOf('a')).toBeLessThan(sorted.indexOf('b'));
      expect(sorted.indexOf('c')).toBeLessThan(sorted.indexOf('d'));
    });
  });
});
