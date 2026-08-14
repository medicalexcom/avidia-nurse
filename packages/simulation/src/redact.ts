/**
 * Client view redaction — M11 (spec N/AJ).
 *
 * The ONLY simulation payload a student's device may receive while a session
 * is in progress. Everything hidden stays out: unrevealed findings, true
 * current vitals, the internal phase name, deterioration level, safety
 * flags, rule state, schedules, key-cue markers, and action classifications.
 * The SQL RPCs build exactly this shape server-side; this function is the
 * pinned specification (and is used by tests to prove no leakage).
 */

import type {
  ActionType,
  AssessmentSystem,
  CaseMedicationOrder,
  LabFlag,
  PatientProfile,
  PatientState,
  SimulationCaseDefinition,
  Vitals,
} from './types';

export interface ClientActionView {
  id: string;
  type: ActionType;
  label: string;
  timeCostMinutes: number;
  promptRequired: boolean;
}

export interface ClientView {
  caseId: string;
  title: string;
  description: string;
  difficulty: string;
  scenarioType: string;
  estimatedDurationMinutes: number;
  caseVersion: number;
  engineVersion: number;
  patient: PatientProfile;
  medicationOrders: CaseMedicationOrder[];
  timeMinutes: number;
  observedVitals: { vitals: Vitals; atMinutes: number } | null;
  revealedFindings: Array<{ id: string; system: AssessmentSystem; text: string }>;
  releasedLabs: Array<{ id: string; name: string; value: number; unit: string; flag: LabFlag }>;
  statements: Array<{ text: string; atMinutes: number }>;
  availableActions: ClientActionView[];
  dialoguePrompts: Array<{ id: string; question: string }>;
  completed: { outcomeId: string; label: string; kind: string; atMinutes: number } | null;
}

/** Build the redacted student-facing view of a session (spec N/AJ). */
export function clientView(caseDef: SimulationCaseDefinition, state: PatientState): ClientView {
  const revealedFindings = caseDef.findings
    .filter((finding) => state.findings[finding.id]?.revealed === true)
    .map((finding) => ({ id: finding.id, system: finding.system, text: finding.text }));
  const releasedLabs = caseDef.labs
    .filter((lab) => state.labs[lab.id]?.released === true)
    .map((lab) => ({
      id: lab.id,
      name: lab.name,
      value: state.labs[lab.id]!.value,
      unit: lab.unit,
      flag: state.labs[lab.id]!.flag,
    }));
  const statements = state.statements
    .map((entry) => {
      const statement = caseDef.statements.find((s) => s.id === entry.statementId);
      return statement ? { text: statement.text, atMinutes: entry.atMinutes } : null;
    })
    .filter((s): s is { text: string; atMinutes: number } => s !== null);
  const outcome = state.completed
    ? caseDef.outcomes.find((o) => o.id === state.completed!.outcomeId)
    : undefined;
  return {
    caseId: caseDef.caseId,
    title: caseDef.title,
    description: caseDef.description,
    difficulty: caseDef.difficulty,
    scenarioType: caseDef.scenarioType,
    estimatedDurationMinutes: caseDef.estimatedDurationMinutes,
    caseVersion: caseDef.caseVersion,
    engineVersion: caseDef.engineVersion,
    patient: caseDef.patient,
    medicationOrders: caseDef.medicationOrders,
    timeMinutes: state.timeMinutes,
    observedVitals: state.observedVitals,
    revealedFindings,
    releasedLabs,
    statements,
    availableActions: caseDef.actions.map((action) => ({
      id: action.id,
      type: action.type,
      label: action.label,
      timeCostMinutes: action.timeCostMinutes,
      promptRequired: action.promptRequired === true,
    })),
    dialoguePrompts: caseDef.dialogue.map((prompt) => ({
      id: prompt.id,
      question: prompt.question,
    })),
    completed:
      state.completed === null
        ? null
        : {
            outcomeId: state.completed.outcomeId,
            label: outcome ? outcome.label : state.completed.outcomeId,
            kind: outcome ? outcome.kind : 'timeout',
            atMinutes: state.completed.atMinutes,
          },
  };
}
