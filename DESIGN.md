---
version: alpha
name: Trebuchet
description: >
  The parchment engineering-schematic identity for the Trebuchet desktop app
  and the makesometokens.com landing page. Ink on aged paper, hairline rules,
  monospace labels — a tool that reads like a maintenance manual, not a launch
  pad. Token names below match the CSS custom properties in public/index.html
  one-to-one unless noted (e.g. primary -> --rubric).
colors:
  # Interaction. Code calls these --rubric / --rubric-dark.
  primary: "#9a2424"
  primary-dark: "#6e1818"
  # Parchment surfaces, lightest fill to deepest fold. There is no surface
  # LIGHTER than the page: panels are warm folds defined by borders, never
  # white cards. --field is the one fillable-input tone.
  paper: "#efe5cd"
  paper-card: "#e9dcbf"
  paper-deep: "#e4d6b3"
  paper-shadow: "#d9c79a"
  field: "#f3ecd6"
  # Ink, darkest text to faded caption.
  ink: "#1c1610"
  ink-soft: "#4a3b27"
  ink-fade: "#7a6a4f"
  # Gold affordance (secondary actions) + its hover and lighter fill.
  gold: "#b88a2a"
  gold-dark: "#a5781f"
  gold-soft: "#cda14a"
  gold-deep: "#8a6518"
  gold-bright: "#d4a82e"
  # Semantic state. Each solid has a -dark hover partner.
  success: "#5c7a35"
  success-dark: "#4a6429"
  danger: "#a52a2a"
  danger-dark: "#841f1f"
  # The single warm cream worn by text/icons on a filled DARK accent.
  on-accent: "#fdf6e3"
typography:
  display-h1:
    fontFamily: IM Fell DW Pica
    fontSize: 1.6rem
    lineHeight: 1.1
  display-h2:
    fontFamily: IM Fell DW Pica
    fontSize: 1.5rem
    lineHeight: 1.15
  display-smallcaps:
    fontFamily: IM Fell DW Pica SC
    fontSize: 1rem
    letterSpacing: 0.02em
  prose:
    fontFamily: EB Garamond
    fontSize: 1.05rem
    lineHeight: 1.55
  ui:
    fontFamily: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif
    fontSize: 1rem
    lineHeight: 1.5
  label-caps:
    fontFamily: JetBrains Mono
    fontSize: 0.62rem
    fontWeight: 700
    letterSpacing: 0.05em
  mono:
    fontFamily: JetBrains Mono
    fontSize: 0.85rem
spacing:
  xs: 0.25rem
  sm: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
rounded:
  xs: 2px
  sm: 4px
  md: 6px
  lg: 8px
components:
  page:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.ui}"
  panel:
    backgroundColor: "{colors.paper-card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
  panel-deep:
    backgroundColor: "{colors.paper-deep}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.sm}"
  field:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
  caption:
    textColor: "{colors.ink-fade}"
    typography: "{typography.label-caps}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.sm}"
    padding: 12px
  button-primary-hover:
    backgroundColor: "{colors.primary-dark}"
    textColor: "{colors.on-accent}"
  button-info:
    backgroundColor: "{colors.gold}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
  button-info-hover:
    backgroundColor: "{colors.gold-dark}"
    textColor: "{colors.ink}"
  button-success:
    backgroundColor: "{colors.success}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.sm}"
  button-success-hover:
    backgroundColor: "{colors.success-dark}"
    textColor: "{colors.on-accent}"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.sm}"
  button-danger-hover:
    backgroundColor: "{colors.danger-dark}"
    textColor: "{colors.on-accent}"
  badge-gold:
    backgroundColor: "{colors.gold-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xs}"
  action-card:
    backgroundColor: "{colors.paper-deep}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
  button-light-hover:
    backgroundColor: "{colors.paper-shadow}"
    textColor: "{colors.ink}"
  notice-warning:
    textColor: "{colors.gold-deep}"
    typography: "{typography.label-caps}"
  status-indicator-slow:
    textColor: "{colors.gold-bright}"
---

## Overview

Trebuchet looks like a tool, not a campaign. The whole surface is **ink on aged
paper**: a warm parchment field, sepia text, manuscript-red accents, hairline
rules, and monospace labels set in small caps. The reference points are a
maintenance manual, an engineering schematic, and a hand-set broadsheet — dry,
honest, and a little austere. Nothing here should feel like a product launch
page, because that is exactly the tone the app is trying not to strike.

