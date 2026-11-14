# ckanban design system (MASTER)

Source of truth for every screen in `web/`. A page file in `design-system/pages/` may override a rule here; nothing else may.
Built with UI UX Pro Max 2.15.0 (`ui-ux-pro-max` + `design-system`) from the tokens at the top of `web/src/styles.css` as of 2026-11-15. The tokens in section 1 to 8 are live in `web/src/styles.css`; the findings it was checked against are in `audit.md` next to this file.

**Enforced by `bun run test`** (`scripts/style-scale.ts`, `test/style-scale.test.ts`): in `styles.css` and in inline `style={{…}}` in `web/src/*.tsx`, a raw colour, an off-scale text size, weight, corner, shadow or icon size, or a padding, margin or gap that isn't a spacing token fails the build.

**Product:** developer productivity kanban board that runs Claude sessions. Used as much on a phone (390px, touch) as on a Mac (1280px+, keyboard).
**Style:** Flat, warm, quiet. The skill's `--design-system` run for "developer productivity kanban tool warm minimal" picked *Flat Design* (2D, no gradients, clean lines, typography first, 150-200ms colour transitions), which matches the app today. It also offered a teal palette and Inter as a web font; both are rejected (see "Decided against" at the end). The warm neutral background and orange brand stay: the contrast checks below show they pass once three small fixes land.
**Density dial:** 8/10 (dashboard). **Motion dial:** 3/10 (subtle).

Token layers (design-system skill): primitives are the hex values below; semantic tokens are the CSS variables; component tokens are not used (components read semantic tokens directly). Components never use raw hex, rgb, hsl or named colours. Raw colours are allowed only:
- in a custom property definition (`--name: #…`), which is how tokens are defined. The token blocks are at the top of `styles.css`; the only other ones are the tag hues (`--tag-bg`/`--tag-fg` built from `hsl(var(--tag-h) …)`).
- in `mask` / `mask-image` gradients, where only the alpha counts.
- in data palettes in `.ts` files (avatar colours, context-chart colours) and the avatar artwork in `AvatarFace.tsx`; these are content, not interface chrome.
Tints of a token use `color-mix(in srgb, var(--token) N%, transparent)`.

**Pinned card.** A pinned card shows the opposite theme. The theme blocks carry a second selector (`:root[data-theme="dark"] .card.is-pinned` in the light block, `:root:not([data-theme="dark"]) .card.is-pinned` in the dark one), so it uses the same tokens instead of a copied palette.

---

## 1. Colour tokens

Names are the CSS variables. Contrast is measured against the token in the "on" column (WCAG 2.x formula). Rows marked **changed** or **new** were added or changed on 2026-11-15; see section 12.

### Surfaces and text

| Token | Light | Dark | Use | Contrast check |
|---|---|---|---|---|
| `--bg` | `#f6f5f1` | `#1a1917` | Page, board background, dark chat background | |
| `--surface` | `#ffffff` | `#242320` | Cards, dialogs, panels, menus, top bar | |
| `--surface-2` | `#efede7` | `#2d2b28` | Columns, hover fills, done cards, inline code, banners | |
| `--border` | `#e2dfd6` | `#3a3834` | Dividers and card edges only (decorative, no 3:1 needed) | 1.33 / 1.34 on surface |
| `--border-strong` **new** | `#8c887f` | `#77736a` | Outline of anything you type in or toggle: inputs, selects, checkboxes, switch track off, segmented controls | 3.53 / 3.33 on surface, 3.24 / 3.72 on bg |
| `--text` | `#1f1e1b` | `#ecebe6` | Body text, titles | 16.7 / 13.2 on surface |
| `--muted` **changed (light)** | `#65625c` (was `#6b6862`) | `#9c998f` | Secondary text, labels, timestamps, placeholders | light 4.90 on accent-soft (was 4.47, fail), 5.19 on surface-2; dark 4.74 on accent-soft |
| `--chat-bg` | `var(--surface)` | `var(--bg)` | Behind messages on phone chats | |
| `--me-bubble` | `#f1efe9` | `var(--accent-soft)` | The user's own chat bubble | muted 4.83 / 4.74 |
| `--scrim` **new** | `rgba(20, 18, 15, 0.42)` | `rgba(0, 0, 0, 0.55)` | Behind dialogs, sheets, confirm, ticket panel on phone | |
| `--scrim-soft` **new** | `rgba(20, 18, 15, 0.2)` | `rgba(0, 0, 0, 0.35)` | Behind the desktop ticket panel and task sheet (board stays readable) | |

