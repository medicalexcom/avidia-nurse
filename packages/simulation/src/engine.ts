/**
 * Deterministic simulation engine — M11 (spec D/G/H/I).
 *
 * A pure interpreter: (case definition, patient state, student action) →
 * (new patient state, events). No randomness, no clock reads, no AI. The
 * same inputs always produce the same outputs (spec AZ), which is what
 * makes replay (replay.ts) and the SQL mirror possible.
 *
 * Processing order for one action (mirrored exactly by the SQL RPC):
 *   1. reject if the session is completed / the action is unknown
 *   2. advance simulation time by the action's time cost (spec H)
 *   3. fire any scheduled effects that have come due, in (time, id) order
 *   4. apply the action's own semantics (log, observe, reveal, dialogue)
 *   5. fire once-rules triggered by this action, in case order
 *   6. fire time- and phase-triggered rules to a fixed point (max 10 passes)
 *   7. an `end` effect completes the simulation and stops all processing
 *
 * State transitions come ONLY from case rules (spec G/AI): nothing in this
 * file invents a vital sign, a finding, or an outcome.
 */

import {
  PHYSIOLOGIC_BOUNDS,
  SIMULATION_ENGINE_VERSION,
  type ApplyResult,
  type CaseAction,
  type Condition,
  type Effect,
  type PatientState,
  type Rule,
  type SimulationCaseDefinition,
  type SimulationEvent,
  type SubmittedAction,
  type VitalKey,
} from './types';

/** Build the initial patient state for a case (spec C). */
export function startState(caseDef: SimulationCaseDefinition): PatientState {
  const findings: PatientState['findings'] = {};
  for (const finding of caseDef.findings) {
    findings[finding.id] = { present: finding.presentAtStart, revealed: false };
  }
  const labs: PatientState['labs'] = {};
  for (const lab of caseDef.labs) {
    labs[lab.id] = { released: lab.availableAtStart, value: lab.value, flag: lab.flag };
  }
  return {
    engineVersion: SIMULATION_ENGINE_VERSION,
    caseId: caseDef.caseId,
    caseVersion: caseDef.caseVersion,
    phase: caseDef.initialPhase,
    timeMinutes: 0,
    deteriorationLevel: 0,
    vitals: { ...caseDef.initialVitals },
    observedVitals: null,
    findings,
    labs,
    safetyFlags: [],
    statements: [],
    actionLog: [],
    scheduled: [],
    firedRules: [],
    completed: null,
  };
}

function clamp(vital: VitalKey, value: number, min?: number, max?: number): number {
  const bounds = PHYSIOLOGIC_BOUNDS[vital];
  const low = Math.max(bounds.min, min ?? bounds.min);
  const high = Math.min(bounds.max, max ?? bounds.max);
  return Math.min(high, Math.max(low, value));
}

function conditionMet(state: PatientState, condition: Condition): boolean {
  switch (condition.kind) {
    case 'time_at_least':
      return state.timeMinutes >= condition.minutes;
    case 'phase_is':
      return state.phase === condition.phase;
    case 'vital_at_most': {
      const value = state.vitals[condition.vital];
      return value !== undefined && value <= condition.value;
    }
    case 'vital_at_least': {
      const value = state.vitals[condition.vital];
      return value !== undefined && value >= condition.value;
    }
    case 'action_done':
      return state.actionLog.some((entry) => entry.actionId === condition.actionId);
    case 'action_not_done':
      return !state.actionLog.some((entry) => entry.actionId === condition.actionId);
    case 'finding_revealed':
      return state.findings[condition.findingId]?.revealed === true;
    case 'deterioration_at_least':
      return state.deteriorationLevel >= condition.level;
    case 'flag_set':
      return state.safetyFlags.includes(condition.flag);
    case 'flag_not_set':
      return !state.safetyFlags.includes(condition.flag);
  }
}

interface Ctx {
  caseDef: SimulationCaseDefinition;
  state: PatientState;
  events: SimulationEvent[];
  phasesEntered: string[];
}

