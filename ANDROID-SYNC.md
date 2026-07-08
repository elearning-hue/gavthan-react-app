# Android sync — `pre-launch-hardening` changes

Reference for porting the web app's `pre-launch-hardening` work into the parallel
**Capacitor Android app**. Both apps share the same `src/` and the same Supabase
project, so most of this is: rebuild the Android app from this branch (it bundles
the same `src/app.js` + `src/styles.css`), run the DB migrations once, and mirror
the Edge Function change.

> **Scope:** this doc covers everything EXCEPT the Bill-modal and KOT-modal UI
> changes (those are tracked separately). Items below are the security, auth,
> theme, i18n, and icon work.

---

## 1. Security & data integrity (DB + client)

**DB migrations (run once in Supabase — shared by both apps):**
- `SECURITY-MIGRATION.sql` — RLS + policies on all `mh_*` tables, atomic
  `next_bill_no()` RPC + unique index on `mh_customers.bill_no`, and a trigger
  blocking client changes to `mh_users.role/active/email`. **Do NOT disable RLS.**
- `SECURITY-LOGIN-RATELIMIT.sql` — `mh_login_attempts` table + `login_attempt_status`
  / `record_login_fail` / `clear_login_fails` RPCs (server-side failed-login lock).

**Edge Function `user-admin` must support:** `create-user`, `delete-user`,
**`set-role`, `set-active`** (role/active changes are now blocked as direct client
writes and routed through the function).

**Client changes already in `src/app.js`:**
- `settle()` → allocates bill numbers via `next_bill_no()` RPC + `.eq('status','active')`
  + in-flight guard; blocks empty/zero/negative totals.
- Pagination: `fetchAllRows()` pages `mh_customers` (loadCustomers + backup) past
  the 1000-row PostgREST cap.
- `HistoryTab` hooks moved above the early return (fixes a crash) + app-wide
  `ErrorBoundary`.
- Mid-session enforcement: re-check `mh_users` role/active every 30s → sign out
  disabled/deleted users; `changeUserRole`/`toggleUserActive` call the Edge Function.
- First-login no longer does the RLS-denied `mh_users` insert (shows "ask admin").
- Restore skips `mh_users` (service-role only) and reconciles the bill counter.
- Input hardening: discount clamp 0–100, adjustment clamp ±10L, per-order tap
  serialization, null-safe name/room filters, strict UPI VPA validation, `+91`
  phone parsing, local-date `ymd()` + History date bounds, single delete confirm.
- SetupScreen no longer ships `disable row level security`; adds `mh_config`.
- Bootstrap admin must be seeded once via SQL (see README).

## 2. Auth — login & lockout

- **Redesigned login**: theme-adaptive (light/dark), password show/hide, inline
  SVG icons, framed like the dashboard window (480px), accessible contrast.
- **Failed-login lockout — PER USER (per email), not per device.** 3 failed
  attempts → that account locked 1 hour. Client keys localStorage by email
  (`gv_lf:<email>` / `gv_ll:<email>`); server side is the `mh_login_attempts`
  RPCs. Locking one account never blocks another staffer on the same device;
  lock card has "Use a different account".

## 3. Theme — clean, no orange in dark

- Dark mode retuned to a neutral slate + **cool indigo accent** (`#8aa4ff`);
  light mode keeps the terracotta brand. Hardcoded `#B45309` accents tokenized
  to `var(--primary)`; spatial glows / badges / gauge / heatmap neutralized in
  dark (new `--primary-rgb` token).
- Clean white/off-white revamp of Orders/menu, spatial depth layer, theme-aware
  CURRENT ORDER panel and selected-order card.

## 4. Localization — Google Translate (Marathi)

- Header icon beside the theme toggle. **True toggle**: sets the `googtrans`
  cookie and reloads so Google applies it on a clean mount — one click reliably
  switches the whole page en↔mr (no flaky in-place translation).
- Injected Google banner/tooltip hidden via CSS. Proper nouns/data tagged
  `translate="no"` (staff name, customer names, menu items, amounts, the "KOT"
  label) so translation localizes the UI without mangling data.

## 5. App icon

- New `public/favicon.svg` (gradient bowl + steam + chopsticks). `index.html`
  links it via `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`.
- **Android:** regenerate the launcher/adaptive icons from this artwork
  (`android/app/src/main/res/mipmap-*`, `ic_launcher*`) — the SVG favicon does
  not update the native app icon.

---

## Excluded here (tracked separately)
- Bill-modal changes (bottom Cancel/Print, top-Print removal, WhatsApp text share).
- KOT-modal changes (confirmation modal, kitchen-ticket content, item timestamps).

## How to update the Android app
1. Pull `pre-launch-hardening`.
2. Run both SQL migrations in Supabase (once — shared DB).
3. Add `set-role` / `set-active` to the `user-admin` Edge Function.
4. `npm run android:build && npx cap sync android`, then rebuild in Android Studio.
5. Regenerate the native launcher icon from `public/favicon.svg`.
6. Verify on-device: login lockout is per-account, dark mode has no orange, the
   translate toggle switches the whole page in one tap, and the new icon shows.