### Same in both themes

| Token | Value | Use |
|---|---|---|
| `--paper` | `#ffffff` | Always-white surfaces: PDF and web pages in Outputs, QR code, switch thumb |
| `--on-color` | `#ffffff` | Text and icons on a saturated fill that doesn't change with the theme (avatars, file tiles, colour swatches) |
| `--shade` | `#000000` | Only inside `color-mix` for dark tints (PDF placeholder shimmer, swatch icon shadow) |
| `--term-bg`, `--term-text`, `--term-muted`, `--term-prompt` | `#1f1e1b`, `#ecebe6`, `#9c998f`, `#e0805e` | The always-dark command block in chat, and the PDF zoom bar |
| `--file-any`, `--file-pdf`, `--file-doc`, `--file-xls`, `--file-ppt`, `--file-img` | `#74716a`, `#d0453a`, `#2b5fb8`, `#2f7d4f`, `#c8632a`, `#7a5bb5` | File type tiles (with `--on-color` text) |

### Brand

| Token | Light | Dark | Use | Contrast check |
|---|---|---|---|---|
| `--accent` | `#c96442` | `#e0805e` | Focus ring, active tab underline, borders, drop target, decoration. **Never text** | 3.57 on bg, 3.90 on surface (non-text 3:1 passes) |
| `--accent-strong` | `#b0502f` | `#e0805e` | Filled primary button, filled badges | `--on-accent` on it: 5.21 / 6.21 |
| `--accent-text` | `#a34a2b` | `#e0805e` | Orange text and links styled as brand | 5.88 on surface, 4.74 on accent-soft, 5.02 on surface-2 |
| `--on-accent` | `#ffffff` | `#1a1917` | Text and icons on `--accent-strong` | |
| `--accent-soft` | `#f6e3da` | `#3d2a22` | Selected chip, drop column, "on" states, dark user bubble | |

### Status (each has a text colour and a soft fill; text on its own fill passes 4.5:1)

| Token | Light | Dark | Use | On surface / on own soft fill |
|---|---|---|---|---|
| `--ok`, `--ok-soft`, `--on-ok` | `#2a7046`, `#dff0e5`, `#fff` | `#6cc28e`, `#1f3327`, `#1a1917` | Done, passed, live | 5.99 / 5.06 (light), 7.29 / 6.24 (dark) |
| `--warn`, `--warn-soft` | `#8a5900`, `#fbefd5` | `#e2b04a`, `#3a3020` | Needs you, waiting | 5.98 / 5.25, 7.89 / 6.49 |
| `--err`, `--err-soft` | `#b3261e`, `#fbe2df` | `#f08378`, `#3d2320` | Failed, destructive | 6.54 / 5.31, 6.15 / 5.63 |
| `--info`, `--info-soft` | `#2b5fb8`, `#e1eafb` | `#86aef0`, `#222d40` | Running, links | 6.12 / 5.06, 6.98 / 6.15 |
| `--star` | `#a67800` | `#e8b23a` | Star icon only (non-text) | 3.96 / 8.13 |

Rules:
- Status is never colour alone: every status colour comes with a word ("Needs you", "Failed") or a distinct icon. (`color-not-only`)
- Text on a status fill uses that status's own text colour (`--warn` on `--warn-soft`), never `--muted`.
- `prefers-contrast: more` keeps its block, with `--border-strong: #6f6b63` (light) and `#8f8b82` (dark).

## 2. Typography

System stack, no web font: `-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif`; code `--mono`.

| Token | Size | Use | Line height |
|---|---|---|---|
| `--fs-2xs` | 11px | Key hints, kbd, tiny counts. **On phones (≤720px) the token is 12px** | 1.3 |
| `--fs-xs` | 12px | Meta lines, section labels, badges, timestamps | 1.4 |
| `--fs-sm` | 13px | Secondary text in cards and menus, column titles | 1.45 |
| `--fs-md` | 14px | Desktop body, buttons, desktop fields | 1.45 (prose in chat 1.55) |
| `--fs-lg` | 16px | Phone body and **every field on phone**, dialog titles | 1.5 |
| `--fs-xl` | 20px | Phone screen titles, empty-state headline | 1.3 |

