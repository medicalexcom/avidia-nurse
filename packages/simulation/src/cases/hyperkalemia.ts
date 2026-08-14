/**
 * Built-in case: hyperkalemia medication safety (spec AF).
 *
 * Medication-safety scenario. A critical K+ of 6.4 is already in the chart,
 * yet an erroneous KCl order sits on the MAR. Verified deterministic paths
 * (pinned in tests):
 *  - Optimal:  cardiac assessment (t2) → vitals (t4) → hold KCl (t5) →
 *              ECG (t7, reveals peaked T waves) → notify (t10, new orders
 *              arrive t15) → wait (t15) → give treatment (t19, treated) →
 *              reassess (t22) → o_managed.
 *  - Unsafe:   administering the KCl schedules a cardiac arrest 10 minutes
 *              later (o_arrest) — cancellable only by notifying the provider.
 *  - Delayed:  never escalated → bradycardia worsens; untreated at t42 →
 *              o_deteriorated. Hard timeout at t50 → o_timeout.
 *
 * Fictional patient; educational use only (spec AU/AV).
 */

import type { SimulationCaseDefinition } from '../types';
import { SIMULATION_ENGINE_VERSION } from '../types';

export const hyperkalemiaCase: SimulationCaseDefinition = {
  caseId: 'hyperkalemia_med_safety',
  title: 'A critical potassium and a questionable order',
  description:
    'A dialysis patient who missed a session has a critical potassium result — and a potassium ' +
    'supplement still active on the MAR. Catch the error, escalate, and manage the hyperkalemia.',
  difficulty: 'hard',
  scenarioType: 'medication_safety',
  estimatedDurationMinutes: 25,
  caseVersion: 1,
  engineVersion: SIMULATION_ENGINE_VERSION,
  patient: {
    name: 'Mr. Okafor',
    age: 58,
    sex: 'male',
    heightCm: 175,
    weightKg: 82,
    allergies: ['No known allergies'],
    codeStatus: 'Full code',
    chiefComplaint: 'Weakness and palpitations after a missed dialysis session',
    admittingDiagnosis: 'CKD stage 4 on hemodialysis; missed last scheduled session',
    history: [
      'Chronic kidney disease stage 4',
      'Type 2 diabetes',
      'Heart failure with preserved EF',
    ],
    homeMedications: ['Lisinopril 20 mg daily', 'Metformin (held)', 'Sevelamer with meals'],
    baselineVitals: { hr: 74, sbp: 152, dbp: 88, rr: 16, spo2: 97, temp_c: 36.9 },
  },
  phases: ['recognition', 'management'],
  initialPhase: 'recognition',
  phaseFlow: {
    recognition: ['management'],
    management: [],
  },
  initialVitals: { hr: 62, sbp: 148, dbp: 86, rr: 18, spo2: 96, temp_c: 36.8 },
  findings: [
    {
      id: 'f_irregular_pulse',
      system: 'cardiovascular',
      text: 'Pulse is irregular with occasional dropped beats.',
      presentAtStart: true,
      keyCue: true,
    },
    {
      id: 'f_muscle_weakness',
      system: 'neurological',
      text: 'New generalized muscle weakness; grips weak bilaterally.',
      presentAtStart: true,
      keyCue: true,
    },
    {
      id: 'f_peaked_t',
      system: 'cardiovascular',
      text: '12-lead ECG shows tall, peaked T waves with a widening QRS.',
      presentAtStart: false,
      keyCue: true,
    },
    {
      id: 'f_bradycardia_sx',
      system: 'cardiovascular',
      text: 'Increasingly bradycardic; patient reports feeling faint.',
      presentAtStart: false,
      keyCue: false,
    },
  ],
  labs: [
    {
      id: 'lab_k',
      name: 'Potassium',
      unit: 'mEq/L',
      value: 6.4,
      flag: 'critical',
      availableAtStart: true,
    },
    {
      id: 'lab_cr',
      name: 'Creatinine',
      unit: 'mg/dL',
      value: 5.8,
      flag: 'critical',
      availableAtStart: true,
    },
    {
      id: 'lab_bun',
      name: 'BUN',
      unit: 'mg/dL',
      value: 68,
      flag: 'high',
      availableAtStart: true,
    },
  ],
  medicationOrders: [
    {
      id: 'ord_kcl',
      medication: 'Potassium chloride',
      dose: '20 mEq',
      route: 'PO',
      frequency: 'Daily',
      status: 'scheduled',
      note: 'Ordered on admission before today’s labs resulted.',
    },
    {
      id: 'ord_lisinopril',
      medication: 'Lisinopril',
      dose: '20 mg',
      route: 'PO',
      frequency: 'Daily',
      status: 'scheduled',
    },
  ],
  actions: [
    {
      id: 'a_assess_cardiac',
      type: 'assess',
      label: 'Focused cardiovascular and neuro assessment',
      timeCostMinutes: 2,
      revealsSystems: ['cardiovascular', 'neurological'],
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
      id: 'a_hold_kcl',
      type: 'hold_medication',
      label: 'Hold the scheduled potassium chloride',
      timeCostMinutes: 1,
      classification: { default: 'appropriate' },
    },
    {
      id: 'a_give_kcl',
      type: 'administer_medication',
      label: 'Administer the scheduled potassium chloride 20 mEq',
      timeCostMinutes: 2,
      classification: { default: 'unsafe' },
    },
    {
      id: 'a_obtain_ecg',
      type: 'request_lab',
      label: 'Obtain a 12-lead ECG',
      timeCostMinutes: 2,
      classification: { default: 'appropriate' },
    },
    {
      id: 'a_notify_provider',
      type: 'notify_provider',
      label: 'Notify the provider of the critical potassium (SBAR)',
      timeCostMinutes: 3,
      classification: { default: 'appropriate' },
    },
    {
      id: 'a_give_treatment',
      type: 'administer_medication',
      label: 'Give IV calcium gluconate, insulin, and dextrose per new orders',
      timeCostMinutes: 4,
      classification: {
        default: 'premature',
        byPhase: { management: 'appropriate' },
      },
    },
    {
      id: 'a_reassess',
      type: 'reassess',
      label: 'Reassess the patient and repeat vitals',
      timeCostMinutes: 3,
      observesVitals: true,
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
      id: 'dp_symptoms',
      question: 'What symptoms are you having?',
      response:
        'My whole body feels weak, and my heart keeps skipping. I missed my dialysis on Tuesday — the van never came.',
    },
    {
      id: 'dp_dialysis',
      question: 'When was your last dialysis session?',
      response: 'Four days ago. I usually go every other day. I can feel it when I’m overdue.',
    },
  ],
  statements: [
    {
      id: 'st_palpitations',
      text: 'My heart keeps fluttering… it feels like it stops for a second.',
    },
    { id: 'st_faint', text: 'I feel like I might pass out…' },
    { id: 'st_improving', text: 'The fluttering has eased off. I feel a little steadier.' },
  ],
  rules: [
    {
      id: 'r_ecg',
      description: 'The 12-lead ECG captured the membrane effects of the hyperkalemia.',
      trigger: { kind: 'action', actionId: 'a_obtain_ecg' },
      conditions: [],
      effects: [
        { kind: 'set_finding_present', findingId: 'f_peaked_t', present: true },
        { kind: 'reveal_finding', findingId: 'f_peaked_t' },
      ],
      once: true,
    },
    {
      id: 'r_hold',
      description: 'Holding the erroneous potassium order removed the immediate medication hazard.',
      trigger: { kind: 'action', actionId: 'a_hold_kcl' },
      conditions: [],
      effects: [{ kind: 'add_flag', flag: 'kcl_held' }],
      once: true,
    },
    {
      id: 'r_kcl',
      description:
        'Administering potassium on top of a K+ of 6.4 pushed the myocardium toward arrest. ' +
        'Immediate provider notification was the only way to intercept it.',
      trigger: { kind: 'action', actionId: 'a_give_kcl' },
      conditions: [],
      effects: [
        { kind: 'add_flag', flag: 'kcl_given' },
        { kind: 'vital_delta', vital: 'hr', delta: -10, min: 30 },
        { kind: 'patient_statement', statementId: 'st_faint' },
        {
          kind: 'schedule',
          scheduleId: 'sch_arrest',
          afterMinutes: 10,
          effects: [
            { kind: 'vital_set', vital: 'hr', value: 30 },
            { kind: 'end', outcomeId: 'o_arrest' },
          ],
        },
      ],
      once: true,
    },
    {
      id: 'r_notify',
      description:
        'Escalating the critical potassium brought emergency treatment orders — and intercepted the pending medication error.',
      trigger: { kind: 'action', actionId: 'a_notify_provider' },
      conditions: [],
      effects: [
        { kind: 'add_flag', flag: 'escalated' },
        { kind: 'cancel_scheduled', scheduleId: 'sch_arrest' },
        { kind: 'set_phase', phase: 'management' },
        {
          kind: 'schedule',
          scheduleId: 'sch_orders',
          afterMinutes: 5,
          effects: [{ kind: 'add_flag', flag: 'orders_received' }],
        },
      ],
      once: true,
    },
    {
      id: 'r_treat',
      description:
        'Calcium stabilized the myocardium while insulin and dextrose shifted potassium intracellularly.',
      trigger: { kind: 'action', actionId: 'a_give_treatment' },
      conditions: [{ kind: 'flag_set', flag: 'orders_received' }],
      effects: [
        { kind: 'add_flag', flag: 'treated' },
        { kind: 'vital_delta', vital: 'hr', delta: 4, max: 72 },
        { kind: 'set_lab_value', labId: 'lab_k', value: 5.6, flag: 'high' },
        { kind: 'release_lab', labId: 'lab_k' },
        { kind: 'set_deterioration', level: 0 },
        { kind: 'patient_statement', statementId: 'st_improving' },
      ],
      once: true,
    },
    {
      id: 'r_wors1',
      description: 'The unescalated hyperkalemia deepened its cardiac effects.',
      trigger: { kind: 'time' },
      conditions: [
        { kind: 'time_at_least', minutes: 15 },
        { kind: 'flag_not_set', flag: 'escalated' },
      ],
      effects: [
        { kind: 'vital_delta', vital: 'hr', delta: -10, min: 36 },
        { kind: 'set_deterioration', level: 1 },
        { kind: 'patient_statement', statementId: 'st_palpitations' },
      ],
      once: true,
    },
    {
      id: 'r_wors2',
      description: 'Untreated hyperkalemia produced symptomatic bradycardia.',
      trigger: { kind: 'time' },
      conditions: [
        { kind: 'time_at_least', minutes: 28 },
        { kind: 'flag_not_set', flag: 'treated' },
      ],
      effects: [
        { kind: 'vital_delta', vital: 'hr', delta: -10, min: 34 },
        { kind: 'set_deterioration', level: 2 },
        { kind: 'set_finding_present', findingId: 'f_bradycardia_sx', present: true },
        { kind: 'reveal_finding', findingId: 'f_bradycardia_sx' },
      ],
      once: true,
    },
    {
      id: 'r_untreated_end',
      description:
        'The critical potassium was never treated; the cardiac conduction system failed.',
      trigger: { kind: 'time' },
      conditions: [
        { kind: 'time_at_least', minutes: 42 },
        { kind: 'flag_not_set', flag: 'treated' },
      ],
      effects: [{ kind: 'end', outcomeId: 'o_deteriorated' }],
      once: true,
    },
    {
      id: 'r_managed_end',
      description: 'Reassessment confirmed the emergency treatment stabilized the patient.',
      trigger: { kind: 'action', actionId: 'a_reassess' },
      conditions: [{ kind: 'flag_set', flag: 'treated' }],
      effects: [{ kind: 'end', outcomeId: 'o_managed' }],
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
      id: 'o_managed',
      kind: 'stabilized',
      label: 'Hyperkalemia managed, error intercepted',
      summary:
        'The erroneous potassium order was held, the critical result was escalated, and emergency ' +
        'treatment was given and verified. This is the medication-safety chain working as designed.',
    },
    {
      id: 'o_deteriorated',
      kind: 'deteriorated',
      label: 'Untreated hyperkalemia progressed',
      summary:
        'The critical potassium was never escalated or treated. A K+ above 6 with ECG changes is a ' +
        'medical emergency measured in minutes, not shifts.',
    },
    {
      id: 'o_arrest',
      kind: 'complication',
      label: 'Cardiac arrest after potassium administration',
      summary:
        'Administering potassium on top of a critical K+ precipitated a lethal arrhythmia. Checking ' +
        'current labs before giving electrolytes is a non-negotiable safety step — and escalating ' +
        'immediately after an error is the last chance to intercept it.',
    },
    {
      id: 'o_timeout',
      kind: 'timeout',
      label: 'Scenario time expired',
      summary:
        'The scenario ended at its time limit before a definitive outcome. Critical lab values carry ' +
        'a required response time for a reason.',
    },
  ],
  criticalActions: [
    {
      id: 'ca_hold',
      label: 'Hold the scheduled potassium chloride within 15 minutes',
      anyOfActionIds: ['a_hold_kcl'],
      byMinutes: 15,
    },
    {
      id: 'ca_notify',
      label: 'Notify the provider of the critical potassium within 25 minutes',
      anyOfActionIds: ['a_notify_provider'],
      byMinutes: 25,
    },
    {
      id: 'ca_ecg',
      label: 'Obtain a 12-lead ECG within 20 minutes',
      anyOfActionIds: ['a_obtain_ecg'],
      byMinutes: 20,
    },
  ],
  scoring: [
    {
      id: 's_cue_pulse',
      dimension: 'recognize_cues',
      points: 2,
      criterion: { kind: 'cue_revealed', findingId: 'f_irregular_pulse', byMinutes: 10 },
      label: 'Assessed the patient early and identified the irregular pulse.',
    },
    {
      id: 's_vitals_early',
      dimension: 'recognize_cues',
      points: 2,
      criterion: { kind: 'vitals_obtained', byMinutes: 10 },
      label: 'Obtained vital signs within the first 10 minutes.',
    },
    {
      id: 's_ecg',
      dimension: 'analyze_cues',
      points: 2,
      criterion: { kind: 'cue_revealed', findingId: 'f_peaked_t', byMinutes: 15 },
      label: 'Obtained an ECG and connected the peaked T waves to the critical potassium.',
    },
    {
      id: 's_hold',
      dimension: 'prioritize_hypotheses',
      points: 3,
      criterion: { kind: 'critical_action_done', actionId: 'a_hold_kcl', byMinutes: 12 },
      label: 'Recognized the medication hazard and held the potassium order promptly.',
    },
    {
      id: 's_workup',
      dimension: 'generate_solutions',
      points: 2,
      criterion: { kind: 'any_action_done', actionIds: ['a_obtain_ecg'], byMinutes: 15 },
      label: 'Anticipated the provider’s needs by obtaining the ECG before escalating.',
    },
    {
      id: 's_notify',
      dimension: 'take_action',
      points: 3,
      criterion: { kind: 'any_action_done', actionIds: ['a_notify_provider'], byMinutes: 20 },
      label: 'Escalated the critical potassium to the provider within 20 minutes.',
    },
    {
      id: 's_no_kcl',
      dimension: 'take_action',
      points: 3,
      criterion: { kind: 'action_not_done', actionId: 'a_give_kcl' },
      label: 'Did not administer the erroneous potassium order.',
    },
    {
      id: 's_no_unsafe',
      dimension: 'take_action',
      points: 1,
      criterion: { kind: 'no_unsafe_actions' },
      label: 'Avoided unsafe and contraindicated actions.',
    },
    {
      id: 's_reassess',
      dimension: 'evaluate_outcomes',
      points: 2,
      criterion: { kind: 'reassessed_after', actionId: 'a_give_treatment', withinMinutes: 10 },
      label: 'Reassessed within 10 minutes of giving the emergency treatment.',
    },
    {
      id: 's_outcome',
      dimension: 'evaluate_outcomes',
      points: 2,
      criterion: { kind: 'outcome_is', outcomeId: 'o_managed' },
      label: 'Managed the hyperkalemia and intercepted the medication error.',
    },
  ],
  conceptMappings: [
    {
      conceptName: 'Hyperkalemia',
      conceptKey: 'hyperkalemia',
      difficulty: 'hard',
      cognitiveLevel: 'analysis',
      dimensions: ['recognize_cues', 'analyze_cues', 'take_action'],
    },
    {
      conceptName: 'Medication safety',
      conceptKey: 'medication safety',
      difficulty: 'hard',
      cognitiveLevel: 'prioritization',
      dimensions: ['prioritize_hypotheses', 'take_action'],
    },
    {
      conceptName: 'Critical lab values',
      conceptKey: 'critical lab values',
      difficulty: 'moderate',
      cognitiveLevel: 'application',
      dimensions: ['generate_solutions', 'evaluate_outcomes'],
    },
  ],
  debriefRecommendations: [
    'ECG changes of hyperkalemia and why calcium comes first',
    'The rights of medication administration applied to electrolytes',
    'Critical lab value notification requirements',
    'Emergency management of hyperkalemia: stabilize, shift, eliminate',
  ],
};
