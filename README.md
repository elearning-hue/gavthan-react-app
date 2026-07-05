# Gavthan — Billing

A restaurant billing app for in-house & takeaway dining: take orders, apply
discounts/adjustments, settle with sequential invoice numbers, and print/share
bills (thermal Bluetooth/USB, PDF, JPEG, WhatsApp, SMS). Built as a React + Vite
PWA on Supabase, and packaged as a native Android app via Capacitor. The same
`src/` powers both the web and Android builds.

- **Frontend:** React 18 (via `React.createElement` — no JSX) + Vite, single-file
  app in `src/app.js`, styles in `src/styles.css`.
- **Backend:** Supabase — Auth (email/password), Postgres tables (`mh_*`), and two
  Edge Functions (`user-admin`, `drive-token`) that hold the service-role secrets.
- **Android:** Capacitor wrapper (`android/`, `capacitor.config.json`).

## Features

- **Orders** — per-table/room orders, live menu picker with categories, quantity
  steppers, running "current order" summary. Multi-device: every terminal polls
  the shared tables every 5s.
- **Billing** — value-driven discount % (0–100) and ± adjustment with a mandatory
  reason; **atomic sequential bill numbers** (`next_bill_no()` RPC) with a DB
  unique index so numbers can never collide or duplicate.
- **Printing / sharing** — thermal ESC/POS (Web Bluetooth / WebSocket relay /
  network printer), browser Print, Save PDF, Save Image (JPEG), **WhatsApp bill as
  a structured JPEG** (Web Share), SMS, and a UPI "pay instantly" deep link.
- **History** — admins see all settled bills with date/month/year + staff filters
  and Excel export; staff see their own settled orders for today.
- **Manager** — analytics dashboard (revenue, top items, sales by staff, busiest
  hours). **Customers** — unique-customer directory with spend/visits.
- **Admin (Config → Users)** — add/remove staff, enable/disable, promote/demote,
  password reset, session timeout, UPI ID, and backups.
- **Backups** — manual JSON export/restore + optional automatic Google Drive
  backup (daily/weekly/monthly).
- **UX** — light/dark theme, idle auto-logout, offline banner, shared-device-safe
  session handling (full remount per user).

## Roles

- **Staff** (`role='user'`) — take/settle/delete their own orders; see their own
  today's history.
- **Admin** (`role='admin'`) — all orders, Menu, Customers, Manager.
- **Seeded super-admin** (email in `VITE_ADMIN_EMAILS` / `GH_ADMINS`) — also gets
  the **Config → Users** tab.

## Security (required setup)

The app relies on Supabase **Row Level Security**. After creating the tables you
**must** run [`SECURITY-MIGRATION.sql`](./SECURITY-MIGRATION.sql) in the Supabase
SQL Editor. It:

- enables RLS + `authenticated`-only policies on all `mh_*` tables;
- adds the atomic `next_bill_no()` function + a unique index on `mh_customers.bill_no`;
- blocks direct client changes to `mh_users.role/active/email` (a trigger), so all
  privilege changes go through the `user-admin` Edge Function.

> Do **not** disable RLS. The in-app Setup screen intentionally no longer ships
> `disable row level security` statements.

**Bootstrap admin:** because the client can no longer self-provision `mh_users`
rows under RLS, seed the first admin once via SQL:

```sql
insert into mh_users (id, email, display_name, role, active)
values ('<auth-user-uuid>', 'admin@yourhotel.com', 'Admin', 'admin', true)
on conflict (id) do update set role='admin', active=true;
```

Thereafter, add staff from **Config → Users** (the `user-admin` Edge Function
creates both the auth user and the `mh_users` row).

**Edge Function `user-admin`** must support these actions (used by the app):
`create-user`, `delete-user`, `set-role`, `set-active`.

## Configuration

Config is read from `window.GH_CONFIG` / `window.GH_ADMINS`, populated by
`src/config-init.js` from Vite env vars. Copy `.env.example` → `.env` and set:

| Var | Purpose |
|---|---|
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon key (public by design) |
| `VITE_UPI_ID` | Default UPI VPA for the pay link (`name@bank`) |
| `VITE_HOTEL_NAME` | Business name shown on bills |
| `VITE_PARTNER_DISCOUNT` | Default partner discount % |
| `VITE_GOOGLE_CLIENT_ID` | Google OAuth client id (Drive backup) |
| `VITE_ADMIN_EMAILS` | Comma-separated seeded super-admin emails |

The anon key and Google client id are public by design (they ship in every
bundle); real secrets stay server-side in the `user-admin` and `drive-token`
Edge Functions. This is only safe **with RLS enabled** — see above.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # → dist/
npm run preview    # serve the built dist/
```

## Deploy — web (Vercel)

Framework preset **Vite**, build `npm run build`, output `dist` (set in
`vercel.json`). Add each `VITE_*` var in the Vercel project's Environment
Variables (Vercel does not read your local `.env`).

## Deploy — web (GitHub Pages)

```bash
npm run deploy     # builds with DEPLOY_TARGET=gh-pages, publishes dist/ to gh-pages
```

Env vars are baked from your **local `.env`** at deploy time. If the repo name
differs from `gavthan-react-app`, update `base` in `vite.config.js`.

## Build — Android (Capacitor)

```bash
npm run android:build   # vite build with DEPLOY_TARGET=android (relative asset paths)
npm run android:sync    # build + npx cap sync android
npm run android:open    # open in Android Studio
npm run android:run     # build, sync, run on device/emulator
```

> **WebView note:** the packaged Android app is a stock WebView. Browser-only
> features — `window.print()`, `<a download>` (Save PDF/JPEG, backup, Excel), and
> `navigator.share` (WhatsApp image) — need native Capacitor plugins to work
> reliably on-device; thermal Bluetooth printing needs the WebSocket relay (Web
> Bluetooth is unavailable in the WebView). Prefer thermal/relay printing on the
> tablet build. See the audit notes for the current limitations.

## Repo map

```
index.html               # Vite root: favicon, Google Identity script, #root
SECURITY-MIGRATION.sql    # REQUIRED — RLS, policies, next_bill_no(), guards
DESIGN_CHANGES.md         # UI-revamp reference (tokens, components, spatial layer)
public/favicon.svg        # app tab icon
src/
  main.js                 # mounts <Root> (React 18 createRoot)
  config-init.js          # GH_CONFIG / GH_ADMINS from env
  app.js                  # entire app: auth, orders, billing, admin, backup
  thermal-print.js        # ESC/POS encoder + Bluetooth/WebSocket/network transport
  styles.css              # all styles + theme tokens (light/dark)
android/                  # Capacitor Android project
```

## Notes

- `app.js` is one large module by design (ported from the original single-file
  app). It builds and runs as-is; modularizing is an optional mechanical follow-up.
- Bundle is dominated by `xlsx`; lazy-load it in the Excel-export path if you want
  a smaller initial download.
