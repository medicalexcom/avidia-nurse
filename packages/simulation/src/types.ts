/**
 * Simulation domain model — M11 (spec A/B/C/E/F/H/I/J/K/L/AA/AX/AY).
 *
 * CORE PRINCIPLE: the LLM is NOT the simulation engine. Everything in this
 * file is structured, deterministic, versioned data. A case definition is a
 * closed rulebook; the engine (engine.ts) is a pure interpreter over it. No
 * AI provider is ever consulted to decide physiologic truth at runtime.
 *
 * The authoritative interpreter for LIVE sessions is the SQL mirror in
 * supabase/migrations/0011_patient_simulation.sql (same double-maintenance
 * contract as scoring/mastery — ADR-0020/ADR-0022). This TypeScript engine
 * is the executable specification: every semantic rule is pinned by tests
 * here, and any change requires bumping SIMULATION_ENGINE_VERSION in BOTH
 * implementations (spec AY).
 */

import type { CognitiveLevel, QuestionDifficulty } from '@avidia/domain';

/** Version of the engine semantics (spec AY). Bump in lockstep with SQL. */
export const SIMULATION_ENGINE_VERSION = 1;

// ---------------------------------------------------------------------------
// Vitals (spec J)
// ---------------------------------------------------------------------------

export const VITAL_KEYS = ['hr', 'sbp', 'dbp', 'rr', 'spo2', 'temp_c', 'pain', 'glucose'] as const;
export type VitalKey = (typeof VITAL_KEYS)[number];

/** A case tracks only the vitals it declares; absent keys are untracked. */
export type Vitals = Partial<Record<VitalKey, number>>;

/**
 * Hard physiologic bounds (spec J/BB invariant): no rule effect may ever push
 * a vital outside these, regardless of what a case definition says.
 */
export const PHYSIOLOGIC_BOUNDS: Record<VitalKey, { min: number; max: number }> = {
  hr: { min: 20, max: 220 },
  sbp: { min: 40, max: 260 },
  dbp: { min: 20, max: 160 },
  rr: { min: 4, max: 60 },
  spo2: { min: 50, max: 100 },
  temp_c: { min: 30, max: 43 },
  pain: { min: 0, max: 10 },
  glucose: { min: 10, max: 900 },
};

export const VITAL_LABELS: Record<VitalKey, string> = {
  hr: 'Heart rate',
  sbp: 'Systolic BP',
  dbp: 'Diastolic BP',
  rr: 'Respiratory rate',
  spo2: 'SpO2',
  temp_c: 'Temperature (°C)',
  pain: 'Pain (0–10)',
  glucose: 'Glucose (mg/dL)',
};

// ---------------------------------------------------------------------------
// Assessment systems (spec M)
// ---------------------------------------------------------------------------

export const ASSESSMENT_SYSTEMS = [
  'respiratory',
  'cardiovascular',
  'neurological',
  'gi',
  'gu',
  'skin',
  'pain',
  'peripheral_vascular',
  'endocrine',
] as const;
export type AssessmentSystem = (typeof ASSESSMENT_SYSTEMS)[number];

export const ASSESSMENT_SYSTEM_LABELS: Record<AssessmentSystem, string> = {
  respiratory: 'Respiratory',
  cardiovascular: 'Cardiovascular',
  neurological: 'Neurological',
  gi: 'GI',
  gu: 'GU',
  skin: 'Skin',
  pain: 'Pain',
  peripheral_vascular: 'Peripheral vascular',
  endocrine: 'Endocrine',
};

// ---------------------------------------------------------------------------
// Patient profile (spec B) — always fictional, never PHI (spec AV)
// ---------------------------------------------------------------------------

export interface PatientProfile {
  /** Fictional display name, e.g. "Mr. Ortiz". Never a real identifier. */
  name: string;
  age: number;
  sex: 'female' | 'male';
  heightCm?: number;
  weightKg?: number;
  allergies: string[];
  codeStatus: string;
  chiefComplaint: string;
  admittingDiagnosis: string;
  history: string[];
  homeMedications: string[];
  /** Admission/baseline vitals — chart data, visible from the start. */
  baselineVitals: Vitals;
}

// ---------------------------------------------------------------------------
// Findings, labs, medication orders (spec K/L/N)
// ---------------------------------------------------------------------------

