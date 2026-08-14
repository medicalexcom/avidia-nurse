-- ===========================================================================
-- 0013_simulation_analytics.sql — M12 (spec Z/AA/AK/AO)
--
-- One read-only SECURITY DEFINER RPC releasing COMPACT per-completed-session
-- simulation aggregates for the caller's own course. Rationale:
--
--   * simulation_sessions.state / score / definition are server-only columns
--     (migration 0011, spec N) — clients cannot select them, and M11's only
--     release path (get_simulation_debrief) is one full debrief per session.
--     Analytics needs the small scored aggregates for ALL completed sessions
--     in a course without N debrief round-trips (spec AK) and without ever
--     exposing hidden case internals (findings, rules, dialogue stay inside
--     the definition and are NOT touched here).
--
--   * Everything returned is either already client-visible metadata
--     (case key/title, outcome id, timestamps) or a bounded numeric
--     aggregate the deterministic M11 engine computed (earned/possible,
--     per-dimension points, missed-critical and unsafe COUNTS — not the
--     labeled lists, which remain debrief-only detail).
--
-- No new tables, no stored analytics state: M12 is a read model (ADR-0033).
-- ===========================================================================

create or replace function public.get_simulation_analytics(p_course_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_result jsonb;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;
  -- Same ownership gate as every simulation RPC (spec AO): the course must
  -- belong to the caller; anyone else sees "course not found".
  if not exists (
    select 1 from public.courses c
    where c.id = p_course_id and c.user_id = v_user_id
  ) then
    raise exception 'course not found';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'sessionId', s.id,
    'caseKey', sc.case_key,
    'caseTitle', sc.title,
    -- Outcome kind/label resolved from the SNAPSHOT the session actually ran
    -- under (0011 reconciliation): a reseed must not relabel history.
    'outcomeId', s.outcome_id,
    'outcomeKind', coalesce((
      select o ->> 'kind' from jsonb_array_elements(s.definition -> 'outcomes') o
      where o ->> 'id' = s.outcome_id
    ), 'timeout'),
    'outcomeLabel', coalesce((
      select o ->> 'label' from jsonb_array_elements(s.definition -> 'outcomes') o
      where o ->> 'id' = s.outcome_id
    ), s.outcome_id),
    'completedAt', s.completed_at,
    'durationMinutes', s.state -> 'timeMinutes',
    'earned', s.score -> 'earned',
    'possible', s.score -> 'possible',
    'dimensions', s.score -> 'dimensions',
    'criticalMissedCount', coalesce(jsonb_array_length(s.score -> 'missedCriticalActions'), 0),
    'unsafeActionCount', coalesce(jsonb_array_length(s.score -> 'unsafeActionsTaken'), 0)
  ) order by s.completed_at, s.id), '[]'::jsonb)
  into v_result
  from public.simulation_sessions s
  join public.simulation_cases sc on sc.id = s.case_id
  where s.user_id = v_user_id
    and s.course_id = p_course_id
    and s.status = 'completed';

  return jsonb_build_object('sessions', v_result);
end;
$$;

revoke all on function public.get_simulation_analytics(uuid) from public, anon;
grant execute on function public.get_simulation_analytics(uuid) to authenticated;