Weights: 400 body, 500 labels and menu items, 600 buttons, tabs, section labels, card titles, 700 column titles and the brand only. No other weights (already enforced by `test/style-scale.test.ts`).
Rules: numbers that change in place (costs, counts, timers, percentages) use `font-variant-numeric: tabular-nums`. Long ids, paths and URLs wrap with `overflow-wrap: anywhere`. Prose lines stay under about 75 characters on desktop (chat column max-width). Headings use `text-wrap: balance`.

## 3. Spacing

4px base. Page and section spacing use the 8-based steps; the two half steps (6, 10) are only for padding and gaps inside a control.

| Token | Value | Use |
|---|---|---|
| `--sp-1` | 2px | Hairline gaps (icon to count) |
| `--sp-2` | 4px | Inside chips, tight icon gaps |
| `--sp-2h` **new** | 6px | Inside controls only (button icon gap, chip padding) |
| `--sp-3` | 8px | Default gap between related items, card list gap |
| `--sp-3h` **new** | 10px | Inside controls only (button and field padding) |
| `--sp-4` | 12px | Card padding, phone page gutter |
| `--sp-5` | 16px | Section gap, dialog padding on phone, desktop page gutter |
| `--sp-6` | 24px | Between groups, dialog padding on desktop |
| `--sp-7` **new** | 32px | Empty states, page-level separation |

Every `padding`, `margin` and `gap` is `0`, `auto`, one of these tokens, or a `calc()`/`max()` of them (with `env(safe-area-inset-*)`, `%` or another token such as `--read-max`). Rules:
- Larger spaces are sums of steps: 40px is `calc(var(--sp-7) + var(--sp-3))`, 48px `calc(var(--sp-7) + var(--sp-5))`, 64px `calc(2 * var(--sp-7))`. This follows the skill's 4px scale (its 40/48/56/64 steps) without adding names nobody uses.
- Negative margins: `calc(-1 * var(--sp-2))`.
- `em` is allowed for prose rhythm in rendered markdown (`.md p { margin: 0.5em 0 }`): it follows the text size, which changes between phone and desktop.
- In `.tsx`, a style number is px, so spacing is a string of tokens: `` paddingLeft: `calc(var(--sp-3) + ${depth} * var(--sp-4))` ``.
- Tree indents step by `--sp-4` per level (`--sp-5` in the family tree).
- Reading widths are tokens too: `--read-max` 1100px (ticket chat, plan), `--thread-max` 760px (quick chat, huddle threads).

The 2026-11-15 sweep moved 534 off-scale values (14px, 3px, 5px, 7px, 18px, 9px…) to the nearest step: a tie went up for padding and negative margins (controls never shrink, and a negative margin keeps cancelling its padding) and down for margins and gaps; 1px became 2px, never 0. The other 2,200 on-scale px values became tokens.

## 4. Corners

`--r-sm` 6px (buttons, fields, chips with text, menu items), `--r-md` 10px (cards, columns, dialogs, menus, sheets, composer), `--r-pill` 99px (count badges, filter chips, status pills, switch), `50%` circles (avatars, dots). No change.

## 5. Shadows (elevation)

| Token | Use |
|---|---|
| none | Columns, done cards, anything inside a dialog |
| `--shadow-sm` | Resting cards, switch thumb |
| `--shadow-pop` | Menus, popovers, toasts, dragged card, key hints |
| `--shadow-panel` | Dialogs, ticket panel, side panels, phone sheets |

Ring and edge bars (no blur) are not elevation and stay allowed. No change to values.

## 6. Icons

One set: the line icons in `web/src/icons.tsx` (1.75px stroke, round caps). Sizes: 12 (inline in meta text), 14 (menus, buttons with text), 16 (icon-only buttons on desktop), 20 (phone bottom nav, phone top bar). No emoji as icons in controls or labels (the "✦" in "Say it simpler" and "↻ Refresh", "✉" Messages row, etc. become SVG icons). An icon next to visible text gets `aria-hidden`; an icon-only button gets `aria-label` and, if it toggles, `aria-pressed` or `aria-expanded`.

## 7. Motion