Two faces carry the identity. **IM Fell DW Pica** (a 17th-century revival)
handles headings and hero lines; it is irregular and bookish on purpose.
**JetBrains Mono**, almost always uppercased and tracked out, labels everything
technical — the schematic captions, addresses, and signatures. Body prose in
modals uses **EB Garamond**; dense controls fall back to the system UI sans for
crispness at small sizes.

The single most important rule, and the one most easily broken: **no surface is
lighter than the page.** Depth comes from folds (slightly darker tones), hairline
ink borders, and warm shadows — never from a white card floating on parchment. A
fill lighter than `paper` reads as a stark white box and instantly cheapens the
whole screen.

## Colors

The palette is a warm neutral spine (`paper` -> `ink`) with one interaction
color and a small set of semantic accents. Everything is warm; there are no
neutral grays.

- **primary `#9a2424` (`--rubric`)** — manuscript red. The one driver of
  interaction: links, primary buttons, focus rings. `primary-dark` is its hover.
- **paper family** — `paper` is the page. `paper-card`, `paper-deep`, and
  `paper-shadow` are progressively deeper *folds* for panels, modal heads, and
  hover states. `field` is the one tone allowed to read as a fillable input.
- **ink family** — `ink` for text, `ink-soft` for secondary copy and borders,
  `ink-fade` for captions and metadata.
- **gold `#b88a2a`** — the secondary affordance. Because gold is a mid-tone, it
  carries **`ink` text, not `on-accent`** (see Do's and Don'ts — this is the
  contrast fix). `gold-dark` is its hover; `gold-soft` is a lighter fill for
  badges. Two further roles exist for cases the three above don't cover:
  **`gold-deep #8a6518`** is a darker gold for *text* sitting on a light gold
  tint (warning titles, on-chain error chips), where `gold-dark` would be too
  pale to read; **`gold-bright #d4a82e`** is a more saturated gold for status
  indicators and focus outlines that need to pop. There is no orange in the
  palette — values that drifted toward orange resolve to `gold-deep`.
- **success `#5c7a35`** — olive-forest green, warm rather than neon.
  **danger `#a52a2a`** — a brick red held one step off the rubric so "stop"
  reads distinct from an ordinary link. Each has a `-dark` hover partner.
- **on-accent `#fdf6e3`** — the warm cream worn by text and icons sitting on a
  filled *dark* accent (primary, success, danger). One token, not a literal
  copied into every rule.

Hairline rules and tints are expressed as translucent ink in code
(`rgba(28,22,16,0.15)` for `--rule`, `0.07` for `--rule-faint`) rather than as
solid color tokens, because they must darken whatever fold they sit on.

## Typography

Three roles, three faces:

- **Display — IM Fell DW Pica.** Headings, modal titles, hero lines
  (`display-h1`, `display-h2`). `IM Fell DW Pica SC` gives small-caps for
  section markers. Bookish and slightly irregular; never used below ~1rem.
- **Prose — EB Garamond.** Running copy inside modals and the disclaimer, where
  readability over several lines matters (`1.05rem / 1.55`).
- **Technical — JetBrains Mono.** `label-caps` is the schematic voice: ~0.62rem,
  weight 700, uppercased, tracked +0.05em — used for tile labels and field
  captions. `mono` (0.85rem) carries addresses, mints, and transaction
  signatures, which must never be set in a proportional face.

Dense UI controls use the system sans (`ui`) for sharpness; the serif faces are
reserved for headings and prose so small text stays legible.

## Layout

Spacing follows a rem rhythm rather than pixels, so it tracks the user's text
size: `xs 0.25rem`, `sm 0.5rem`, `md 0.75rem`, `lg 1rem`, `xl 1.5rem`. Panel
padding is typically `md`–`lg`; tight control clusters use `xs`–`sm`.

Structure is communicated with **hairline ink rules and faint blueprint
gridlines**, not with boxes and fills — the schematic look. A faint procedural
parchment grain and a 1px blueprint grid sit behind all content at `z-index:-1`
(see `body::before` / `body::after`) so they never intercept clicks. Modals are
the one floating layer; in demo mode they offset below the sticky amber banner
via the runtime `--demo-banner-height` variable.

