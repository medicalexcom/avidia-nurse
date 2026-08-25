-- 0022 - Fix: delete_my_account() can no longer DELETE storage.objects
-- directly (live-verification finding, 2026-08-25).
--
-- The CI authz harness's live run surfaced:
--   FAIL account deletion succeeds once the subscription is set to cancel
--     — Direct deletion from storage tables is not allowed. Use the
--       Storage API instead.
--   FAIL deletion removes the profile and every owned billing row
--
-- 0015's delete_my_account() issued `delete from storage.objects where
-- bucket_id = 'course-materials' and ...` directly in SQL. Supabase's
-- storage engine now rejects direct SQL deletes against storage.objects
-- (deleting only the metadata row would silently orphan the underlying
-- object in the storage backend) — object removal must go through the
-- Storage API, which this SECURITY DEFINER SQL function has no way to call.
--
-- Fix: remove the direct storage.objects delete from this function. Object
-- cleanup moves to the client (apps/app/src/features/billing/billingApi.ts,
-- companion change, not a migration): it lists the caller's own document
-- storage keys, calls this function (guard check + delete auth.users, which
-- still cascades every DB row including `documents` — unchanged), then —
-- only once that succeeds — removes the previously-listed objects via the
-- Storage API, using the still-valid session. Doing this client-side, after
-- a successful call, cannot destroy data on the guarded (active
-- subscription) path: nothing is removed unless the account deletion itself
-- already succeeded.
--
-- If the client-side cleanup step never runs (app closed mid-flow, network
-- failure), the objects are simply orphaned under the deleted owner's
-- private storage path — never reachable by any other user (storage
-- policies are owner-scoped by uid), so this cannot leak data; it is a
-- storage-cost cleanup gap, not a correctness or privacy issue, and is
-- recorded in docs/KNOWN_LIMITATIONS.md.

create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if exists (
    select 1 from public.subscriptions
    where user_id = uid
      and status in ('active', 'trialing', 'past_due')
      and not cancel_at_period_end
  ) then
    raise exception 'ACTIVE_SUBSCRIPTION: cancel your subscription before deleting your account'
      using errcode = 'P0001';
  end if;
  -- Storage object cleanup happens client-side after this call succeeds
  -- (see comment above) — Supabase no longer permits deleting
  -- storage.objects rows directly via SQL.
  -- auth.users cascades to profiles, which cascades through every
  -- user-owned table (0001+). Nothing user-owned survives.
  delete from auth.users where id = uid;
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