function applyEffect(ctx: Ctx, effect: Effect): void {
  const { state, events, caseDef } = ctx;
  if (state.completed) return;
  const at = state.timeMinutes;
  switch (effect.kind) {
    case 'vital_delta': {
      const current = state.vitals[effect.vital];
      if (current === undefined) return;
      const next = clamp(effect.vital, current + effect.delta, effect.min, effect.max);
      if (next !== current) {
        state.vitals[effect.vital] = next;
        events.push({
          type: 'vital_change',
          vital: effect.vital,
          from: current,
          to: next,
          atMinutes: at,
          visible: false,
        });
      }
      return;
    }
    case 'vital_set': {
      const current = state.vitals[effect.vital];
      const next = clamp(effect.vital, effect.value);
      if (current !== next) {
        state.vitals[effect.vital] = next;
        events.push({
          type: 'vital_change',
          vital: effect.vital,
          from: current ?? next,
          to: next,
          atMinutes: at,
          visible: false,
        });
      }
      return;
    }
    case 'set_phase': {
      if (state.phase !== effect.phase) {
        state.phase = effect.phase;
        ctx.phasesEntered.push(effect.phase);
        events.push({ type: 'phase_changed', phase: effect.phase, atMinutes: at, visible: false });
      }
      return;
    }
    case 'set_finding_present': {
      const finding = state.findings[effect.findingId];
      if (finding) finding.present = effect.present;
      return;
    }
    case 'reveal_finding': {
      const finding = state.findings[effect.findingId];
      const def = caseDef.findings.find((f) => f.id === effect.findingId);
      if (finding && def && finding.present && !finding.revealed) {
        finding.revealed = true;
        events.push({
          type: 'finding_revealed',
          findingId: effect.findingId,
          system: def.system,
          text: def.text,
          atMinutes: at,
          visible: true,
        });
      }
      return;
    }
    case 'release_lab': {
      const lab = state.labs[effect.labId];
      const def = caseDef.labs.find((l) => l.id === effect.labId);
      if (lab && def && !lab.released) {
        lab.released = true;
        events.push({
          type: 'lab_released',
          labId: effect.labId,
          name: def.name,
          value: lab.value,
          unit: def.unit,
          flag: lab.flag,
          atMinutes: at,
          visible: true,
        });
      }
      return;
    }
    case 'set_lab_value': {
      const lab = state.labs[effect.labId];
      if (lab) {
        lab.value = effect.value;
        lab.flag = effect.flag;
      }
      return;
    }
    case 'schedule': {
      state.scheduled.push({
        scheduleId: effect.scheduleId,
        atMinutes: state.timeMinutes + effect.afterMinutes,
        effects: effect.effects,
      });
      return;
    }
    case 'cancel_scheduled': {
      state.scheduled = state.scheduled.filter((s) => s.scheduleId !== effect.scheduleId);
      return;
    }
    case 'set_deterioration': {
      if (state.deteriorationLevel !== effect.level) {
        state.deteriorationLevel = effect.level;
        events.push({
          type: 'deterioration_changed',
          level: effect.level,
          atMinutes: at,
          visible: false,
        });
      }
      return;
    }
    case 'add_flag': {
      if (!state.safetyFlags.includes(effect.flag)) {
        state.safetyFlags.push(effect.flag);
        events.push({ type: 'safety_flag', flag: effect.flag, atMinutes: at, visible: false });
      }
      return;
    }
    case 'patient_statement': {
      const statement = caseDef.statements.find((s) => s.id === effect.statementId);
      if (statement) {
        state.statements.push({ statementId: effect.statementId, atMinutes: at });
        events.push({
          type: 'patient_statement',
          text: statement.text,
          atMinutes: at,
          visible: true,
        });
      }
      return;
    }
    case 'end': {
      const outcome = caseDef.outcomes.find((o) => o.id === effect.outcomeId);
      state.completed = { outcomeId: effect.outcomeId, atMinutes: at };
      state.scheduled = [];
      events.push({
        type: 'completed',
        outcomeId: effect.outcomeId,
        label: outcome ? outcome.label : effect.outcomeId,
        atMinutes: at,
        visible: true,
      });
      return;
    }
  }
}

function fireRule(ctx: Ctx, rule: Rule): void {
  if (ctx.state.completed) return;
  if (rule.once && ctx.state.firedRules.includes(rule.id)) return;
  for (const condition of rule.conditions) {
    if (!conditionMet(ctx.state, condition)) return;
  }
  ctx.state.firedRules.push(rule.id);
  ctx.events.push({
    type: 'rule_fired',
    ruleId: rule.id,
    description: rule.description,
    atMinutes: ctx.state.timeMinutes,
    visible: false,
  });
  for (const effect of rule.effects) {
    applyEffect(ctx, effect);
    if (ctx.state.completed) return;
  }
}

/** Fire due scheduled effects in (atMinutes, scheduleId) order. */
function fireDueScheduled(ctx: Ctx): void {
  for (;;) {
    if (ctx.state.completed) return;
    const due = ctx.state.scheduled
      .filter((s) => s.atMinutes <= ctx.state.timeMinutes)
      .sort((a, b) => a.atMinutes - b.atMinutes || a.scheduleId.localeCompare(b.scheduleId));
    const next = due[0];
    if (!next) return;
    ctx.state.scheduled = ctx.state.scheduled.filter((s) => s.scheduleId !== next.scheduleId);
    for (const effect of next.effects) {
      applyEffect(ctx, effect);
      if (ctx.state.completed) return;
    }
  }
}