## Elevation & Depth

Every shadow is **warm** — a brown-black (`rgba(60,44,22,…)`), never neutral
black — so lifted elements read as ink casting on paper. Four rungs, named as
tokens:

- **`--elev-card`** `0 1px 0 …0.05` — a resting card's barely-there lift.
- **`--elev-card-hover`** `0 .25em .6em -.1em …0.18` — a card raised on hover.
- **`--elev-pop`** `0 .4em .9em -.2em …0.18` — dropdowns and popovers.
- **`--elev-inset`** `inset 0 1px 2px …0.15` — a pressed/active well.

Interactive focus uses **`--focus-ring`** `0 0 0 0.125em rgba(154,36,36,0.2)` —
a rubric halo, matching the interaction color rather than a browser-blue outline.

## Shapes

Corners use the `rounded` scale: `xs 2px` for tags and chips, `sm 4px` (the
default) for panels, fields, and buttons, `md 6px` and `lg 8px` for larger
surfaces and tiles. Coins, avatars, and other circular mounts use `50%`
(`--radius-circle`). Pick a rung; avoid inventing in-between radii (the app had
collected a stray 3px and 7px before this scale existed).

## Components

The `components` block above is the contract. Highlights:

- **Buttons** are solid-accent with a `-hover` partner that swaps to the darker
  shade. Dark accents (primary, success, danger) wear `on-accent` cream; the
  gold info button wears `ink` (contrast — see below).
- **Panels / cards** are parchment folds (`paper-card` / `paper-deep`) with a
  hairline `--rule` border and, when raised, `--elev-card`. No white fills.
- **Fields** use the `field` tone, `rounded.sm`, and an `ink-fade` placeholder.
- **action-card** is the launch-complete dialog's list item: a `paper-deep` fold
  that lifts on hover (`--elev-card-hover`) and presses in on active
  (`--elev-inset`).

## Do's and Don'ts

**Do**
- Build panels from warm folds + hairline ink borders + a warm shadow. Let
  borders and depth do the work a white fill would otherwise do.
- Put `on-accent` cream on the dark accents (primary, success, danger) and
  `ink` on gold. This split is contrast-driven, not arbitrary (see below).
- Route every interaction through the rubric (`primary`). Links are rubric, the
  primary CTA is rubric, focus rings are rubric.
- Keep shadows warm brown-black and reach for an `--elev-*` token.
- Keep copy dry, technical, and honest about limitations. No marketing
  superlatives. Never name competitors — they don't get free placement.
- Reference a token (`var(--…)`) instead of pasting a hex; the token is the
  source of truth.

**Don't**
- **No surface lighter than the page.** A white or near-white card on parchment
  (`#fff`, `#fafafa`, `#f5f5f5`) reads as a stark box. Panels are warm folds; the
  only legitimate light surfaces are the named functional backings below.
- **No cream on gold.** `on-accent` (#fdf6e3) on `gold` (#b88a2a) is ~2.9:1 —
  below the WCAG AA 4.5:1 floor. Gold takes `ink` text (which clears it), and
  inversely `success` keeps cream because ink on olive is the *worse* pairing.
- **No neutral grays** (`#ccc`, `#777`, `#dbdbdb`) for borders or text. Use ink
  tints, which stay warm.
- **No browser-blue or Bulma-default accents** (links, danger pinks, indigo).
  Re-skin Bulma onto this palette. This includes the *warning* helpers
  (`.has-text-warning`, `.help.is-warning`, `.has-text-warning-dark`): Bulma's
  pale yellows are built for dark UIs and read at ~1:1 on parchment, so they map
  to `--warn-amber-ink` (the same amber the demo banner uses), which clears AA.
- **No stray white.** The only legitimate non-parchment light surfaces are
  functional backings, and each is a *named* token, not a loose literal:
  `--logo-backing` (#fff) behind remote token-logo chips, which may be
  transparent and need a neutral ground; the `.qr-code` quiet zone, which must
  be true white to scan; and the full-bleed splash video's black letterbox.
- **No neon on parchment.** The one sanctioned off-system surface is the
  activity-log **console** — a deliberately dark terminal panel (dark bg, muted
  grey chrome, phosphor-green info lines). It now has its own scoped
  `--console-*` token set so the exception is explicit and pinned to that panel;
  those colors must never leak onto the parchment surface.
