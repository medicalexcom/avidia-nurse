-- 0021 - Fix: missing INSERT/UPDATE column grants on the 0018 personalized-
-- learning tables (live-verification finding, 2026-08-25).
--
-- Running the CI authz harness against the real project for the first time
-- (after wiring SUPABASE_URL/SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY as
-- repo secrets) surfaced three failures:
--   FAIL owner creates a tutor conversation in own course
--   FAIL owner writes own user tutor message
--   FAIL owner queues personalized learning in own course
--
-- 0018 defines RLS policies that permit these owner-scoped inserts, but
-- Postgres also requires an explicit column-level GRANT before the
-- `authenticated` role may exercise an INSERT/UPDATE policy at all — RLS
-- policies gate *which* rows a grant applies to, they do not substitute for
-- the grant. `information_schema.role_table_grants` against the live
-- project confirms `authenticated` currently holds only SELECT (and, on
-- tutor_conversations, DELETE) on these three tables — the INSERT grant on
-- ai_learning_requests and tutor_messages, and the INSERT/UPDATE grants on
-- tutor_conversations, that 0018 specifies were never actually applied live
-- (this project's migration history isn't CLI-tracked, so 0018 was applied
-- by hand at some point and these column-grant statements were dropped).
--
-- This migration only (re)applies the exact grants 0018 already specifies —
-- no schema or policy change.

grant insert(user_id, course_id, kind, request, fingerprint)
  on public.ai_learning_requests to authenticated;

grant insert(user_id, course_id, title, context)
  on public.tutor_conversations to authenticated;
grant update(title, context)
  on public.tutor_conversations to authenticated;

grant insert(conversation_id, user_id, role, content)
  on public.tutor_messages to authenticated;