| Token **new** | Value | Use |
|---|---|---|
| `--dur-fast` | 120ms | Hover, press, colour changes, exits |
| `--dur-base` | 180ms | Menus, popovers, tab underline, chip state |
| `--dur-slow` | 240ms | Dialogs, sheets, ticket panel enter |
| `--ease-out` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | Things arriving |
| `--ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | Things leaving (exit at about 70% of enter) |

Every transition and one-off animation up to 300ms uses these (≤145ms fast, ≤200ms base, up to 300ms slow; `ease`/`ease-out` became `--ease-out`, `ease-in` `--ease-in`). Loops (`infinite`), longer effects (the 400ms finish flash, the 1.5s arrival ring, 2s attention flash) and `linear` keep their own timing. JS timers that wait for a CSS animation match its token (`PANEL_LEAVE_MS` 120 = `--dur-fast`, `LEAVE_MS` 180 = `--dur-base`).
Rules: animate only `transform` and `opacity` (no width, height, top, left). Every animation shows a cause (arrived, opened, moved). Loops (spinners, "working" pulses) are the only infinite animations. Reduced motion: keep the global `@media (prefers-reduced-motion: reduce)` rule in `styles.css` (`*, *::before, *::after` durations to 0.001ms, `scroll-behavior: auto`) and its still versions of each loop. Every new loop adds its still version there. JS motion must check it too: `scrollTo({ behavior: "smooth" })` and `scrollIntoView` use `"auto"` when `prefers-reduced-motion: reduce` matches (the global CSS rule doesn't reach them). The 13 small per-component reduced-motion rules elsewhere are now redundant and can go.

## 8. Layers (z-index)

The draft's proposal (modal 80, toast 100) didn't match the real stacking: menus inside dialogs sit at 80 above dialogs at 50, and toasts at 120. The live scale keeps today's order:

| Token | Value | Use |
|---|---|---|
| `--z-raised` | 1 | Sticky heads and footers inside a scroller |
| `--z-panel` | 40 | Ticket panel and its scrim; task sheet and Messages screen are `calc(var(--z-panel) + 5/6/8)` |
| `--z-modal` | 50 | Dialogs (`.overlay`) |
| `--z-sheet` | 60 | Phone More sheet, key hints bar |
| `--z-menu` | 80 | Dropdowns, popovers, menus (they open inside dialogs) |
| `--z-confirm` | 90 | Confirm over a dialog, mention picker |
| `--z-float` | 100 | Fixed popovers placed by JS; the phone menu sheet is `calc(var(--z-float) + 10)` |
| `--z-toast` | 120 | Toasts |
| `--z-tip` | 200 | Tooltips |

Small numbers (0 to 7) only order parts inside one component (a resize handle over its panel) and stay raw.

## 9. Components

**Buttons.** Variants: primary (filled `--accent-strong`, one per screen or dialog), default (surface, `--border-strong` outline), ghost (no border), danger (filled `--err`, only inside the confirm step), ghost-danger (red text, the trigger). Height 32px desktop, 44px phone. States: hover fill `--surface-2` (primary: brightness 1.06), pressed fill one step darker plus no layout change, focus = the shared ring, disabled = opacity 0.5 with `disabled` attribute and `cursor: not-allowed`, loading = label stays, spinner replaces the icon, button disabled. Icon-only buttons: 28px visual on desktop with a 32px hit area, 44px on phone.

**Cards.** `--surface`, `--border`, `--r-md`, `--shadow-sm`, padding 12px, gap 8px between cards. Title `--fs-md`/600 (phone `--fs-lg`). One meta line in `--fs-xs` `--muted`. Status edge: 3px left bar in the status colour plus a word in the meta line. Hover: border mixes 45% accent. Done: `--surface-2`, no shadow. Whole card is the tap target; controls inside it are at least 32px (desktop) / 44px (phone) and are reachable with Tab after the card (existing roving tabindex). Drag has a keyboard and tap alternative (M = Move, and "Move to…" in the card menu).

**Columns.** `--surface-2` on `--bg`, `--r-md`, no shadow, header 40px with title `--fs-sm`/700 and count badge. Collapsed column 42px wide (desktop), with the title written vertically and its count. Controls in the header are always visible on touch (no hover-only reveal). Empty column: one short muted line that says what lands there.

**Top bar.** `--surface` with a `--border` bottom line. Desktop: brand, board picker, status pill, spacer, "needs you", panels, New ticket (primary), More. Phone: brand, board picker, search, New ticket; everything else in More. Status pill is a button, so it is 32px tall on desktop.

**Tabs.** Text tabs, `--fs-md`/600, `--muted` until active; active = `--text` plus a 2px `--accent` underline. Counts sit in a `--surface-2` pill. Height 40px desktop, 44px phone. Use `role="tablist"` / `tab` / `aria-selected`; arrow keys move between tabs.

**Chat.** Prose `--fs-md` desktop / `--fs-lg` phone, line height 1.55, max line about 75 characters. The user's bubble `--me-bubble`; Claude's replies have no bubble. Actions under a reply (Copy, Say it simpler) are always visible on touch and visible on hover or focus on desktop. Tool steps fold into one "Did N steps" row. Streaming text sits in an `aria-live="polite"` region that announces when a reply finishes, not every token. The message box: 2 rows, grows to about 40% of the screen, label "Message Claude", Enter sends on desktop, Enter is a new line on phone, IME composition never sends, Send is disabled while empty, Attach is a 44px target on phone.

**Dialogs.** Always `Modal.tsx`: `role="dialog"`, `aria-modal`, labelled by its title, focus moves in on open and back to the trigger on close, Escape and a visible Close button close it, `--scrim` behind. Desktop: centred, `--r-md`, `--shadow-panel`, max width 560px (wide 760px), padding 24px. Phone: bottom sheet with grip, swipe down to close, full height for forms, safe-area padding at the bottom, the action bar sticks above the keyboard. One primary action, at the bottom right (desktop) or full width at the bottom (phone). Closing a dialog with typed but unsaved text asks first or keeps the draft.

**Forms.** Every field has a visible label (placeholder is only an example). Field height 32px desktop / 44px phone, `--fs-md` desktop / `--fs-lg` phone, `--border-strong` outline, focus = 2px `--accent` ring (border plus 1px shadow, as today). Helper text below in `--fs-xs` `--muted`. Errors under the field in `--err` with what to do, linked by `aria-describedby`, field gets `aria-invalid`. Validate on blur or submit, not per keystroke. Required fields are marked. Use the right `type`, `inputmode` and `autocomplete`.

**Menus.** `--surface`, `--r-md`, `--shadow-pop`, padding 4px. Items 32px desktop / 48px phone, icon 14px plus label `--fs-md`/500, hint or shortcut right-aligned `--muted`. Destructive items at the bottom after a separator, in `--err`. Arrow keys move, Escape closes and returns focus. On phone menus open as a bottom sheet (`MenuSheet.tsx`).

**Settings windows** (Automations, Connections, Devices, Browsers, Schedules, Squads, Notifications, Board settings). Same frame: title, one-line explanation, list, then detail. Phone: list then detail with a back arrow (the Automations pattern). Empty list: a short sentence on what it is, one example, and the primary action. Loading: skeleton rows the size of real rows, not a spinner in empty space. Errors: inline banner with a Retry.

**Toasts.** Bottom centre (desktop) or above the bottom nav (phone). `role="status"` (`role="alert"` for errors), never takes focus. 4s for info, 8s when there is an Undo, errors stay until closed. Max 3 stacked. Close button 32px / 44px phone.

**Empty and loading states.** Empty: what goes here, why it's empty, one action. Loading under 300ms shows nothing; under 1s a quiet spinner; longer shows skeletons; past 10s says what it is waiting for and offers Retry.

## 10. Phone rules (≤720px, `PHONE_QUERY`)

- Touch targets at least **44x44px** (today the floor is 40px in 111 places; raise them). Links inside prose get vertical padding so the hit area is 44px tall; small icons get an invisible hit area.
- At least 8px between neighbouring targets.
- Every field 16px text (iPhone zooms in below that).
- No sideways scroll at 375-390px; columns show one at a time.
- Fixed bars respect `env(safe-area-inset-*)`; scroll content gets padding so nothing hides behind the bottom nav or the message box.
- `100dvh`, never `100vh`.
- Bottom nav: 5 items, icon plus label, label 12px, active item in `--accent-text` with a filled icon.
- No hover-only controls: anything revealed on hover on desktop is always shown on phone.
- Swipe gestures (sheet close) always have a visible button too.
- `touch-action: manipulation` on buttons and cards.

## 11. Accessibility checklist (every change)

- Text 4.5:1, large text (≥18.66px bold or 24px) 3:1, controls and focus ring 3:1, in **both** themes.
- One visible focus ring: `outline: 2px solid var(--accent); outline-offset: 2px`. A component may replace it (fields use border plus 1px shadow) but never remove it with nothing in its place.
- Reduced motion honoured: the global CSS rule plus a still version for each loop, and JS scrolling checks the setting.
- Touch targets 44px on phone, 24px minimum (aim 32px) on desktop.
- Fields 16px on phone.
- Icon-only buttons have `aria-label`; decorative icons `aria-hidden`.
- Live counts and statuses announce as a full phrase ("3 tickets need you") through one `role="status"` region.
- Dialogs trap focus and return it. Drag-and-drop has a keyboard and tap alternative.
- Never convey status by colour alone.

## 12. Token changes from today

| Token | Today | Proposed | Reason |
|---|---|---|---|
| `--muted` (light) | `#6b6862` | `#65625c` | Muted text on `--accent-soft` (selected chips, drop column, Planning tint) is 4.47:1, under 4.5. New value is 4.90 and keeps the warm grey. |
| `--border-strong` | none | light `#8c887f`, dark `#77736a` | Field, select and checkbox outlines use `--border` at 1.33:1; WCAG 1.4.11 asks 3:1 for the edge of a control you must find to use. `--border` stays for dividers and cards. |
| `--scrim`, `--scrim-soft` | 6 raw rgba values (0.16, 0.18, 0.28, 0.35, 0.42, 0.5) | 0.42 / 0.2 light, 0.55 / 0.35 dark | One dimming level per layer type; dark mode today reuses the light rgba, which barely shows on a dark page. |
| `--fs-2xs` on phone | 11px | 12px (phone media query) | Bottom nav labels, badges and tab counts are 11px on a phone; the skill's floor for any readable text is 12px. Desktop keeps 11px for kbd and key hints. |
| `--sp-2h`, `--sp-3h`, `--sp-7` | none (6px, 10px and 32px are typed as numbers) | 6px, 10px, 32px | 6px and 10px are the most used values after 8px (446 and 307 uses); naming them stops new odd values. 32px is needed for empty states. |
| `--dur-fast`, `--dur-base`, `--dur-slow`, `--ease-out`, `--ease-in` | none (about 20 duration/easing pairs) | 120 / 180 / 240ms, two curves | One motion rhythm (`motion-consistency`), exits faster than entries. |
| `--z-*` | 22 raw values | 8 named layers | Stops layer fights (toasts under sheets, hints under dialogs). |
| Phone touch floor | 40px | 44px (`--tap`) | Apple HIG and the skill's `touch-target-size`; the project rule already says "40-44". The token exists; the controls move to it in batch A (A10). |
| Reduced motion in JS | global CSS rule only | JS smooth scrolling checks the setting too | The CSS rule can't stop `scrollTo({ behavior: "smooth" })` (phone column tabs, jump to message). |
| `--accent`, `--accent-strong`, `--accent-text`, status colours, dark tokens, radii, shadows, type scale | as today | no change | All text pairs pass 4.5:1 in both themes; the brand stays. |
| `--paper`, `--on-color`, `--shade`, `--term-*`, `--file-*`, `--thread-max` | raw values in rules | tokens | Found while replacing every raw colour and width (see section 1 and 3). |
| Pinned card palette | about 34 copied hex values | the theme tokens via a second selector | Can't drift from the themes (A22). Its surfaces are now exactly the other theme's (light `#ffffff`, dark `#242320`). |

