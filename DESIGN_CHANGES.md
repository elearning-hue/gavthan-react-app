# UI Revamp — design change reference

Reference for porting the `ui-revamp-clean-white` redesign to the Capacitor
Android app. Theme: **clean white / off-white, minimalist, with a spatial
(visionOS-style) depth layer.**

## How this maps to the Capacitor Android app

The Android app is the **same Vite/React web bundle** wrapped in a Capacitor
WebView (`DEPLOY_TARGET=android` build of `src/`). There is **no separate native
UI** — all of these changes are CSS/JS. To apply the same design:

- **Option A (recommended):** build the Android app from this branch — the
  `android:build` / `cap sync` flow bundles the same `src/styles.css` + `src/app.js`.
- **Option B:** port the two files' changes (below) into the Android repo's copy.

Everything is **token-driven**, so light **and** dark mode both adapt. The dark
theme token block (`:root[data-theme="dark"]`) was **not changed** — only the
light tokens + component rules + a new spatial layer.

Files touched: `src/styles.css` (design), `src/app.js` (4 inline-color edits).

---

## 1. Design tokens — `:root` (light theme)

The foundation: warm cream → cool off-white, plus neutral shadows.

| Token | Before (warm) | After (clean) | Meaning |
|---|---|---|---|
| `--bg` | `#f3efe7` | `#f9fafb` | soft off-white layout background |
| `--surface` | `#ffffff` | `#ffffff` (same) | pure-white cards |
| `--surface-2` | `#f7f3ec` | `#f3f4f6` | subtle cool inset |
| `--surface-3` | `#efe9df` | `#e9ebef` | deeper inset |
| `--border` | `#e8e2d6` | `#e9ebef` | hairline cool-grey separators |
| `--border-strong` | `#d9d2c4` | `#d6dae0` | stronger border |
| `--bg-glow` | *(unset → warm `#fbf7ef`)* | `#ffffff` | neutral top glow |
| `--text` | `#211e1a` | `#1f2430` | primary text (cool near-black) |
| `--text-2` | `#6f6a62` | `#646b78` | muted text |
| `--text-3` | `#9a948b` | `#9aa0ad` | hint text |

Shadows re-tinted from warm brown to cool neutral:

| Token | Before | After |
|---|---|---|
| `--shadow-sm` | `0 1px 2px rgba(45,32,12,.05), 0 1px 3px rgba(45,32,12,.05)` | `0 1px 2px rgba(17,24,39,.04), 0 1px 3px rgba(17,24,39,.05)` |
| `--shadow` | `0 2px 6px rgba(45,32,12,.06), 0 6px 18px rgba(45,32,12,.06)` | `0 2px 6px rgba(17,24,39,.05), 0 8px 20px rgba(17,24,39,.06)` |
| `--shadow-lg` | `0 18px 48px rgba(35,24,8,.20)` | `0 18px 48px rgba(17,24,39,.16)` |

**Brand color unchanged:** `--primary` stays `#b45309` (light) / `#e08a3c` (dark).
Semantic tokens (`--green`, `--red`, `--primary-tint`, etc.) unchanged.

---

## 2. Component changes

### Main containers
Driven entirely by the token swap above — cards stay pure white (`--surface`),
the layout background becomes soft off-white (`--bg #f9fafb`), borders/shadows
go cool-neutral. No per-component rule changes needed.

### Active categories — `.cats button`
Solid orange block → minimalist soft tint + accent glow.
- Inactive: `background:transparent; border:1px solid transparent;` (was `--surface-2` + border).
- Hover: `background:var(--surface-2); color:var(--text)`.
- **Active (`.on`):** `background:var(--primary-tint); color:var(--primary);
  border-color:var(--primary); font-weight:700; box-shadow:0 0 0 3px rgba(180,83,9,.12);`
  (was a solid `--primary` fill with white text).
- Container gap `5px → 6px`, button padding `5px 12px → 6px 12px`.

### Item rows — `.mi-pick`
Thick-left-border cream cards → clean white list rows.
- **Removed:** `border:1px solid var(--primary-tint-2)`, `border-left:4px solid var(--primary)`,
  `border-radius:12px`, the cream `linear-gradient` background, `box-shadow`, and the
  `transform`/scale hover-active motion.
- **Now:** `border:none; border-bottom:1px solid var(--border); border-radius:0;
  background:var(--surface); padding:13px 12px; gap:11px;` (was `padding:10px 12px; gap:9px`).
- `.mi-pick:last-child{border-bottom:none}`.
- Hover `background:var(--surface-2)`, active `background:var(--surface-3)`.
- **In-order state (`.in`):** `background:var(--green-bg)` soft tint (was green gradient + green left border).
- `.mi-name` color `#2a2a26` → `var(--text)`.
- `.mi-price` pill: `background:#fff` → `var(--primary-tint)`, border `var(--primary-tint-2)`, text `var(--primary)`.
- `.mi-qty` color `#27500a` → `var(--green)`.
- nested `.qb` `28px → 30px`.

### Action buttons — `.qb` + new `.qb-add`
Solid orange squares → circular outline/tint buttons.
- `.qb`: `28px → 30px`, `border-radius:7px → 50%` (circular), `background:var(--surface-2) → var(--surface)`,
  hover adds `color:var(--primary)`.
