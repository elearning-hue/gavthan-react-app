# Gavthan — Billing (React + Vite)

This is the React + Vite build of the  Gavthan
billing PWA. The proven runtime logic is preserved verbatim; only the
packaging changed: CDN `<script>` globals became npm imports, config moved to
env vars, and there's a real build step.

## What's inside

```
gavthan-app/
├─ index.html            # Vite HTML root (loads /src/main.js + Google Identity script)
├─ package.json
├─ vite.config.js
├─ vercel.json           # SPA rewrites + build config for Vercel
├─ .env                  # your real config (gitignored) — already filled from the old HTML
├─ .env.example          # template
└─ src/
   ├─ main.js            # entry: mounts <Root> with React 18 createRoot
   ├─ config-init.js     # populates window.GH_CONFIG / GH_ADMINS from env (imported first by app.js)
   ├─ app.js             # the whole app — all components, helpers, Supabase/Drive logic
   ├─ thermal-print.js   # ESC/POS encoder + Bluetooth/WebSocket/network printer (ES module)
   └─ styles.css         # all styles, extracted from the original <style> block
```


## Local development

```bash
npm install
npm run dev      # http://localhost:5173
```

`.env` is already populated with the values from your old HTML, so it runs as-is.

## Production build

```bash
npm run build    # outputs to dist/
npm run preview  # serve the built dist/ locally to verify
```

## Deploy to Vercel

The app currently lives at `gavthan.vercel.app`. To redeploy this version:

1. Push this folder to your Git repo (or run `vercel` from the CLI here).
2. In Vercel, set the project's **Environment Variables** to match `.env`
   (Vercel does not read your local `.env`). Add each `VITE_*` var:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `VITE_UPI_ID`
   - `VITE_HOTEL_NAME`
   - `VITE_PARTNER_DISCOUNT`
   - `VITE_GOOGLE_CLIENT_ID`
   - `VITE_ADMIN_EMAILS`  (comma-separated)
3. Framework preset: **Vite**. Build command `npm run build`, output dir `dist`
   (already set in `vercel.json`).

## Deploy to GitHub Pages

```bash
npm run deploy
```

This runs `predeploy` (a Vite build with `DEPLOY_TARGET=gh-pages`, so asset URLs
use the `/gavthan-react-app/` repo subpath) then `gh-pages -d dist -b gh-pages`,
which publishes **only the compiled `dist/` folder** to the `gh-pages` branch —
not the whole repo. The published branch contains just `index.html`, `assets/`,
and `.nojekyll` (the last disables Jekyll so Vite's `assets/` folder is served
as-is). The app then loads at `https://<user>.github.io/gavthan-react-app/`.

> **Important — env vars on GitHub Pages.** Pages serves static files only; it
> can't inject `VITE_*` vars at deploy time the way Vercel does. The values are
> baked into the bundle from your **local `.env`** at `npm run deploy` time. Since
> the Supabase anon key and Google client id are public anyway, this is fine — but
> make sure your local `.env` is filled before deploying. If the repo is public,
> nothing secret is exposed (real secrets stay in the Edge Functions).
>
> If the repo name is ever different from `gavthan-react-app`, update the
> `base` path in `vite.config.js` to match `/<repo-name>/`.

> The Supabase **anon** key and Google **client id** are public by design — they
> ship in every client bundle. Real secrets stay server-side in your two Edge
> Functions (`drive-token`, `user-admin`), which are unchanged by this migration.



## Notes / follow-ups

- `app.js` is one large module (the original monolith body). It builds and runs
  as-is. If you later want true modularization (separate files per component/tab),
  that's a mechanical follow-up — split the components out of `app.js` and import
  the shared helpers. Nothing in this build blocks that.
- The bundle is ~976 KB (286 KB gzipped), dominated by `xlsx`. If you want it
  smaller, lazy-load `xlsx` only inside the CSV/Excel export path with a dynamic
  `import('xlsx')`.
