import {
  CONCEPT_RELATIONSHIP_LABELS,
  CONCEPT_RELATIONSHIP_TYPES,
  CONCEPT_TYPE_LABELS,
  CONCEPT_TYPES,
  isConceptRelationshipType,
  isConceptType,
  KNOWLEDGE_STATUSES,
} from './concepts';

describe('concept taxonomy (M6 spec B)', () => {
  it('covers the nursing categories study logic needs', () => {
    for (const expected of [
      'disease_disorder',
      'medication',
      'laboratory',
      'nursing_priority',
      'complication',
      'patient_education',
      'other',
    ]) {
      expect(CONCEPT_TYPES).toContain(expected);
    }
  });

  it('has a student-facing label for every type', () => {
    for (const type of CONCEPT_TYPES) {
      expect(CONCEPT_TYPE_LABELS[type]).toBeTruthy();
    }
  });

  it('type guard accepts taxonomy values and rejects everything else', () => {
    expect(isConceptType('medication')).toBe(true);
    expect(isConceptType('disease')).toBe(false);
    expect(isConceptType('')).toBe(false);
  });
});

describe('concept relationship taxonomy (M6 spec I)', () => {
  it('supports the clinically meaningful directed kinds', () => {
    for (const expected of [
      'may_cause',
      'may_lead_to',
      'associated_with',
      'treats',
      'adverse_effect_of',
      'commonly_confused_with',
    ]) {
      expect(CONCEPT_RELATIONSHIP_TYPES).toContain(expected);
    }
  });

  it('has a readable label for every relationship type', () => {
    for (const type of CONCEPT_RELATIONSHIP_TYPES) {
      expect(CONCEPT_RELATIONSHIP_LABELS[type]).toBeTruthy();
    }
  });

  it('relationship type guard rejects unknown kinds', () => {
    expect(isConceptRelationshipType('may_cause')).toBe(true);
    expect(isConceptRelationshipType('cures')).toBe(false);
  });
});

describe('knowledge lifecycle (M6 spec N)', () => {
  it('is a separate pending/extracting/ready/failed lifecycle', () => {
    expect(KNOWLEDGE_STATUSES).toEqual(['pending', 'extracting', 'ready', 'failed']);
  });
});