- **New `.qb-add`** (the `+` button): `background:var(--primary-tint); border:1.5px solid var(--primary);
  color:var(--primary); font-weight:800;` and hover fills solid: `background:var(--primary); color:#fff`.
  (Replaces the old inline `background:#B45309;color:#fff;border:none` square in `app.js`.)

### Selected / expanded order card — `.ccard.sel`
Cream fill → clean white + primary outline + selection glow.
- `background:var(--primary-tint)` (cream) → `var(--surface)` (white).
- Added `box-shadow:0 0 0 3px rgba(180,83,9,.12), var(--shadow)` (selection glow + lift).
- `.ccard.sel:hover, .ccard.sel:active{transform:none; …}` — the tall expanded panel
  is pinned so it doesn't bounce with the spatial hover-lift.

### Current order panel — `.cur-order`
Fixed cream "receipt" slab → theme-aware summary well.
- **Removed** the pinned local tokens (`--surface/--text/--border/--primary` overrides) and the
  `background:#FAEEDA; color:#211e1a` cream.
- **Now:** `background:var(--surface-2); border:1px solid var(--border);
  border-top:2px solid var(--primary); border-radius:12px; padding:11px 13px;`.
- `.cur-order .li{border-bottom-color:var(--border)}` for clean row separators.
- Text now follows the real `--text` token → legible in light **and** dark (the old
  version glared as a cream block in dark mode).

### Removed obsolete dark-mode fixups
The old `:root[data-theme="dark"] .mi-pick …` overrides (dark gradients + left
border + name/price/qty colors) were **deleted** — `.mi-pick` now uses theme
tokens, so dark mode adapts automatically.

---

## 3. Spatial UI layer (new section in `styles.css`)

visionOS-style depth. Self-contained block; all motion gated behind
`@media (hover:hover)` and disabled under `prefers-reduced-motion`.

- **Ambient depth field** — `body::before`: fixed, `z-index:-1`, soft radial pools of
  colored light (light + dark variants) behind the app.
- **Floating shell** — `@media (min-width:520px){ .wrap{box-shadow:0 0 0 1px var(--border), var(--shadow-lg)} }`.
- **Glass nav** — `.nav`: `background:var(--glass)`, `backdrop-filter:var(--glass-blur)`,
  `border:1px solid var(--glass-border)`, inset top sheen (dark variant softer).
- **Elevation** — `.card, .met, .ccard` get `transition` + on hover `translateY(-3px)` +
  `var(--shadow)`; active `translateY(-1px)`. (`.card, .met` also given base `--shadow-sm`.)
- **Primary action** — `.btn-a` colored glow `0 2px 10px rgba(180,83,9,.28)`; hover lifts to
  `0 8px 20px rgba(180,83,9,.34)`.
- **Modals** — `.ovl` backdrop `blur(8px) saturate(1.2)`; `.modal` gains a glass edge ring.
- **Lists stay flat by design** — `.mi-pick` rows do NOT lift (content vs. floating objects).

> Capacitor/WebView note: `backdrop-filter` and `prefers-reduced-motion` are
> supported by modern Android System WebView (Chromium). `@media (hover:hover)`
> evaluates false on touch, so the lift/glow only fire where a pointer exists —
> the app stays calm on the billing tablet. No native changes required.

---

## 4. `src/app.js` inline-color edits

Hardcoded hexes → theme tokens so they read correctly on both surfaces:

| Location | Before | After |
|---|---|---|
| `+` add button | `className:'qb', style:{background:'#B45309',color:'#fff',border:'none'}` | `className:'qb qb-add'` (no inline style) |
| CURRENT ORDER header | `color:'#27500A'` | `color:'var(--green)'` |
| Discount row | `color:'#166534'` | `color:'var(--green)'` |
| Adjustment row | `color:(aAmt<0?'#166534':'#991B1B')` | `color:(aAmt<0?'var(--green)':'var(--red)')` |
| Total amount | `color:grand===0?'#991B1B':'#B45309'` | `color:grand===0?'var(--red)':'var(--primary)'` |

---

## 5. Porting checklist (Android repo)

- [ ] Apply the light-theme `:root` token changes (§1) — biggest visual shift.
- [ ] Apply the cool-neutral shadow tokens (§1).
- [ ] Replace the `.cats button` / `.cats button.on` rules (§2).
- [ ] Replace the `.mi-pick` block + remove the old dark-mode `.mi-pick` fixups (§2).
- [ ] Update `.qb` and add `.qb-add` (§2).
- [ ] Update `.ccard.sel` (+ its hover/active) (§2).
- [ ] Replace the `.cur-order` block (§2).
- [ ] Add the whole **Spatial UI** section (§3).
- [ ] Apply the 5 `app.js` inline-color edits (§4).
- [ ] Rebuild: `npm run android:build && npx cap sync android` and verify in light + dark.

Source of truth: the `ui-revamp-clean-white` branch (commits `90b8322`, `de9e063`,
`539348d`, `7df18e1`). `git diff main...ui-revamp-clean-white -- src/styles.css src/app.js`
shows the exact lines.
