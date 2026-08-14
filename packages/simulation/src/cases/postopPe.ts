/**
 * Built-in case: postoperative pulmonary embolism (spec AF).
 *
 * Deterioration scenario. Verified deterministic paths (pinned in tests):
 *  - Optimal:  assess resp (t2) → vitals (t4) → O2 (t6) → notify (t9) →
 *              wait (t14) → reassess (t17, stabilization fires) → o_stabilized.
 *  - Delayed:  no O2 by t12 (det 1), no escalation by t22 (det 2, cyanosis),
 *              still unescalated at t34 → o_deteriorated.
 *  - Unsafe:   ambulating after det 2 drops SpO2 to ≤ 78 → o_complication.
 *  - Timeout:  t45 → o_timeout.
 *
 * Fictional patient; educational use only (spec AU/AV).
 */

import type { SimulationCaseDefinition } from '../types';
import { SIMULATION_ENGINE_VERSION } from '../types';

export const postopPeCase: SimulationCaseDefinition = {
  caseId: 'postop_pe',
  title: 'Postop day 2: sudden shortness of breath',
  description:
    'A postoperative patient develops acute dyspnea and hypoxemia. Recognize the cues, ' +
    'support oxygenation, and escalate before the patient deteriorates.',
  difficulty: 'moderate',
  scenarioType: 'deterioration',
  estimatedDurationMinutes: 20,
  caseVersion: 1,
  engineVersion: SIMULATION_ENGINE_VERSION,
  patient: {
    name: 'Mr. Ortiz',
    age: 54,
    sex: 'male',
    heightCm: 178,
    weightKg: 96,
    allergies: ['No known allergies'],
    codeStatus: 'Full code',
    chiefComplaint: 'Sudden shortness of breath on postoperative day 2',
    admittingDiagnosis: 'Right total knee arthroplasty (postop day 2)',
    history: ['Hypertension', 'Obesity (BMI 30)', 'Former smoker (quit 8 years ago)'],
    homeMedications: ['Lisinopril 10 mg PO daily'],
    baselineVitals: { hr: 78, sbp: 128, dbp: 80, rr: 16, spo2: 96, temp_c: 36.8, pain: 3 },
  },
  phases: ['initial', 'assessment', 'intervention', 'response', 'reassessment'],
  initialPhase: 'initial',
  phaseFlow: {
    initial: ['assessment', 'intervention'],
    assessment: ['intervention'],
    intervention: ['response'],
    response: ['reassessment'],
    reassessment: [],
  },
  initialVitals: { hr: 108, sbp: 132, dbp: 84, rr: 26, spo2: 87, temp_c: 37.4, pain: 6 },
  findings: [
    {
      id: 'f_dyspnea',
      system: 'respiratory',
      text: 'Acute dyspnea at rest; speaking in short sentences.',
      presentAtStart: true,
      keyCue: true,
    },
    {
      id: 'f_pleuritic_pain',
      system: 'respiratory',
      text: 'Sharp right-sided chest pain that worsens with inspiration.',
      presentAtStart: true,
      keyCue: true,
    },
    {
      id: 'f_clear_lungs',
      system: 'respiratory',
      text: 'Lungs clear to auscultation bilaterally despite distress.',
      presentAtStart: true,
      keyCue: false,
    },
    {
      id: 'f_calf_swelling',
      system: 'peripheral_vascular',
      text: 'Right calf is swollen, warm, and tender compared to the left.',
      presentAtStart: true,
      keyCue: true,
    },
    {
      id: 'f_anxiety',
      system: 'neurological',
      text: 'Anxious and restless; states a feeling of impending doom.',
      presentAtStart: true,
      keyCue: false,
    },
    {
      id: 'f_cyanosis',
      system: 'skin',
      text: 'New circumoral cyanosis; lips are dusky.',
      presentAtStart: false,
      keyCue: true,
    },
  ],
  labs: [
    {
      id: 'lab_ddimer',
      name: 'D-dimer',
      unit: 'µg/mL FEU',
      value: 4.8,
      flag: 'critical',
      availableAtStart: false,
    },
  ],
  medicationOrders: [
    {
      id: 'ord_enoxaparin',
      medication: 'Enoxaparin',
      dose: '40 mg',
      route: 'Subcutaneous',
      frequency: 'Daily',
      status: 'scheduled',
      note: 'VTE prophylaxis — last dose held preop, restarted this morning.',
    },
    {
      id: 'ord_morphine',
      medication: 'Morphine',
      dose: '4 mg',
      route: 'IV',
      frequency: 'Every 4 hours PRN severe pain',
      status: 'prn',
    },
    {
      id: 'ord_oxygen',
      medication: 'Oxygen',
      dose: 'Titrate to SpO2 ≥ 92%',
      route: 'Nasal cannula',
      frequency: 'PRN',
      status: 'prn',
    },
  ],
  actions: [
    {
      id: 'a_assess_resp',
      type: 'assess',
      label: 'Focused respiratory assessment',
      timeCostMinutes: 2,
      revealsSystems: ['respiratory'],
      classification: { default: 'appropriate' },
    },
    {
      id: 'a_assess_legs',
      type: 'assess',
      label: 'Assess lower extremities',
      timeCostMinutes: 2,
      revealsSystems: ['peripheral_vascular'],
      classification: { default: 'appropriate' },
    },
    {
      id: 'a_assess_neuro',
      type: 'assess',
      label: 'Neurological check',
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
      id: 'a_apply_o2',
      type: 'apply_oxygen',
      label: 'Apply supplemental oxygen',
      timeCostMinutes: 2,
      classification: { default: 'appropriate' },
    },
    {
      id: 'a_position_hob',
      type: 'position_patient',
      label: 'Raise the head of the bed (high Fowler’s)',
      timeCostMinutes: 1,
      classification: { default: 'appropriate' },
    },
    {
      id: 'a_notify_provider',
      type: 'notify_provider',
      label: 'Notify the provider (SBAR)',
      timeCostMinutes: 3,
      classification: { default: 'appropriate' },
    },
    {
      id: 'a_activate_rrt',
      type: 'activate_rrt',
      label: 'Activate the rapid response team',
      timeCostMinutes: 3,
      classification: { default: 'appropriate', byPhase: { initial: 'premature' } },
    },
    {
      id: 'a_request_ddimer',
      type: 'request_lab',
      label: 'Draw and send a D-dimer',
      timeCostMinutes: 2,
      classification: { default: 'appropriate' },
    },
    {
      id: 'a_give_morphine',
      type: 'administer_medication',
      label: 'Administer morphine 4 mg IV for pain',
      timeCostMinutes: 3,
      classification: { default: 'contraindicated' },
    },
    {
      id: 'a_ambulate',
      type: 'ambulate_patient',
      label: 'Assist the patient to ambulate in the hall',
      timeCostMinutes: 4,
      classification: { default: 'unsafe' },
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
      id: 'dp_breathing',
      question: 'Can you tell me what happened?',
      response: 'It came on all of a sudden — one minute I was fine, now I can’t catch my breath.',
    },
    {
      id: 'dp_pain',
      question: 'Are you having any pain?',
      response: 'It’s sharp, on my right side. It stabs every time I take a deep breath.',
    },
    {
      id: 'dp_legs',
      question: 'Any pain or swelling in your legs?',
      response: 'Now that you mention it, my right calf has been sore and tight since yesterday.',
      requiresFindingRevealed: 'f_calf_swelling',
      gatedResponse:
        'I don’t know… my legs feel heavy, I guess. It’s hard to think about that right now.',
    },
  ],
  statements: [
    { id: 'st_worse', text: 'I really can’t catch my breath… it’s getting worse.' },
    { id: 'st_dizzy', text: 'I feel dizzy… everything is going gray…' },
    { id: 'st_relief', text: 'That’s a little better. I can breathe a bit easier now.' },
  ],
  rules: [
    {
      id: 'r_phase_assessment',
      description: 'Beginning a focused assessment moved the encounter into the assessment phase.',
      trigger: { kind: 'action', actionId: 'a_assess_resp' },
      conditions: [{ kind: 'phase_is', phase: 'initial' }],
      effects: [{ kind: 'set_phase', phase: 'assessment' }],
      once: true,
    },
    {
      id: 'r_o2',
      description:
        'Supplemental oxygen partially corrected the hypoxemia, but a suspected PE still needs provider evaluation.',
      trigger: { kind: 'action', actionId: 'a_apply_o2' },
      conditions: [],
      effects: [
        { kind: 'vital_delta', vital: 'spo2', delta: 4, max: 93 },
        { kind: 'add_flag', flag: 'oxygen_applied' },
        { kind: 'set_phase', phase: 'intervention' },
        { kind: 'patient_statement', statementId: 'st_relief' },
      ],
      once: true,
    },
    {
      id: 'r_hob',
      description: 'Positioning upright modestly improved the work of breathing.',
      trigger: { kind: 'action', actionId: 'a_position_hob' },
      conditions: [],
      effects: [{ kind: 'vital_delta', vital: 'spo2', delta: 1, max: 93 }],
      once: true,
    },
    {
      id: 'r_notify',
      description:
        'Escalating to the provider started definitive treatment; the patient begins to stabilize a few minutes later.',
      trigger: { kind: 'action', actionId: 'a_notify_provider' },
      conditions: [],
      effects: [
        { kind: 'add_flag', flag: 'escalated' },
        { kind: 'set_phase', phase: 'response' },
        {
          kind: 'schedule',
          scheduleId: 'sch_stabilize',
          afterMinutes: 6,
          effects: [
            { kind: 'vital_delta', vital: 'spo2', delta: 3, max: 95 },
            { kind: 'vital_delta', vital: 'hr', delta: -10, min: 88 },
            { kind: 'vital_delta', vital: 'rr', delta: -6, min: 18 },
            { kind: 'set_deterioration', level: 0 },
            { kind: 'add_flag', flag: 'stabilizing' },
          ],
        },
      ],
      once: true,
    },
    {
      id: 'r_rrt',
      description:
        'The rapid response team took over the escalation; treatment begins and the patient starts to stabilize.',
      trigger: { kind: 'action', actionId: 'a_activate_rrt' },
      conditions: [],
      effects: [
        { kind: 'add_flag', flag: 'escalated' },
        { kind: 'set_phase', phase: 'response' },
        {
          kind: 'schedule',
          scheduleId: 'sch_stabilize',
          afterMinutes: 6,
          effects: [
            { kind: 'vital_delta', vital: 'spo2', delta: 3, max: 95 },
            { kind: 'vital_delta', vital: 'hr', delta: -10, min: 88 },
            { kind: 'vital_delta', vital: 'rr', delta: -6, min: 18 },
            { kind: 'set_deterioration', level: 0 },
            { kind: 'add_flag', flag: 'stabilizing' },
          ],
        },
      ],
      once: true,
    },
    {
      id: 'r_ddimer',
      description: 'The D-dimer was sent; the critical result came back a few minutes later.',
      trigger: { kind: 'action', actionId: 'a_request_ddimer' },
      conditions: [],
      effects: [
        {
          kind: 'schedule',
          scheduleId: 'sch_ddimer',
          afterMinutes: 8,
          effects: [{ kind: 'release_lab', labId: 'lab_ddimer' }],
        },
      ],
      once: true,
    },
    {
      id: 'r_morphine',
      description:
        'IV opioid analgesia depressed the respiratory drive of an already hypoxemic patient.',
      trigger: { kind: 'action', actionId: 'a_give_morphine' },
      conditions: [],
      effects: [
        { kind: 'vital_delta', vital: 'rr', delta: -6, min: 8 },
        { kind: 'vital_delta', vital: 'spo2', delta: -3, min: 60 },
        { kind: 'add_flag', flag: 'resp_depression_risk' },
      ],
      once: true,
    },
    {
      id: 'r_ambulate',
      description:
        'Ambulating a patient with a suspected PE sharply increased oxygen demand and worsened hypoxemia.',
      trigger: { kind: 'action', actionId: 'a_ambulate' },
      conditions: [],
      effects: [
        { kind: 'vital_delta', vital: 'spo2', delta: -6, min: 60 },
        { kind: 'vital_delta', vital: 'hr', delta: 15, max: 160 },
        { kind: 'patient_statement', statementId: 'st_dizzy' },
      ],
      once: true,
    },
    {
      id: 'r_det1',
      description: 'Without supplemental oxygen, oxygenation continued to worsen.',
      trigger: { kind: 'time' },
      conditions: [
        { kind: 'time_at_least', minutes: 12 },
        { kind: 'flag_not_set', flag: 'oxygen_applied' },
      ],
      effects: [
        { kind: 'vital_delta', vital: 'spo2', delta: -4, min: 60 },
        { kind: 'vital_delta', vital: 'hr', delta: 12, max: 170 },
        { kind: 'set_deterioration', level: 1 },
        { kind: 'patient_statement', statementId: 'st_worse' },
      ],
      once: true,
    },
    {
      id: 'r_det2',
      description:
        'The untreated embolism progressed: hypoxemia deepened and cyanosis appeared because no escalation had occurred.',
      trigger: { kind: 'time' },
      conditions: [
        { kind: 'time_at_least', minutes: 22 },
        { kind: 'flag_not_set', flag: 'escalated' },
      ],
      effects: [
        { kind: 'vital_delta', vital: 'spo2', delta: -4, min: 60 },
        { kind: 'vital_delta', vital: 'hr', delta: 10, max: 180 },
        { kind: 'set_deterioration', level: 2 },
        { kind: 'set_finding_present', findingId: 'f_cyanosis', present: true },
        { kind: 'reveal_finding', findingId: 'f_cyanosis' },
      ],
      once: true,
    },
    {
      id: 'r_det3_end',
      description:
        'The pulmonary embolism was never escalated for treatment; the patient decompensated.',
      trigger: { kind: 'time' },
      conditions: [
        { kind: 'time_at_least', minutes: 34 },
        { kind: 'flag_not_set', flag: 'escalated' },
      ],
      effects: [{ kind: 'end', outcomeId: 'o_deteriorated' }],
      once: true,
    },
    {
      id: 'r_collapse',
      description: 'Profound hypoxemia (SpO2 ≤ 78%) led to acute decompensation.',
      trigger: { kind: 'time' },
      conditions: [{ kind: 'vital_at_most', vital: 'spo2', value: 78 }],
      effects: [{ kind: 'end', outcomeId: 'o_complication' }],
      once: true,
    },
    {
      id: 'r_end_stabilized',
      description:
        'Reassessment confirmed the interventions worked: oxygenation recovered after oxygen and escalation.',
      trigger: { kind: 'action', actionId: 'a_reassess' },
      conditions: [{ kind: 'flag_set', flag: 'stabilizing' }],
      effects: [
        { kind: 'set_phase', phase: 'reassessment' },
        { kind: 'end', outcomeId: 'o_stabilized' },
      ],
      once: true,
    },
    {
      id: 'r_timeout',
      description: 'The scenario reached its time limit.',
      trigger: { kind: 'time' },
      conditions: [{ kind: 'time_at_least', minutes: 45 }],
      effects: [{ kind: 'end', outcomeId: 'o_timeout' }],
      once: true,
    },
  ],
  outcomes: [
    {
      id: 'o_stabilized',
      kind: 'stabilized',
      label: 'Patient stabilized',
      summary:
        'Oxygen was applied early and the provider was notified promptly, so anticoagulation and ' +
        'work-up began before the embolism could progress. Reassessment confirmed improving oxygenation.',
    },
    {
      id: 'o_deteriorated',
      kind: 'deteriorated',
      label: 'Patient deteriorated',
      summary:
        'The provider was never notified, so definitive treatment never started. A pulmonary embolism ' +
        'is a medical emergency: supportive care alone does not treat the clot.',
    },
    {
      id: 'o_complication',
      kind: 'complication',
      label: 'Acute decompensation',
      summary:
        'Oxygen saturation fell below a survivable threshold and the patient acutely decompensated. ' +
        'Increasing oxygen demand (for example by ambulating) in an unstable, hypoxemic patient is unsafe.',
    },
    {
      id: 'o_timeout',
      kind: 'timeout',
      label: 'Scenario time expired',
      summary:
        'The scenario ended at its time limit before a definitive outcome. In a real deterioration ' +
        'event, delays compound: early recognition and escalation drive the outcome.',
    },
  ],
  criticalActions: [
    {
      id: 'ca_o2',
      label: 'Apply supplemental oxygen within 20 minutes',
      anyOfActionIds: ['a_apply_o2'],
      byMinutes: 20,
    },
    {
      id: 'ca_escalate',
      label: 'Escalate to the provider or rapid response team within 30 minutes',
      anyOfActionIds: ['a_notify_provider', 'a_activate_rrt'],
      byMinutes: 30,
    },
    {
      id: 'ca_vitals',
      label: 'Obtain a full set of vital signs within 15 minutes',
      anyOfActionIds: ['a_obtain_vitals'],
      byMinutes: 15,
    },
  ],
  scoring: [
    {
      id: 's_cue_dyspnea',
      dimension: 'recognize_cues',
      points: 2,
      criterion: { kind: 'cue_revealed', findingId: 'f_dyspnea', byMinutes: 10 },
      label: 'Performed a focused respiratory assessment early and identified the acute dyspnea.',
    },
    {
      id: 's_vitals_early',
      dimension: 'recognize_cues',
      points: 2,
      criterion: { kind: 'vitals_obtained', byMinutes: 10 },
      label: 'Obtained vital signs within the first 10 minutes.',
    },
    {
      id: 's_cue_calf',
      dimension: 'analyze_cues',
      points: 2,
      criterion: { kind: 'cue_revealed', findingId: 'f_calf_swelling' },
      label: 'Connected the respiratory event to its likely source by assessing the legs (DVT).',
    },
    {
      id: 's_o2_first',
      dimension: 'prioritize_hypotheses',
      points: 2,
      criterion: { kind: 'critical_action_done', actionId: 'a_apply_o2', byMinutes: 12 },
      label: 'Treated hypoxemia as the priority problem by applying oxygen within 12 minutes.',
    },
    {
      id: 's_support_oxygenation',
      dimension: 'generate_solutions',
      points: 2,
      criterion: {
        kind: 'any_action_done',
        actionIds: ['a_position_hob', 'a_apply_o2'],
        byMinutes: 15,
      },
      label: 'Used independent nursing interventions (positioning, oxygen) to support oxygenation.',
    },
    {
      id: 's_escalate',
      dimension: 'take_action',
      points: 3,
      criterion: {
        kind: 'any_action_done',
        actionIds: ['a_notify_provider', 'a_activate_rrt'],
        byMinutes: 25,
      },
      label: 'Escalated to the provider or rapid response team within 25 minutes.',
    },
    {
      id: 's_no_unsafe',
      dimension: 'take_action',
      points: 2,
      criterion: { kind: 'no_unsafe_actions' },
      label: 'Avoided unsafe and contraindicated actions.',
    },
    {
      id: 's_no_morphine',
      dimension: 'take_action',
      points: 1,
      criterion: { kind: 'action_not_done', actionId: 'a_give_morphine' },
      label: 'Withheld IV opioids in a hypoxemic patient with respiratory compromise.',
    },
    {
      id: 's_reassess_o2',
      dimension: 'evaluate_outcomes',
      points: 3,
      criterion: { kind: 'reassessed_after', actionId: 'a_apply_o2', withinMinutes: 15 },
      label: 'Reassessed the patient within 15 minutes of applying oxygen.',
    },
    {
      id: 's_outcome',
      dimension: 'evaluate_outcomes',
      points: 3,
      criterion: { kind: 'outcome_is', outcomeId: 'o_stabilized' },
      label: 'Stabilized the patient through timely oxygenation and escalation.',
    },
  ],
  conceptMappings: [
    {
      conceptName: 'Pulmonary embolism',
      conceptKey: 'pulmonary embolism',
      difficulty: 'moderate',
      cognitiveLevel: 'analysis',
      dimensions: ['recognize_cues', 'analyze_cues', 'take_action'],
    },
    {
      conceptName: 'Oxygen therapy',
      conceptKey: 'oxygen therapy',
      difficulty: 'moderate',
      cognitiveLevel: 'application',
      dimensions: ['prioritize_hypotheses', 'generate_solutions'],
    },
    {
      conceptName: 'Clinical deterioration',
      conceptKey: 'clinical deterioration',
      difficulty: 'moderate',
      cognitiveLevel: 'prioritization',
      dimensions: ['recognize_cues', 'evaluate_outcomes'],
    },
  ],
  debriefRecommendations: [
    'Virchow’s triad and postoperative VTE risk',
    'Recognizing pulmonary embolism: classic cue clusters',
    'Oxygen therapy and positioning for acute hypoxemia',
    'SBAR communication and when to activate a rapid response',
  ],
};