## 13. Do / Don't

| Do | Don't |
|---|---|
| Use a token for every colour, size, corner, shadow, gap, duration and layer | Type a hex, rgba, px font size, px spacing or z-index in a component |
| Use `--accent-text` for orange text | Use `--accent` as text colour (3.9:1 on white) |
| Put one primary button per screen | Show two filled orange buttons side by side |
| Show actions on touch without hover | Hide the only way to do something behind hover |
| Pair a status colour with a word or icon | Use colour as the only signal |
| Keep focus visible on every control | Write `outline: none` without a replacement ring |
| Use `Modal.tsx` for every dialog | Build a one-off overlay |
| Make phone targets 44px and fields 16px | Shrink a button to fit one more on the row |
| Animate transform and opacity | Animate height, width or top |
| Use plain words ("copy of the folder", "version history") | Show "git", "worktree", "branch" in the UI |

## Decided against (skill suggestions not taken)

- **Teal primary `#0D9488` and teal background** from the skill's palette match: the warm neutral and orange pass every contrast check, and the user asked to keep them.
- **Inter as a downloaded web font**: the system font is already crisp on Mac and iPhone and loads instantly; Inter stays only as a fallback name.
- **"Product Demo + Features" landing pattern and GSAP scroll reveal**: this is an app, not a landing page.
- **Removing all shadows (pure flat)**: the three-step shadow scale tells resting cards from menus from dialogs and is cheap; kept.
