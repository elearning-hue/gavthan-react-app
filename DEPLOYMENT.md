# Deployment & Troubleshooting

This covers the two reported problems: (1) the GitHub deploy branch having a
different structure on every push, and (2) Vercel **Preview** builds failing
while Production succeeds.

---

## 1. Consistent Git deployment structure

### What was wrong
- **No lockfile.** `package.json` used `^` version ranges, so a fresh install
  on a different machine (or a later date) could resolve different dependency
  minor/patch versions. Different dependency versions can change how the bundle
  is split, so the `assets/` file set varied push to push.
- **Unorganized output.** Vite emitted hashed files at the top of `assets/`
  with no folder structure, making diffs between builds noisy.

### What was fixed (already applied in this project)
1. **`package-lock.json` is now committed.** `.gitignore` explicitly keeps it.
   This pins every dependency to an exact version, so the build is reproducible.
2. **Deterministic output layout** in `vite.config.js`:
   ```
   dist/
   ├─ index.html
   ├─ .nojekyll
   └─ assets/
      ├─ css/index-<hash>.css
      └─ js/
         ├─ index-<hash>.js        (app)
         ├─ index.es-<hash>.js     (jsPDF)
         └─ purify.es-<hash>.js    (jsPDF's dompurify dep)
   ```
   Every build now emits this **exact same folder/file structure**. Only the
   `<hash>` portion changes — and only when the corresponding code actually
   changes. That hash is required for cache-busting; it is not "instability."
   Two builds of unchanged code are byte-for-byte identical (verified).
3. **`gh-pages` does a clean replace.** The `deploy` script is
   `gh-pages -d dist -b gh-pages` with no `--add` flag, so the branch contents
   are wiped and rewritten from `dist/` on every deploy. No stale files
   accumulate.

### Verify it yourself
```bash
npm run build && find dist -type f | sort   # note the structure
npm run build && find dist -type f | sort   # identical to the first run
```

### Deploy to GitHub Pages
```bash
npm run deploy
```
Publishes **only** `dist/` to the `gh-pages` branch (not the whole repo).

---

## 2. Vercel Preview deployment failing (Production OK)

When Production builds but Preview fails, the cause is almost always something
that differs **between the two environments**, not the app code. Work through
these in order.

### Step 1 — Read the actual error (do this first)
Vercel → your project → **Deployments** → click the failed **Preview** build →
**Building** logs. Scroll to the first red line. Everything below is the real
cause. The steps below cover the common ones.

### Step 2 — `npm ci` requires a committed lockfile  ← most likely
Vercel runs `npm install` (or `npm ci` if it detects a lockfile). If the repo
had **no** `package-lock.json`, or a stale one, the install step can fail or
resolve different versions than Production did.
- **Fix:** the lockfile is now committed. Commit it to the branch the Preview
  builds from, push, and redeploy. Confirm `package-lock.json` exists in the
  repo on the PR/branch that triggers the Preview.

### Step 3 — Environment variables not enabled for Preview
Vercel scopes env vars per environment. If `VITE_*` vars were added for
**Production only**, Preview builds run without them.
- Vercel → Settings → **Environment Variables**. For each `VITE_*` var, make
  sure **Preview** (and Development) checkboxes are ticked, not just Production:
  `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_UPI_ID`,
  `VITE_HOTEL_NAME`, `VITE_PARTNER_DISCOUNT`, `VITE_GOOGLE_CLIENT_ID`,
  `VITE_ADMIN_EMAILS`.
- Note: missing env vars won't *crash* the Vite build (they resolve to empty
  strings), but they will produce a non-working Preview. A hard build *error*
  is more likely Step 2 or Step 4.

### Step 4 — Node version mismatch
Vercel picks a Node version; if it differs from what the deps expect, the build
can fail only there.
- **Fix (applied):** `package.json` now has `"engines": { "node": ">=18.18.0" }`
  and a `.nvmrc` pinning Node 20. In Vercel → Settings → **General → Node.js
  Version**, set it to **20.x** to match. Redeploy.

### Step 5 — Build command / output dir
- Vercel → Settings → **Build & Output Settings**. With `vercel.json` present,
  these come from it: Framework **Vite**, Build Command `npm run build`, Output
  Directory `dist`. If you previously set overrides in the dashboard, clear them
  so `vercel.json` is the single source of truth.

### Step 6 — `base` path must stay `/` on Vercel
`vite.config.js` only switches `base` to `/gavthan-react-app/` when
`DEPLOYMENT_TARGET=gh-pages` is set (the gh-pages deploy script sets it). Vercel
does **not** set that var, so Vercel builds correctly use `base: '/'`. Do **not**
add `DEPLOY_TARGET` to Vercel's env vars, or asset URLs will 404 there.

### Step 7 — Clean reproduce locally (matches Vercel exactly)
```bash
rm -rf node_modules dist
npm ci          # fails fast if the lockfile is missing/out of sync
npm run build   # this is exactly what Vercel runs
```
If this passes locally with a clean `node_modules`, the remaining difference is
environmental (Steps 3–4), not code.

---

## Quick checklist before every deploy
- [ ] `package-lock.json` committed and up to date (`npm install` then commit if changed)
- [ ] Vercel env vars enabled for **Preview** + Production
- [ ] Vercel Node version = 20.x
- [ ] Local `npm ci && npm run build` passes from a clean checkout
