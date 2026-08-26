/**
 * Test data and fixtures for E2E tests
 * Provides realistic nursing education scenarios
 */

export const testData = {
  courses: {
    nclex_rn: {
      id: 'course-nclex-rn-001',
      title: 'NCLEX-RN Preparation',
      description: 'Comprehensive NCLEX-RN review and practice',
    },
    fundamentals: {
      id: 'course-fundamentals-001',
      title: 'Fundamentals of Nursing',
      description: 'Core nursing fundamentals and patient care basics',
    },
  },

  concepts: {
    infection_control: 'Infection Control and Prevention',
    medication_safety: 'Medication Safety and Administration',
    vital_signs: 'Vital Signs Assessment',
    patient_communication: 'Patient Communication',
  },

  studyPlans: {
    intensive: {
      label: '45 minutes',
      minutesPerDay: 45,
      type: 'Intensive',
    },
    standard: {
      label: '20 minutes',
      minutesPerDay: 20,
      type: 'Standard',
    },
    light: {
      label: '10 minutes',
      minutesPerDay: 10,
      type: 'Light',
    },
  },

  examScenarios: {
    exam_in_7_days: {
      daysUntilExam: 7,
      examName: 'NCLEX-RN Mock Exam',
    },
    exam_in_30_days: {
      daysUntilExam: 30,
      examName: 'Final Comprehensive Exam',
    },
    no_exam_scheduled: {
      daysUntilExam: null,
      examName: null,
    },
  },
};

export const testScenarios = {
  /**
   * Complete student journey: enroll → plan → study → complete
   */
  completeStudySession: {
    course: testData.courses.nclex_rn,
    studyTime: testData.studyPlans.standard,
    expectedSessionQuestions: 5,
  },

  /**
   * Mastery progression: weak → building → strong
   */
  masteryProgression: {
    concept: testData.concepts.infection_control,
    startingMastery: 'New',
    targetMastery: 'Proficient',
    sessionsNeeded: 3,
  },

  /**
   * Exam pressure: countdown + urgency in recommendations
   */
  examReadiness: {
    exam: testData.examScenarios.exam_in_7_days,
    expectedUrgency: 'High',
    minPriorityItems: 5,
  },
};
