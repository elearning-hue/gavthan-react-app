-- ============================================================================
-- Gavthan Billing — server-side failed-login rate limit
-- Run in Supabase → SQL Editor (after SECURITY-MIGRATION.sql).
--
-- Backs up the client-side (localStorage) lockout with an authoritative,
-- cross-device limit: 3 failed attempts per email → 1-hour lock, enforced in
-- Postgres so clearing browser storage or switching devices does not bypass it.
--
-- Note: the lock is keyed by email, so a malicious actor could deliberately lock
-- a known email (a denial-of-service tradeoff inherent to email-based limits).
-- For IP-based protection, also enable Supabase Auth rate limits in the
-- dashboard (Authentication → Rate Limits). The two are complementary.
-- ============================================================================

create table if not exists mh_login_attempts(
  email        text primary key,
  fails        int not null default 0,
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);

-- No RLS policies are added → the table is not directly readable/writable by
-- anon/authenticated. All access goes through the SECURITY DEFINER functions
-- below, which are the only allowed surface.
alter table mh_login_attempts enable row level security;

-- Tunables (kept in one place)
--   max attempts before lock : 3
--   lock duration            : 1 hour

-- Read-only status check (called before attempting a sign-in).
create or replace function login_attempt_status(p_email text)
returns json language plpgsql security definer set search_path = public as $$
declare r mh_login_attempts;
begin
  select * into r from mh_login_attempts where email = lower(trim(p_email));
  if not found then
    return json_build_object('locked', false, 'attempts_left', 3, 'locked_until', null);
  end if;
  return json_build_object(
    'locked', (r.locked_until is not null and r.locked_until > now()),
    'attempts_left', greatest(0, 3 - r.fails),
    'locked_until', case when r.locked_until > now() then r.locked_until else null end
  );
end $$;

-- Record one failed attempt; locks after the 3rd. Resets the window if a prior
-- lock has already expired.
create or replace function record_login_fail(p_email text)
returns json language plpgsql security definer set search_path = public as $$
declare v_email text := lower(trim(p_email));
declare r mh_login_attempts;
begin
  insert into mh_login_attempts(email, fails, updated_at)
  values (v_email, 1, now())
  on conflict (email) do update set
    fails = case
              when mh_login_attempts.locked_until is not null and mh_login_attempts.locked_until <= now() then 1               -- prior lock expired → new window
              when mh_login_attempts.locked_until is not null and mh_login_attempts.locked_until >  now() then mh_login_attempts.fails  -- currently locked → no change
              else mh_login_attempts.fails + 1
            end,
    locked_until = case
              when mh_login_attempts.locked_until is not null and mh_login_attempts.locked_until <= now() then null
              else mh_login_attempts.locked_until
            end,
    updated_at = now()
  returning * into r;

  if r.fails >= 3 and (r.locked_until is null or r.locked_until <= now()) then
    update mh_login_attempts set locked_until = now() + interval '1 hour', updated_at = now()
    where email = v_email returning * into r;
  end if;

  return json_build_object(
    'locked', (r.locked_until is not null and r.locked_until > now()),
    'attempts_left', greatest(0, 3 - r.fails),
    'locked_until', case when r.locked_until > now() then r.locked_until else null end
  );
end $$;

-- Clear the counter on a successful sign-in.
create or replace function clear_login_fails(p_email text)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from mh_login_attempts where email = lower(trim(p_email));
end $$;

-- Callable before authentication (anon) and after (authenticated).
grant execute on function login_attempt_status(text) to anon, authenticated;
grant execute on function record_login_fail(text)   to anon, authenticated;
grant execute on function clear_login_fails(text)    to anon, authenticated;
