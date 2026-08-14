/**
 * Case-definition validation — M11 (spec AB/AC).
 *
 * A case may only become ACTIVE if it passes every check here: structural
 * integrity, referential integrity (no dangling ids), legal phase flow,
 * physiologic bounds, guaranteed termination, valid scoring, and honest
 * concept mappings. This is also the gate any future AI-assisted case
 * generation must pass — arbitrary model output is never executed as
 * simulation rules (spec AC/AI).
 */

import { QUESTION_DIFFICULTIES, COGNITIVE_LEVELS } from '@avidia/domain';
import { normalizeConceptKey } from '@avidia/knowledge';

import {
  ACTION_TYPES,
  ASSESSMENT_SYSTEMS,
  CJMM_DIMENSIONS,
  PHYSIOLOGIC_BOUNDS,
  SIMULATION_ENGINE_VERSION,
  VITAL_KEYS,
  type Condition,
  type Effect,
  type ScoringCriterion,
  type SimulationCaseDefinition,
} from './types';

export interface CaseValidationResult {
  valid: boolean;
  errors: string[];
}

function checkIds(errors: string[], label: string, ids: string[]): Set<string> {
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) errors.push(`${label}: empty id`);
    if (seen.has(id)) errors.push(`${label}: duplicate id "${id}"`);
    seen.add(id);
  }
  return seen;
}