/** Fire time-/phase-triggered rules to a fixed point (bounded, spec D/P). */
function fireBackgroundRules(ctx: Ctx): void {
  for (let pass = 0; pass < 10; pass += 1) {
    if (ctx.state.completed) return;
    const before = ctx.state.firedRules.length;
    for (const rule of ctx.caseDef.rules) {
      if (ctx.state.completed) return;
      if (rule.trigger.kind === 'time') {
        fireRule(ctx, rule);
      } else if (
        rule.trigger.kind === 'phase_enter' &&
        ctx.phasesEntered.includes(rule.trigger.phase)
      ) {
        fireRule(ctx, rule);
      }
    }
    fireDueScheduled(ctx);
    if (ctx.state.firedRules.length === before) return;
  }
}

function cloneState(state: PatientState): PatientState {
  return JSON.parse(JSON.stringify(state)) as PatientState;
}

function applyActionSemantics(ctx: Ctx, action: CaseAction, submitted: SubmittedAction): void {
  const { state, events, caseDef } = ctx;
  const at = state.timeMinutes;

  if (action.observesVitals) {
    state.observedVitals = { vitals: { ...state.vitals }, atMinutes: at };
    events.push({
      type: 'vitals_observed',
      vitals: { ...state.vitals },
      atMinutes: at,
      visible: true,
    });
  }

  if (action.revealsSystems && action.revealsSystems.length > 0) {
    for (const system of action.revealsSystems) {
      const systemFindings = caseDef.findings.filter((f) => f.system === system);
      let presentCount = 0;
      for (const finding of systemFindings) {
        const entry = state.findings[finding.id];
        if (!entry || !entry.present) continue;
        presentCount += 1;
        if (!entry.revealed) {
          entry.revealed = true;
          events.push({
            type: 'finding_revealed',
            findingId: finding.id,
            system,
            text: finding.text,
            atMinutes: at,
            visible: true,
          });
        }
      }
      if (presentCount === 0) {
        events.push({ type: 'no_new_findings', system, atMinutes: at, visible: true });
      }
    }
  }

  if (action.type === 'ask_patient') {
    const prompt = caseDef.dialogue.find((p) => p.id === submitted.params?.promptId);
    if (prompt) {
      const gated =
        prompt.requiresFindingRevealed !== undefined &&
        state.findings[prompt.requiresFindingRevealed]?.revealed !== true;
      events.push({
        type: 'dialogue',
        question: prompt.question,
        response: gated
          ? (prompt.gatedResponse ?? 'I\u2019m not sure \u2014 can you check me first?')
          : prompt.response,
        atMinutes: at,
        visible: true,
      });
    }
  }
}

/**
 * Apply one student action (spec D/E/G/H). Pure: the input state is never
 * mutated; the returned state is a new object.
 */
export function applyAction(
  caseDef: SimulationCaseDefinition,
  previous: PatientState,
  submitted: SubmittedAction
): ApplyResult {
  if (previous.completed) {
    return { state: previous, events: [], rejected: 'simulation_completed' };
  }
  const action = caseDef.actions.find((a) => a.id === submitted.actionId);
  if (!action) {
    return { state: previous, events: [], rejected: 'unknown_action' };
  }
  if (action.promptRequired) {
    const promptId = submitted.params?.promptId;
    if (!promptId) return { state: previous, events: [], rejected: 'missing_prompt_param' };
    if (!caseDef.dialogue.some((p) => p.id === promptId)) {
      return { state: previous, events: [], rejected: 'unknown_prompt' };
    }
  }

  const state = cloneState(previous);
  const ctx: Ctx = { caseDef, state, events: [], phasesEntered: [] };

  // 2. time advances first (spec H) …
  state.timeMinutes += Math.max(0, action.timeCostMinutes);
  // 3. … then whatever was already coming due happens (deterioration does
  //    not wait for the student to look).
  fireDueScheduled(ctx);
  fireBackgroundRules(ctx);

  // 4. the action itself (still recorded even if the case just completed —
  //    the student did take it; but no further effects can fire).
  const classification =
    action.classification.byPhase?.[state.phase] ?? action.classification.default;
  const seq = state.actionLog.length + 1;
  state.actionLog.push({ seq, actionId: action.id, atMinutes: state.timeMinutes, classification });
  ctx.events.push({
    type: 'action_accepted',
    actionId: action.id,
    label: action.label,
    atMinutes: state.timeMinutes,
    visible: true,
  });
  ctx.events.push({
    type: 'action_classified',
    actionId: action.id,
    classification,
    atMinutes: state.timeMinutes,
    visible: false,
  });

  if (!state.completed) {
    applyActionSemantics(ctx, action, submitted);
    // 5. action-triggered rules, in case order.
    for (const rule of caseDef.rules) {
      if (state.completed) break;
      if (rule.trigger.kind === 'action' && rule.trigger.actionId === action.id) {
        fireRule(ctx, rule);
      }
    }
    // 6. background rules to a fixed point.
    fireBackgroundRules(ctx);
  }

  return { state, events: ctx.events, rejected: null };
}
