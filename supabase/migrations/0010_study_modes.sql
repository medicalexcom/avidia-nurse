-- 0010_study_modes.sql — M10: advanced study modes (spec B/AL).
--
-- M10 deliberately adds NO new tables and no new columns: every study mode
-- runs on the existing session/plan/attempt machinery (study_sessions,
-- study_session_plan, question_attempts, submit_question_attempt). The only
-- schema change is teaching study_sessions.session_type the five new mode
-- values so mode sessions are honestly labeled in the student's history.
-- Gamification (streaks) is a pure derivation over question_attempts
-- timestamps and needs no storage at all (ADR-0027).

alter table public.study_sessions
  drop constraint study_sessions_session_type_check;

alter table public.study_sessions
  add constraint study_sessions_session_type_check
    check (
      session_type in (
        'practice',
        'adaptive',
        'rapid_response',
        'find_the_danger',
        'who_first',
        'medication_lab',
        'boss_battle'
      )
    );