export function validateCase(caseDef: SimulationCaseDefinition): CaseValidationResult {
  const errors: string[] = [];

  if (caseDef.engineVersion !== SIMULATION_ENGINE_VERSION) {
    errors.push(`engineVersion must be ${SIMULATION_ENGINE_VERSION}`);
  }
  if (!Number.isInteger(caseDef.caseVersion) || caseDef.caseVersion < 1) {
    errors.push('caseVersion must be a positive integer');
  }
  if (caseDef.title.trim().length === 0) errors.push('title is required');
  if (caseDef.description.trim().length === 0) errors.push('description is required');
  if (!QUESTION_DIFFICULTIES.includes(caseDef.difficulty)) errors.push('invalid difficulty');
  if (caseDef.estimatedDurationMinutes <= 0) errors.push('estimatedDurationMinutes must be > 0');

  // Patient (spec B/AV): fictional, structurally complete.
  if (caseDef.patient.name.trim().length === 0) errors.push('patient.name is required');
  if (caseDef.patient.age < 18 || caseDef.patient.age > 110) {
    errors.push('patient.age must be an adult age (18–110)');
  }

  // Phases (spec D).
  const phases = checkIds(errors, 'phases', caseDef.phases);
  if (!phases.has(caseDef.initialPhase)) errors.push('initialPhase not in phases');
  for (const [from, targets] of Object.entries(caseDef.phaseFlow)) {
    if (!phases.has(from)) errors.push(`phaseFlow: unknown source phase "${from}"`);
    for (const target of targets) {
      if (!phases.has(target)) errors.push(`phaseFlow: unknown target phase "${target}"`);
    }
  }

  const findingIds = checkIds(
    errors,
    'findings',
    caseDef.findings.map((f) => f.id)
  );
  const labIds = checkIds(
    errors,
    'labs',
    caseDef.labs.map((l) => l.id)
  );
  checkIds(
    errors,
    'medicationOrders',
    caseDef.medicationOrders.map((m) => m.id)
  );
  const actionIds = checkIds(
    errors,
    'actions',
    caseDef.actions.map((a) => a.id)
  );
  const outcomeIds = checkIds(
    errors,
    'outcomes',
    caseDef.outcomes.map((o) => o.id)
  );
  const statementIds = checkIds(
    errors,
    'statements',
    caseDef.statements.map((s) => s.id)
  );
  checkIds(
    errors,
    'dialogue',
    caseDef.dialogue.map((d) => d.id)
  );
  checkIds(
    errors,
    'rules',
    caseDef.rules.map((r) => r.id)
  );
  checkIds(
    errors,
    'scoring',
    caseDef.scoring.map((s) => s.id)
  );

  for (const finding of caseDef.findings) {
    if (!ASSESSMENT_SYSTEMS.includes(finding.system)) {
      errors.push(`findings.${finding.id}: unknown system "${finding.system}"`);
    }
    if (finding.text.trim().length === 0) errors.push(`findings.${finding.id}: empty text`);
  }

  // Vitals within physiologic bounds (spec J).
  for (const [key, value] of Object.entries(caseDef.initialVitals)) {
    const vital = key as (typeof VITAL_KEYS)[number];
    if (!VITAL_KEYS.includes(vital)) {
      errors.push(`initialVitals: unknown vital "${key}"`);
      continue;
    }
    const bounds = PHYSIOLOGIC_BOUNDS[vital];
    if (value === undefined || value < bounds.min || value > bounds.max) {
      errors.push(`initialVitals.${key}: outside physiologic bounds`);
    }
  }

  // Actions (spec E/F).
  for (const action of caseDef.actions) {
    if (!ACTION_TYPES.includes(action.type)) {
      errors.push(`actions.${action.id}: unknown type "${action.type}"`);
    }
    if (action.timeCostMinutes < 0 || action.timeCostMinutes > 60) {
      errors.push(`actions.${action.id}: timeCostMinutes must be 0–60`);
    }
    for (const system of action.revealsSystems ?? []) {
      if (!ASSESSMENT_SYSTEMS.includes(system)) {
        errors.push(`actions.${action.id}: unknown system "${system}"`);
      }
    }
    if (action.promptRequired === true && action.type !== 'ask_patient') {
      errors.push(`actions.${action.id}: promptRequired only valid on ask_patient`);
    }
    if (action.type === 'ask_patient' && action.promptRequired !== true) {
      errors.push(`actions.${action.id}: ask_patient must set promptRequired`);
    }
    for (const phase of Object.keys(action.classification.byPhase ?? {})) {
      if (!phases.has(phase)) {
        errors.push(`actions.${action.id}: classification for unknown phase "${phase}"`);
      }
    }
  }

  for (const prompt of caseDef.dialogue) {
    if (
      prompt.requiresFindingRevealed !== undefined &&
      !findingIds.has(prompt.requiresFindingRevealed)
    ) {
      errors.push(`dialogue.${prompt.id}: unknown finding "${prompt.requiresFindingRevealed}"`);
    }
  }

  const checkCondition = (where: string, condition: Condition): void => {
    switch (condition.kind) {
      case 'phase_is':
        if (!phases.has(condition.phase))
          errors.push(`${where}: unknown phase "${condition.phase}"`);
        return;
      case 'vital_at_most':
      case 'vital_at_least':
        if (!VITAL_KEYS.includes(condition.vital)) {
          errors.push(`${where}: unknown vital "${condition.vital}"`);
        }
        return;
      case 'action_done':
      case 'action_not_done':
        if (!actionIds.has(condition.actionId)) {
          errors.push(`${where}: unknown action "${condition.actionId}"`);
        }
        return;
      case 'finding_revealed':
        if (!findingIds.has(condition.findingId)) {
          errors.push(`${where}: unknown finding "${condition.findingId}"`);
        }
        return;
      case 'deterioration_at_least':
        if (condition.level < 0 || condition.level > 3) {
          errors.push(`${where}: deterioration level must be 0–3`);
        }
        return;
      case 'time_at_least':
      case 'flag_set':
        return;
    }
  };

  const checkEffect = (where: string, effect: Effect, depth: number): void => {
    switch (effect.kind) {
      case 'vital_delta':
      case 'vital_set':
        if (!VITAL_KEYS.includes(effect.vital)) {
          errors.push(`${where}: unknown vital "${effect.vital}"`);
        }
        return;
      case 'set_phase':
        if (!phases.has(effect.phase)) errors.push(`${where}: unknown phase "${effect.phase}"`);
        return;
      case 'set_finding_present':
      case 'reveal_finding':
        if (!findingIds.has(effect.findingId)) {
          errors.push(`${where}: unknown finding "${effect.findingId}"`);
        }
        return;
      case 'release_lab':
      case 'set_lab_value':
        if (!labIds.has(effect.labId)) errors.push(`${where}: unknown lab "${effect.labId}"`);
        return;
      case 'schedule':
        if (depth > 0) {
          errors.push(`${where}: nested schedule effects are not allowed`);
          return;
        }
        if (effect.afterMinutes <= 0) errors.push(`${where}: schedule afterMinutes must be > 0`);
        for (const nested of effect.effects) checkEffect(`${where}.schedule`, nested, depth + 1);
        return;
      case 'set_deterioration':
        if (effect.level < 0 || effect.level > 3) {
          errors.push(`${where}: deterioration level must be 0–3`);
        }
        return;
      case 'patient_statement':
        if (!statementIds.has(effect.statementId)) {
          errors.push(`${where}: unknown statement "${effect.statementId}"`);
        }
        return;
      case 'end':
        if (!outcomeIds.has(effect.outcomeId)) {
          errors.push(`${where}: unknown outcome "${effect.outcomeId}"`);
        }
        return;
      case 'cancel_scheduled':
      case 'add_flag':
        return;
    }
  };

  let hasTimeTriggeredEnd = false;
  const endedOutcomes = new Set<string>();
  const collectEnds = (effects: Effect[]): void => {
    for (const effect of effects) {
      if (effect.kind === 'end') endedOutcomes.add(effect.outcomeId);
      if (effect.kind === 'schedule') collectEnds(effect.effects);
    }
  };
  for (const rule of caseDef.rules) {
    const where = `rules.${rule.id}`;
    if (rule.description.trim().length === 0) errors.push(`${where}: description is required`);
    if (rule.trigger.kind === 'action' && !actionIds.has(rule.trigger.actionId)) {
      errors.push(`${where}: unknown trigger action "${rule.trigger.actionId}"`);
    }
    if (rule.trigger.kind === 'phase_enter' && !phases.has(rule.trigger.phase)) {
      errors.push(`${where}: unknown trigger phase "${rule.trigger.phase}"`);
    }
    for (const condition of rule.conditions) checkCondition(where, condition);
    for (const effect of rule.effects) checkEffect(where, effect, 0);
    collectEnds(rule.effects);
    if (
      rule.trigger.kind === 'time' &&
      rule.effects.some((e) => e.kind === 'end') &&
      rule.conditions.some((c) => c.kind === 'time_at_least')
    ) {
      hasTimeTriggeredEnd = true;
    }
  }

  // Termination guarantee (spec AP/BB): some ending must be reachable by
  // time alone, so no session can run forever.
  if (!hasTimeTriggeredEnd) {
    errors.push('no time-triggered end rule: the simulation could run forever');
  }
  if (caseDef.outcomes.length === 0) errors.push('at least one outcome is required');
  for (const outcome of caseDef.outcomes) {
    if (!endedOutcomes.has(outcome.id)) {
      errors.push(`outcomes.${outcome.id}: never produced by any end effect`);
    }
    if (outcome.summary.trim().length === 0) errors.push(`outcomes.${outcome.id}: empty summary`);
  }

  // Critical actions (spec Q).
  for (const critical of caseDef.criticalActions) {
    if (critical.anyOfActionIds.length === 0) {
      errors.push(`criticalActions.${critical.id}: anyOfActionIds must not be empty`);
    }
    for (const actionId of critical.anyOfActionIds) {
      if (!actionIds.has(actionId)) {
        errors.push(`criticalActions.${critical.id}: unknown action "${actionId}"`);
      }
    }
    if (critical.label.trim().length === 0) {
      errors.push(`criticalActions.${critical.id}: label is required`);
    }
  }

  // Scoring (spec S): valid references, positive points, explainable labels.
  const checkCriterion = (where: string, criterion: ScoringCriterion): void => {
    switch (criterion.kind) {
      case 'critical_action_done':
      case 'action_not_done':
        if (!actionIds.has(criterion.actionId)) {
          errors.push(`${where}: unknown action "${criterion.actionId}"`);
        }
        return;
      case 'any_action_done':
        if (criterion.actionIds.length === 0) {
          errors.push(`${where}: actionIds must not be empty`);
        }
        for (const actionId of criterion.actionIds) {
          if (!actionIds.has(actionId)) {
            errors.push(`${where}: unknown action "${actionId}"`);
          }
        }
        return;
      case 'cue_revealed':
        if (!findingIds.has(criterion.findingId)) {
          errors.push(`${where}: unknown finding "${criterion.findingId}"`);
        }
        return;
      case 'reassessed_after':
        if (!actionIds.has(criterion.actionId)) {
          errors.push(`${where}: unknown action "${criterion.actionId}"`);
        }
        if (criterion.withinMinutes <= 0) errors.push(`${where}: withinMinutes must be > 0`);
        return;
      case 'outcome_is':
        if (!outcomeIds.has(criterion.outcomeId)) {
          errors.push(`${where}: unknown outcome "${criterion.outcomeId}"`);
        }
        return;
      case 'vitals_obtained':
      case 'no_unsafe_actions':
        return;
    }
  };
  if (caseDef.scoring.length === 0) errors.push('at least one scoring entry is required');
  for (const entry of caseDef.scoring) {
    const where = `scoring.${entry.id}`;
    if (!CJMM_DIMENSIONS.includes(entry.dimension)) {
      errors.push(`${where}: unknown dimension "${entry.dimension}"`);
    }
    if (!Number.isInteger(entry.points) || entry.points <= 0) {
      errors.push(`${where}: points must be a positive integer`);
    }
    if (entry.label.trim().length === 0) errors.push(`${where}: label is required`);
    checkCriterion(where, entry.criterion);
  }

  // Concept mappings (spec T/AD): honest keys, scoreable dimensions.
  for (const mapping of caseDef.conceptMappings) {
    const where = `conceptMappings.${mapping.conceptName}`;
    if (normalizeConceptKey(mapping.conceptName) !== mapping.conceptKey) {
      errors.push(`${where}: conceptKey does not match normalizeConceptKey(conceptName)`);
    }
    if (!QUESTION_DIFFICULTIES.includes(mapping.difficulty)) {
      errors.push(`${where}: invalid difficulty`);
    }
    if (!COGNITIVE_LEVELS.includes(mapping.cognitiveLevel)) {
      errors.push(`${where}: invalid cognitiveLevel`);
    }
    if (mapping.dimensions.length === 0) {
      errors.push(`${where}: at least one dimension is required`);
    }
    for (const dimension of mapping.dimensions) {
      if (!CJMM_DIMENSIONS.includes(dimension)) {
        errors.push(`${where}: unknown dimension "${dimension}"`);
      } else if (!caseDef.scoring.some((entry) => entry.dimension === dimension)) {
        errors.push(`${where}: dimension "${dimension}" has no scoring entries`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
