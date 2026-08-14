/**
 * Built-in case: symptomatic hypoglycemia (spec AF).
 *
 * Metabolic scenario. Verified deterministic paths (pinned in tests):
 *  - Optimal:  check glucose (t2) → neuro/skin assessment (t4) → oral carbs
 *              (t7, treated) → 15-minute recheck (t22) → o_resolved.
 *  - Crisis:   untreated at t10 → confusion (det 1); untreated at t18 →
 *              glucose 32, unresponsive, phase "crisis" (det 2). Oral carbs
 *              are now UNSAFE (aspiration); IV dextrose recovers the patient.
 *  - Unsafe:   administering the scheduled insulin drops glucose to ≤ 20 →
 *              o_complication.
 *  - Untreated at t40 → o_deteriorated; hard timeout at t50 → o_timeout.
 *
 * Fictional patient; educational use only (spec AU/AV).
 */

import type { SimulationCaseDefinition } from '../types';
import { SIMULATION_ENGINE_VERSION } from '../types';

export const hypoglycemiaCase: SimulationCaseDefinition = {
  caseId: 'hypoglycemia',
  title: 'Diaphoretic and shaky before breakfast',
  description:
    'An insulin-dependent patient who has been NPO becomes diaphoretic, tremulous, and anxious. ' +
    'Confirm the cause, treat it by the right route, and verify the response.',
  difficulty: 'easy',
  scenarioType: 'metabolic',
  estimatedDurationMinutes: 15,
  caseVersion: 1,
  engineVersion: SIMULATION_ENGINE_VERSION,
  patient: {
    name: 'Ms. Chen',
    age: 67,
    sex: 'female',
    heightCm: 160,
    weightKg: 58,
    allergies: ['Sulfa (rash)'],
    codeStatus: 'Full code',
    chiefComplaint: 'Sudden shakiness, sweating, and anxiety',
    admittingDiagnosis: 'Cellulitis of the left leg; type 2 diabetes on basal-bolus insulin',
    history: [
      'Type 2 diabetes (insulin-dependent)',
      'Hypertension',
      'NPO since midnight for imaging',
    ],
    homeMedications: [
      'Insulin glargine 24 units nightly',
      'Insulin lispro sliding scale',
      'Amlodipine 5 mg daily',
    ],
    baselineVitals: { hr: 84, sbp: 130, dbp: 78, rr: 16, spo2: 98, temp_c: 36.7, glucose: 132 },
  },
  phases: ['hypoglycemic', 'crisis', 'recovering'],
  initialPhase: 'hypoglycemic',
  phaseFlow: {
    hypoglycemic: ['crisis', 'recovering'],
    crisis: ['recovering'],
    recovering: [],
  },
  initialVitals: { hr: 112, sbp: 118, dbp: 72, rr: 20, spo2: 97, temp_c: 36.6, glucose: 48 },
  findings: [
    {
      id: 'f_diaphoresis',
      system: 'skin',
      text: 'Skin is cool, pale, and visibly diaphoretic.',
      presentAtStart: true,
      keyCue: true,
    },
    {
      id: 'f_tremor',
      system: 'neurological',
      text: 'Fine tremor of both hands; patient reports feeling shaky and anxious.',
      presentAtStart: true,
      keyCue: true,
    },
    {
      id: 'f_confusion',
      system: 'neurological',
      text: 'Increasingly confused; slow to answer and unsure of where she is.',
      presentAtStart: false,
      keyCue: true,
    },
    {
      id: 'f_unresponsive',
      system: 'neurological',
      text: 'Unresponsive to voice; does not follow commands.',
      presentAtStart: false,
      keyCue: true,
    },
  ],
  labs: [
    {
      id: 'lab_a1c',
      name: 'Hemoglobin A1c (admission)',
      unit: '%',
      value: 8.2,
      flag: 'high',
      availableAtStart: true,
    },
  ],
  medicationOrders: [
    {
      id: 'ord_lispro',
      medication: 'Insulin lispro',
      dose: 'Sliding scale',
      route: 'Subcutaneous',
      frequency: 'Before meals',
      status: 'scheduled',
      note: 'Patient has been NPO since midnight.',
    },
    {
      id: 'ord_d50',
      medication: 'Dextrose 50%',
      dose: '25 g',
      route: 'IV push',
      frequency: 'PRN glucose < 70 with altered mentation',
      status: 'prn',
    },
    {
      id: 'ord_juice',
      medication: 'Oral fast-acting carbohydrate (juice, 15 g)',
      dose: '15 g',
      route: 'PO',
      frequency: 'PRN glucose < 70, patient alert',
      status: 'prn',
    },
  ],
  actions: [
    {
      id: 'a_check_glucose',
      type: 'check_glucose',
      label: 'Check point-of-care glucose and vitals',
      timeCostMinutes: 2,
      observesVitals: true,
      classification: { default: 'appropriate' },
    },
    {
      id: 'a_assess_neuro',
      type: 'assess',
      label: 'Focused assessment (neuro, skin)',
      timeCostMinutes: 2,
      revealsSystems: ['neurological', 'skin'],
      classification: { default: 'appropriate' },
    },
    {
      id: 'a_obtain_vitals',
      type: 'obtain_vitals',
      label: 'Obtain a full set of vital signs',
      timeCostMinutes: 2,
      observesVitals: true,
      classification: { default: 'appropriate' },
    },
    {
      id: 'a_give_oral_carbs',
      type: 'administer_medication',
      label: 'Give 15 g fast-acting oral carbohydrate',
      timeCostMinutes: 3,
      classification: { default: 'appropriate', byPhase: { crisis: 'unsafe' } },
    },
    {
      id: 'a_give_iv_dextrose',
      type: 'administer_medication',
      label: 'Administer dextrose 50% IV per protocol',
      timeCostMinutes: 3,
      classification: { default: 'appropriate' },
    },
    {
      id: 'a_give_insulin',
      type: 'administer_medication',
      label: 'Administer the scheduled sliding-scale insulin',
      timeCostMinutes: 2,
      classification: { default: 'contraindicated' },
    },
    {
      id: 'a_recheck_glucose',
      type: 'check_glucose',
      label: 'Recheck glucose in 15 minutes',
      timeCostMinutes: 15,
      observesVitals: true,
      classification: { default: 'appropriate' },
    },
    {
      id: 'a_notify_provider',
      type: 'notify_provider',
      label: 'Notify the provider',
      timeCostMinutes: 3,
      classification: { default: 'appropriate' },
    },
    {
      id: 'a_ask_patient',
      type: 'ask_patient',
      label: 'Ask the patient a question',
      timeCostMinutes: 1,
      promptRequired: true,
      classification: { default: 'appropriate' },
    },
    {
      id: 'a_wait',
      type: 'wait',
      label: 'Wait and monitor (5 minutes)',
      timeCostMinutes: 5,
      classification: { default: 'appropriate' },
    },
  ],
  dialogue: [
    {
      id: 'dp_feeling',
      question: 'How are you feeling right now?',
      response: 'Shaky… sweaty. Like my heart is racing. I haven’t eaten since last night.',
    },
    {
      id: 'dp_eaten',
      question: 'When did you last eat, and did you get insulin?',
      response:
        'Nothing since midnight — they said no breakfast. But I got my nighttime insulin as usual.',
    },
  ],
  statements: [
    { id: 'st_fuzzy', text: 'I feel… fuzzy. What was I saying?' },
    { id: 'st_better', text: 'Oh, that’s better. The shakiness is settling down.' },
    { id: 'st_recovered', text: 'I’m okay… what happened? I felt so strange.' },
  ],
  rules: [
    {
      id: 'r_worsening',
      description:
        'Untreated hypoglycemia progressed: glucose kept falling and confusion appeared.',
      trigger: { kind: 'time' },
      conditions: [
        { kind: 'time_at_least', minutes: 10 },
        { kind: 'flag_not_set', flag: 'treated' },
      ],
      effects: [
        { kind: 'vital_delta', vital: 'glucose', delta: -10, min: 25 },
        { kind: 'set_finding_present', findingId: 'f_confusion', present: true },
        { kind: 'reveal_finding', findingId: 'f_confusion' },
        { kind: 'set_deterioration', level: 1 },
        { kind: 'patient_statement', statementId: 'st_fuzzy' },
      ],
      once: true,
    },
    {
      id: 'r_crisis',
      description:
        'Prolonged untreated hypoglycemia caused neuroglycopenia: the patient became unresponsive.',
      trigger: { kind: 'time' },
      conditions: [
        { kind: 'time_at_least', minutes: 18 },
        { kind: 'flag_not_set', flag: 'treated' },
      ],
      effects: [
        { kind: 'vital_set', vital: 'glucose', value: 32 },
        { kind: 'vital_delta', vital: 'hr', delta: 10, max: 150 },
        { kind: 'set_phase', phase: 'crisis' },
        { kind: 'set_finding_present', findingId: 'f_unresponsive', present: true },
        { kind: 'reveal_finding', findingId: 'f_unresponsive' },
        { kind: 'set_deterioration', level: 2 },
      ],
      once: true,
    },
    {
      id: 'r_oral_treat',
      description:
        'Oral fast-acting carbohydrate corrected the glucose while the patient could swallow safely.',
      trigger: { kind: 'action', actionId: 'a_give_oral_carbs' },
      conditions: [{ kind: 'phase_is', phase: 'hypoglycemic' }],
      effects: [
        { kind: 'vital_delta', vital: 'glucose', delta: 45, max: 160 },
        { kind: 'vital_delta', vital: 'hr', delta: -20, min: 80 },
        { kind: 'add_flag', flag: 'treated' },
        { kind: 'set_deterioration', level: 0 },
        { kind: 'patient_statement', statementId: 'st_better' },
      ],
      once: true,
    },
    {
      id: 'r_oral_aspiration',
      description:
        'Giving oral carbohydrate to an unresponsive patient caused aspiration: nothing by mouth without a protected airway.',
      trigger: { kind: 'action', actionId: 'a_give_oral_carbs' },
      conditions: [{ kind: 'phase_is', phase: 'crisis' }],
      effects: [
        { kind: 'vital_delta', vital: 'spo2', delta: -6, min: 80 },
        { kind: 'add_flag', flag: 'aspiration_event' },
      ],
      once: true,
    },
    {
      id: 'r_d50',
      description: 'IV dextrose rapidly restored the glucose and mental status.',
      trigger: { kind: 'action', actionId: 'a_give_iv_dextrose' },
      conditions: [],
      effects: [
        { kind: 'vital_delta', vital: 'glucose', delta: 120, max: 220 },
        { kind: 'vital_delta', vital: 'hr', delta: -20, min: 80 },
        { kind: 'set_finding_present', findingId: 'f_unresponsive', present: false },
        { kind: 'set_finding_present', findingId: 'f_confusion', present: false },
        { kind: 'add_flag', flag: 'treated' },
        { kind: 'set_deterioration', level: 0 },
        { kind: 'set_phase', phase: 'recovering' },
        { kind: 'patient_statement', statementId: 'st_recovered' },
      ],
      once: true,
    },
    {
      id: 'r_insulin',
      description:
        'Administering insulin to an already hypoglycemic patient drove the glucose to a critical low.',
      trigger: { kind: 'action', actionId: 'a_give_insulin' },
      conditions: [],
      effects: [{ kind: 'vital_delta', vital: 'glucose', delta: -30, min: 15 }],
      once: true,
    },
    {
      id: 'r_seizure',
      description: 'Critical hypoglycemia (glucose ≤ 20 mg/dL) precipitated a seizure.',
      trigger: { kind: 'time' },
      conditions: [{ kind: 'vital_at_most', vital: 'glucose', value: 20 }],
      effects: [{ kind: 'end', outcomeId: 'o_complication' }],
      once: true,
    },
    {
      id: 'r_resolved_end',
      description: 'The follow-up glucose confirmed the treatment worked.',
      trigger: { kind: 'action', actionId: 'a_recheck_glucose' },
      conditions: [{ kind: 'flag_set', flag: 'treated' }],
      effects: [
        { kind: 'set_phase', phase: 'recovering' },
        { kind: 'end', outcomeId: 'o_resolved' },
      ],
      once: true,
    },
    {
      id: 'r_untreated_end',
      description: 'Hypoglycemia was never treated; the patient remained unresponsive.',
      trigger: { kind: 'time' },
      conditions: [
        { kind: 'time_at_least', minutes: 40 },
        { kind: 'flag_not_set', flag: 'treated' },
      ],
      effects: [{ kind: 'end', outcomeId: 'o_deteriorated' }],
      once: true,
    },
    {
      id: 'r_timeout',
      description: 'The scenario reached its time limit.',
      trigger: { kind: 'time' },
      conditions: [{ kind: 'time_at_least', minutes: 50 }],
      effects: [{ kind: 'end', outcomeId: 'o_timeout' }],
      once: true,
    },
  ],
  outcomes: [
    {
      id: 'o_resolved',
      kind: 'stabilized',
      label: 'Hypoglycemia resolved and verified',
      summary:
        'The low glucose was confirmed, treated by an appropriate route, and rechecked. ' +
        'Verifying the response is part of the treatment, not an afterthought.',
    },
    {
      id: 'o_deteriorated',
      kind: 'deteriorated',
      label: 'Patient remained unresponsive',
      summary:
        'The hypoglycemia was never corrected. Neuroglycopenia progresses from confusion to ' +
        'unresponsiveness; treatment cannot wait for more data once the glucose is known.',
    },
    {
      id: 'o_complication',
      kind: 'complication',
      label: 'Hypoglycemic seizure',
      summary:
        'Glucose fell to a critical low and the patient seized. Giving insulin during a ' +
        'hypoglycemic event is a never-event: always match the medication to the current glucose.',
    },
    {
      id: 'o_timeout',
      kind: 'timeout',
      label: 'Scenario time expired',
      summary:
        'The scenario ended at its time limit before a definitive outcome. Hypoglycemia is one of ' +
        'the most time-sensitive findings on a med-surg unit.',
    },
  ],
  criticalActions: [
    {
      id: 'ca_check',
      label: 'Confirm the glucose with a point-of-care check within 10 minutes',
      anyOfActionIds: ['a_check_glucose'],
      byMinutes: 10,
    },
    {
      id: 'ca_treat',
      label: 'Treat the hypoglycemia within 25 minutes',
      anyOfActionIds: ['a_give_oral_carbs', 'a_give_iv_dextrose'],
      byMinutes: 25,
    },
    {
      id: 'ca_recheck',
      label: 'Recheck the glucose after treating',
      anyOfActionIds: ['a_recheck_glucose'],
    },
  ],
  scoring: [
    {
      id: 's_cue_tremor',
      dimension: 'recognize_cues',
      points: 2,
      criterion: { kind: 'cue_revealed', findingId: 'f_tremor', byMinutes: 12 },
      label: 'Assessed the patient and recognized the adrenergic cues (tremor, diaphoresis).',
    },
    {
      id: 's_vitals_early',
      dimension: 'recognize_cues',
      points: 2,
      criterion: { kind: 'vitals_obtained', byMinutes: 8 },
      label: 'Obtained objective data (glucose and vitals) within the first 8 minutes.',
    },
    {
      id: 's_confirm_glucose',
      dimension: 'analyze_cues',
      points: 3,
      criterion: { kind: 'critical_action_done', actionId: 'a_check_glucose', byMinutes: 8 },
      label: 'Confirmed the suspected cause with a point-of-care glucose before treating.',
    },
    {
      id: 's_treat_priority',
      dimension: 'prioritize_hypotheses',
      points: 2,
      criterion: {
        kind: 'any_action_done',
        actionIds: ['a_give_oral_carbs', 'a_give_iv_dextrose'],
        byMinutes: 12,
      },
      label: 'Treated the hypoglycemia as the immediate priority (within 12 minutes).',
    },
    {
      id: 's_treat',
      dimension: 'generate_solutions',
      points: 2,
      criterion: {
        kind: 'any_action_done',
        actionIds: ['a_give_oral_carbs', 'a_give_iv_dextrose'],
        byMinutes: 25,
      },
      label: 'Corrected the glucose using an ordered treatment.',
    },
    {
      id: 's_no_unsafe',
      dimension: 'take_action',
      points: 2,
      criterion: { kind: 'no_unsafe_actions' },
      label: 'Avoided unsafe routes and contraindicated medications.',
    },
    {
      id: 's_no_insulin',
      dimension: 'take_action',
      points: 2,
      criterion: { kind: 'action_not_done', actionId: 'a_give_insulin' },
      label: 'Held the scheduled insulin while the patient was hypoglycemic and NPO.',
    },
    {
      id: 's_recheck',
      dimension: 'evaluate_outcomes',
      points: 3,
      criterion: { kind: 'critical_action_done', actionId: 'a_recheck_glucose' },
      label: 'Rechecked the glucose to verify the treatment worked.',
    },
    {
      id: 's_outcome',
      dimension: 'evaluate_outcomes',
      points: 2,
      criterion: { kind: 'outcome_is', outcomeId: 'o_resolved' },
      label: 'Resolved the event and confirmed recovery.',
    },
  ],
  conceptMappings: [
    {
      conceptName: 'Hypoglycemia management',
      conceptKey: 'hypoglycemia management',
      difficulty: 'easy',
      cognitiveLevel: 'application',
      dimensions: ['analyze_cues', 'prioritize_hypotheses', 'take_action'],
    },
    {
      conceptName: 'Blood glucose monitoring',
      conceptKey: 'blood glucose monitoring',
      difficulty: 'easy',
      cognitiveLevel: 'understanding',
      dimensions: ['recognize_cues', 'evaluate_outcomes'],
    },
  ],
  debriefRecommendations: [
    'The 15-15 rule for treating hypoglycemia',
    'Adrenergic versus neuroglycopenic signs of hypoglycemia',
    'Route selection: when oral carbohydrate becomes unsafe',
    'Insulin safety for NPO patients',
  ],
};