export interface CaseFinding {
  id: string;
  system: AssessmentSystem;
  /** Student-facing finding text once revealed. */
  text: string;
  /** Present in the patient at simulation start (may change via rules). */
  presentAtStart: boolean;
  /** A key cue for scoring recognize_cues (never sent to the client). */
  keyCue: boolean;
}

export type LabFlag = 'normal' | 'low' | 'high' | 'critical';

export interface CaseLab {
  id: string;
  name: string;
  unit: string;
  value: number;
  flag: LabFlag;
  /** Already resulted (in the chart) at simulation start. */
  availableAtStart: boolean;
}

export interface CaseMedicationOrder {
  id: string;
  medication: string;
  dose: string;
  route: string;
  frequency: string;
  status: 'scheduled' | 'prn' | 'ordered';
  /** Optional chart note, e.g. "hold for SBP < 100". */
  note?: string;
}

// ---------------------------------------------------------------------------
// Action model + controlled catalog (spec E/F)
// ---------------------------------------------------------------------------

/** The closed, controlled set of action types (spec F). */
export const ACTION_TYPES = [
  'assess',
  'reassess',
  'obtain_vitals',
  'administer_medication',
  'hold_medication',
  'position_patient',
  'apply_oxygen',
  'notify_provider',
  'activate_rrt',
  'request_lab',
  'check_glucose',
  'educate_patient',
  'ambulate_patient',
  'implement_precaution',
  'ask_patient',
  'delegate_task',
  'wait',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/**
 * How the case classifies an action in context (spec F/R). Never sent to the
 * client before the action is taken.
 */
export const ACTION_CLASSIFICATIONS = [
  'appropriate',
  'unnecessary',
  'premature',
  'contraindicated',
  'unsafe',
] as const;
export type ActionClassification = (typeof ACTION_CLASSIFICATIONS)[number];

export interface CaseAction {
  id: string;
  type: ActionType;
  label: string;
  /** Step-based time cost (spec H): how many simulated minutes this takes. */
  timeCostMinutes: number;
  /** Snapshot the patient's current vitals as observed (spec N). */
  observesVitals?: boolean;
  /** Focused assessment: reveal present findings in these systems (spec M/N). */
  revealsSystems?: AssessmentSystem[];
  /** ask_patient actions require a dialogue prompt id parameter. */
  promptRequired?: boolean;
  classification: {
    default: ActionClassification;
    /** Phase-specific overrides, e.g. premature before a cue exists. */
    byPhase?: Record<string, ActionClassification>;
  };
}

/** A submitted student action (spec E). */
export interface SubmittedAction {
  actionId: string;
  /** ask_patient: { promptId: string }. Other types: usually empty. */
  params?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Rules: conditions, effects, triggers (spec D/G/I/P)
// ---------------------------------------------------------------------------

export type Condition =
  | { kind: 'time_at_least'; minutes: number }
  | { kind: 'phase_is'; phase: string }
  | { kind: 'vital_at_most'; vital: VitalKey; value: number }
  | { kind: 'vital_at_least'; vital: VitalKey; value: number }
  | { kind: 'action_done'; actionId: string }
  | { kind: 'action_not_done'; actionId: string }
  | { kind: 'finding_revealed'; findingId: string }
  | { kind: 'deterioration_at_least'; level: number }
  | { kind: 'flag_set'; flag: string }
  | { kind: 'flag_not_set'; flag: string };

export type Effect =
  | { kind: 'vital_delta'; vital: VitalKey; delta: number; min?: number; max?: number }
  | { kind: 'vital_set'; vital: VitalKey; value: number }
  | { kind: 'set_phase'; phase: string }
  | { kind: 'set_finding_present'; findingId: string; present: boolean }
  | { kind: 'reveal_finding'; findingId: string }
  | { kind: 'release_lab'; labId: string }
  | { kind: 'set_lab_value'; labId: string; value: number; flag: LabFlag }
  | { kind: 'schedule'; scheduleId: string; afterMinutes: number; effects: Effect[] }
  | { kind: 'cancel_scheduled'; scheduleId: string }
  | { kind: 'set_deterioration'; level: number }
  | { kind: 'add_flag'; flag: string }
  | { kind: 'patient_statement'; statementId: string }
  | { kind: 'end'; outcomeId: string };

export type RuleTrigger =
  { kind: 'action'; actionId: string } | { kind: 'time' } | { kind: 'phase_enter'; phase: string };

export interface Rule {
  id: string;
  /**
   * Explanatory metadata (spec AS): a student-readable sentence for the
   * debrief, e.g. "Oxygenation worsened because the PE remained untreated."
   */
  description: string;
  trigger: RuleTrigger;
  conditions: Condition[];
  effects: Effect[];
  /** Fire at most once per session (default behavior for every rule). */
  once: boolean;
}

// ---------------------------------------------------------------------------
// Outcomes, critical actions, scoring (spec P/Q/S/AP)
// ---------------------------------------------------------------------------

export type OutcomeKind = 'stabilized' | 'deteriorated' | 'complication' | 'timeout';

export interface CaseOutcome {
  id: string;
  kind: OutcomeKind;
  label: string;
  /** Debrief summary of what this ending means (spec AQ). */
  summary: string;
}

export interface CriticalAction {
  id: string;
  label: string;
  /** Performing ANY of these actions satisfies the critical action. */
  anyOfActionIds: string[];
  /** Deadline in simulated minutes, if timeliness matters (spec Q). */
  byMinutes?: number;
}

/** NCSBN clinical-judgment dimensions (Playbook §18, Blueprint §11). */
export const CJMM_DIMENSIONS = [
  'recognize_cues',
  'analyze_cues',
  'prioritize_hypotheses',
  'generate_solutions',
  'take_action',
  'evaluate_outcomes',
] as const;
export type CjmmDimension = (typeof CJMM_DIMENSIONS)[number];

export const CJMM_LABELS: Record<CjmmDimension, string> = {
  recognize_cues: 'Recognize cues',
  analyze_cues: 'Analyze cues',
  prioritize_hypotheses: 'Prioritize hypotheses',
  generate_solutions: 'Generate solutions',
  take_action: 'Take action',
  evaluate_outcomes: 'Evaluate outcomes',
};

export type ScoringCriterion =
  | { kind: 'critical_action_done'; actionId: string; byMinutes?: number }
  | { kind: 'any_action_done'; actionIds: string[]; byMinutes?: number }
  | { kind: 'cue_revealed'; findingId: string; byMinutes?: number }
  | { kind: 'vitals_obtained'; byMinutes?: number }
  | { kind: 'no_unsafe_actions' }
  | { kind: 'action_not_done'; actionId: string }
  | { kind: 'reassessed_after'; actionId: string; withinMinutes: number }
  | { kind: 'outcome_is'; outcomeId: string };

export interface ScoringEntry {
  id: string;
  dimension: CjmmDimension;
  points: number;
  criterion: ScoringCriterion;
  /** Student-facing explanation of what earned/missed these points. */
  label: string;
}

// ---------------------------------------------------------------------------
// Dialogue (spec AG): deterministic scripted responses
// ---------------------------------------------------------------------------

export interface DialoguePrompt {
  id: string;
  /** The question the student can ask, e.g. "Are you having chest pain?" */
  question: string;
  /** Scripted patient answer drawn from structured case state. */
  response: string;
  /** Only give the full response once this finding has been revealed. */
  requiresFindingRevealed?: string;
  /** Response when the gate is not met (defaults to a neutral reply). */
  gatedResponse?: string;
}

/** Spontaneous patient statements triggered by rules (deterioration cues). */
export interface PatientStatement {
  id: string;
  text: string;
}

// ---------------------------------------------------------------------------
// Concept mappings → M8 evidence (spec T/U/AD)
// ---------------------------------------------------------------------------

export interface ConceptMapping {
  /** Human name, e.g. "Pulmonary embolism". */
  conceptName: string;
  /** normalizeConceptKey(conceptName) — precomputed, checked by validation. */
  conceptKey: string;
  difficulty: QuestionDifficulty;
  cognitiveLevel: CognitiveLevel;
  /** Which scored dimensions constitute evidence for this concept. */
  dimensions: CjmmDimension[];
}

// ---------------------------------------------------------------------------
// The full case definition (spec A/AA/AX)
// ---------------------------------------------------------------------------

export type ScenarioType = 'deterioration' | 'medication_safety' | 'metabolic' | 'general';

export interface SimulationCaseDefinition {
  /** Stable slug, e.g. "postop_pe_v1". */
  caseId: string;
  title: string;
  description: string;
  difficulty: QuestionDifficulty;
  scenarioType: ScenarioType;
  estimatedDurationMinutes: number;
  /** Case content version (spec AX). Bump on any rule/content change. */
  caseVersion: number;
  /** Engine semantics this case was authored against (spec AY). */
  engineVersion: number;
  patient: PatientProfile;
  phases: string[];
  initialPhase: string;
  /** Legal phase transitions (spec D): from → allowed targets. */
  phaseFlow: Record<string, string[]>;
  /** Initial TRUE vitals (hidden until observed — spec N). */
  initialVitals: Vitals;
  findings: CaseFinding[];
  labs: CaseLab[];
  medicationOrders: CaseMedicationOrder[];
  actions: CaseAction[];
  dialogue: DialoguePrompt[];
  statements: PatientStatement[];
  rules: Rule[];
  outcomes: CaseOutcome[];
  criticalActions: CriticalAction[];
  scoring: ScoringEntry[];
  conceptMappings: ConceptMapping[];
  /** Debrief "recommended review" topics (spec AQ). */
  debriefRecommendations: string[];
}

// ---------------------------------------------------------------------------
// Patient state (spec C) — the authoritative structured state
// ---------------------------------------------------------------------------

export interface ActionLogEntry {
  seq: number;
  actionId: string;
  atMinutes: number;
  classification: ActionClassification;
}

export interface ScheduledEffects {
  scheduleId: string;
  atMinutes: number;
  effects: Effect[];
}

export interface PatientState {
  engineVersion: number;
  caseId: string;
  caseVersion: number;
  phase: string;
  /** Simulated minutes since start (spec H). Never decreases (spec BB). */
  timeMinutes: number;
  deteriorationLevel: number;
  /** TRUE current vitals — hidden; the student sees only observedVitals. */
  vitals: Vitals;
  /** Last vitals snapshot the student actually obtained (spec N). */
  observedVitals: { vitals: Vitals; atMinutes: number } | null;
  findings: Record<string, { present: boolean; revealed: boolean }>;
  labs: Record<string, { released: boolean; value: number; flag: LabFlag }>;
  safetyFlags: string[];
  /** Spontaneous statements the patient has made (visible). */
  statements: Array<{ statementId: string; atMinutes: number }>;
  actionLog: ActionLogEntry[];
  scheduled: ScheduledEffects[];
  firedRules: string[];
  completed: { outcomeId: string; atMinutes: number } | null;
}

// ---------------------------------------------------------------------------
// Events (spec I) — every event carries a visibility flag (spec N):
// visible=false events exist only in the server-side record until debrief.
// ---------------------------------------------------------------------------

export type SimulationEvent =
  | { type: 'action_accepted'; actionId: string; label: string; atMinutes: number; visible: true }
  | { type: 'vitals_observed'; vitals: Vitals; atMinutes: number; visible: true }
  | {
      type: 'finding_revealed';
      findingId: string;
      system: AssessmentSystem;
      text: string;
      atMinutes: number;
      visible: true;
    }
  | { type: 'no_new_findings'; system: AssessmentSystem; atMinutes: number; visible: true }
  | {
      type: 'lab_released';
      labId: string;
      name: string;
      value: number;
      unit: string;
      flag: LabFlag;
      atMinutes: number;
      visible: true;
    }
  | { type: 'patient_statement'; text: string; atMinutes: number; visible: true }
  | { type: 'dialogue'; question: string; response: string; atMinutes: number; visible: true }
  | { type: 'completed'; outcomeId: string; label: string; atMinutes: number; visible: true }
  | {
      type: 'action_classified';
      actionId: string;
      classification: ActionClassification;
      atMinutes: number;
      visible: false;
    }
  | {
      type: 'vital_change';
      vital: VitalKey;
      from: number;
      to: number;
      atMinutes: number;
      visible: false;
    }
  | { type: 'phase_changed'; phase: string; atMinutes: number; visible: false }
  | { type: 'deterioration_changed'; level: number; atMinutes: number; visible: false }
  | { type: 'safety_flag'; flag: string; atMinutes: number; visible: false }
  | { type: 'rule_fired'; ruleId: string; description: string; atMinutes: number; visible: false };

export type VisibleSimulationEvent = Extract<SimulationEvent, { visible: true }>;

// ---------------------------------------------------------------------------
// Engine results
// ---------------------------------------------------------------------------

export type ActionRejection =
  'simulation_completed' | 'unknown_action' | 'missing_prompt_param' | 'unknown_prompt';

export interface ApplyResult {
  state: PatientState;
  events: SimulationEvent[];
  rejected: ActionRejection | null;
}
