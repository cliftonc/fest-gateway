# Nearform design.md

Build applications like Nearform. This file is the design contract for any agent or
engineer producing Nearform-authored interfaces: web applications, dashboards, internal
tools, prototypes, and report pages. It pairs with two companion files in this folder:

- **`nearform-brand.css`** — the published stylesheet. Link it and use its classes and
  tokens. Never redeclare or alias an `--nf-*` token in page CSS.
- **`design-showcase.html`** — a rendered specimen of every component in this document.
  Open it to see what standard looks like before building anything.

Nearform interfaces are precise, calm, technically literate, and restrained. Expertise
shows through clarity, not decoration. When in doubt, remove things.

## Priority order

When requirements conflict, resolve in this order:

1. Preserve supplied facts, figures, units, and qualifiers. Never invent metrics,
   testimonials, or client names.
2. Preserve the caller's framework, routes, and build system.
3. Make the user's task and the strongest evidence immediately clear.
4. Establish unmistakable Nearform authorship: palette, Inter, sentence case, generous
   whitespace, the green accent used sparingly.
5. Choose composition specific to the material; avoid template defaults.

## Integrate with the caller's project

Load fonts and the brand stylesheet once, at the nearest layout boundary:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bitter:ital,wght@0,100..900;1,100..900&family=Inter:ital,wght@0,100..900;1,100..900&display=swap" rel="stylesheet">
<link href="nearform-brand.css" rel="stylesheet">
```

In React projects, use `className` and omit `<body>` markup. In Tailwind projects, map
the tokens below into `theme.extend` rather than hard-coding hex values — and replace
any near-miss Tailwind colour (`bg-blue-100`, `bg-emerald-50`) with the exact palette
value. No third-party UI kits, chart themes, or icon fonts without authorisation.

## Writing rules

- **Sentence case everywhere** — headings, buttons, labels, nav, table headers. First
  word and proper nouns capitalised, nothing else. Never title case, never ALL CAPS,
  no `text-transform: uppercase` anywhere.
- **UK English**: colour, optimise, organisation. The company is **Nearform** — never
  "NearForm".
- Write human: "we" and "you", contractions where natural, active voice, no filler
  ("leverage", "foster", "going forward").
- Headings are statements or questions a reader would ask, not category labels.

## Colour

All colour comes from this palette. No colours outside it, except the status set below.

```css
:root {
  /* Primary */
  --nf-midnight: #000E38;   /* text, dark surfaces, navbars */
  --nf-green:    #00E5A4;   /* accents, CTAs, decoration — never text on white */
  --nf-white:    #FFFFFF;   /* default background */

  /* Accents */
  --nf-purple:   #8950FF;   /* diagrams, secondary sections */
  --nf-blue:     #166BFF;   /* links, interactive elements, focus */

  /* Shades — 80/50/30/10 per colour */
  --nf-midnight-80: #0C3D60; --nf-midnight-50: #526288;
  --nf-midnight-30: #97A1B8; --nf-midnight-10: #F4F8FA;
  --nf-green-80: #33EAAE; --nf-green-50: #78EEC5;
  --nf-green-30: #B2F7E1; --nf-green-10: #E5FCF5;
  --nf-purple-80: #A173FF; --nf-purple-50: #C4A7FF;
  --nf-purple-30: #DCCAFF; --nf-purple-10: #F3EDFF;
  --nf-blue-80: #4589FF; --nf-blue-50: #8AB5FF;
  --nf-blue-30: #B9D3FF; --nf-blue-10: #E8F0FF;
  --nf-grey-10: #EAEBED; --nf-grey-30: #D9D9D9; --nf-grey-80: #454551;

  /* Status — status semantics only, never decoration */
  --nf-danger:  #D92D20;  --nf-danger-10:  #FEF1F0;
  --nf-warning: #B45309;  --nf-warning-10: #FDF6EC;
  --nf-success: #2B7D63;  --nf-success-10: #E5FCF5;

  /* Dark surfaces — neutral tier for the dark theme, darker than Midnight 80 */
  --nf-dark-bg:            #070A14;   /* page background */
  --nf-dark-surface:       #0D1220;   /* cards, inputs, alerts */
  --nf-dark-raised:        #151B2C;   /* raised panels, disabled fills */
  --nf-dark-border:        #222941;   /* hairline borders */
  --nf-dark-border-strong: #354061;   /* hover borders, strong rules */
}
```

The dark surface tier is part of the palette, not a side-channel. It exists because
nothing between Midnight 80 and black was defined; these are neutral navies for
application dark themes only, never for light-theme content:

| Token | Hex | Role |
| --- | --- | --- |
| `--nf-dark-bg` | `#070A14` | Dark theme page background |
| `--nf-dark-surface` | `#0D1220` | Cards, inputs, alerts |
| `--nf-dark-raised` | `#151B2C` | Raised panels, disabled fills |
| `--nf-dark-border` | `#222941` | Hairline borders |
| `--nf-dark-border-strong` | `#354061` | Hover borders, strong rules |

Hard rules:

- **Never green text on white. Never white text on green.** Both fail WCAG contrast.
  The ban is text-only — green backgrounds behind icons, bars, and shapes are fine.
  Midnight on green is allowed for short labels and CTAs.
- Midnight + Green is the core pairing for heroes and key content. Purple and Blue are
  seasoning for diagrams and secondary sections, never a replacement pairing.
- The 10-shades (`--nf-*-10`) are the pastel tier: tile backings, tinted panels, badge
  fills. The 30/50/80 shades are for charts, gradients, and texture.
- White surface + Midnight text is the default reading condition. Colour must add
  meaning; do not colour a number green just because it is favourable.

## Typography

| Role | Token / class | Size | Use |
| --- | --- | --- | --- |
| Display | `.nf-display` | clamp 40–56px | One page-defining statement, earned scale only |
| Title | `.nf-title` / `h1` | 32px | Page title |
| Heading 24 | `h2` | 24px | Major section turns |
| Heading 20 | `h3` | 20px | Nested structure |
| Heading 16 | `h4` | 17px | Card and column headings |
| Lede | `.nf-lede` | 18px | One short orientation passage |
| Body | default | 16px / 1.5 | Reading prose |
| Small | `.nf-small` | 14px | Dense UI, buttons, tables |
| Label | `.nf-label` | 13px | Form labels, stat labels |
| Caption | `.nf-caption` | 12px | Metadata, helper text |
| Pull-quote | `.nf-pull-quote` | 24px Bitter | Quotes and standout statements only |

- **Inter carries everything by default.** Bitter (serif) appears only in pull-quotes,
  testimonials, and standout statements — never headings, body, nav, or UI text. The
  one exception: table header rows use Bitter bold (brand standard).
- **Headings are never bold.** Weight 500 (`--nf-weight-heading`) carries hierarchy.
  Weight 600 is reserved for buttons and table emphasis.
- Body line length near 60–68 characters. Use `tabular-nums` (`.nf-numeric`) for
  aligned figures. No italic headings, ever.

## Layout and spacing

- 4pt scale: `--nf-space-1` (4px) through `--nf-space-16` (64px). Within a group use
  space 2–4; between groups 6–8; between sections 8–12; chapter breaks 16.
- Content container: `.nf-container` (max-width 1120px, 24px gutters).
- Generous whitespace — Nearform designs breathe. Prefer spacing and alignment over
  borders and boxes. Left-align body text; centre only heroes and section dividers.
- **No drop shadows.** Flat design, contrast-led. Depth comes from colour blocking
  (Midnight sections on white pages), hairline borders, and the pastel tier.

## Radius standard

One scale, applied everywhere. Do not invent per-component radii.

| Token | Value | Applies to |
| --- | --- | --- |
| `--nf-radius-xs` | 6px | Inline code, tiny elements |
| `--nf-radius-sm` | 8px | **Buttons, inputs, selects, alerts, icon tile backings, code blocks** |
| `--nf-radius-md` | 10px | Cards, panels, table wrappers |
| `--nf-radius-lg` | 12px | Gradient panels, media |
| `--nf-radius-pill` | 999px | Badges, chips, switches |

All interactive controls — buttons, form fields, selects — share one radius:
`--nf-radius-control`, which points at `--nf-radius-sm` (8px). Icon tile backings use
the same 8px. This supersedes the 4px button radius in the older `Nearform_Brand.md`.

## Buttons

```html
<button class="nf-btn nf-btn-primary">Get started</button>
<button class="nf-btn nf-btn-secondary">Learn more</button>
<button class="nf-btn nf-btn-icon" aria-label="Switch theme"><svg><!-- Lucide icon --></svg></button>
<button class="nf-btn nf-btn-ghost">Cancel</button>
<button class="nf-btn nf-btn-danger">Delete project</button>
```

- Primary is **Midnight text on Green** — never white on green. Weight 600, radius
  `--nf-radius-control` (8px), padding 10px 24px, sentence case.
- Hover stays quiet: **primary lifts to Purple 10, no border**; **secondary tints
  `--nf-midnight-10`** (its Midnight border unchanged); ghost tints
  `--nf-midnight-10`. Every button reserves a 1px transparent border so nothing
  shifts between states.
- Secondary border is **1px solid Midnight** (White on dark).
- Icon buttons (`.nf-btn-icon`) are for icon-only controls: theme switchers, menu
  toggles, close buttons. **Midnight 10 with a Midnight icon; hover is Midnight with
  a White icon.** Square: 40px (32 sm, 48 lg). Always carry an `aria-label`. In dark
  contexts the hovered state gains a subtle border so Midnight stays visible. Never
  give an icon button the slide.
- The icon slide is **opt-in**: add `.nf-btn-slide` to a button with a trailing icon
  and the icon slides 4px out on hover and back when the pointer leaves (400ms,
  `--nf-ease-soft`). The only sanctioned button animation; buttons without the class
  stay still.
- Sizes: `.nf-btn-sm` (32px) · default (40px) · `.nf-btn-lg` (48px).
- On Midnight surfaces (inside `.nf-on-dark`), primary is unchanged; secondary and
  ghost switch to white automatically.
- Every button ships all eight states: default, hover, focus-visible (2px blue ring,
  offset 2px, never animated), active (1px press), disabled, loading
  (`data-state="loading"`), and error/success handled by context.
- One primary button per view section. Icons inside buttons are 16px Lucide.

## Forms

```html
<div class="nf-field">
  <label class="nf-field-label" for="email">Work email</label>
  <input class="nf-input" id="email" type="email" placeholder="you@company.com">
  <p class="nf-helper">We'll only use this to send the report.</p>
</div>
```

- Controls are 40px tall, radius `--nf-radius-control` (8px), 1px `--nf-grey-30`
  border. Focus: blue border plus a 3px `--nf-blue-10` ring.
- Errors: set `aria-invalid="true"` on the control and add `<p class="nf-error">`.
  Never colour alone — the message states what to fix.
- Checkboxes and radios are native with `accent-color: var(--nf-midnight)`
  (`.nf-checkbox`, `.nf-radio`, wrapped in `.nf-choice`). Switches: `.nf-switch` —
  the knob is always Midnight; the track turns Green when on (decorative, allowed).
- Visible labels always. Placeholders are examples, not labels.

## Cards

```html
<div class="nf-card">…</div>                        <!-- white, hairline border -->
<div class="nf-card nf-card-raised">…</div>          <!-- midnight-10 fill, no border -->
<div class="nf-card nf-card-dark">…</div>            <!-- midnight fill, white text -->
<a class="nf-card nf-card-interactive" href="…">…</a><!-- border darkens on hover -->
```

Radius `--nf-radius-md`, padding `--nf-space-6`, no shadow. Do not wrap every section
in a card — cards are for true peer groups (feature grids, stats, case studies). Never
nest cards. Stats use `.nf-stat` with `.nf-stat-label` / `.nf-stat-value` /
`.nf-stat-detail`.

## Icon tiles

The signature icon treatment: a pastel rounded square with a Lucide glyph **larger than
the square**, overhanging the bottom-right corner.

The size maths: Lucide draws in a 24px viewBox, so `stroke-width = 24 / glyph size`
always lands on a 1px rendered stroke.

| Size | Tile | Radius | Glyph | Offset | stroke-width |
| --- | --- | --- | --- | --- | --- |
| md | 40px | `--nf-radius-sm` (8px) | 48px | 6px | 0.5 |
| lg (default) | 48px | `--nf-radius-sm` (8px) | 56px | 8px | 0.43 |

The backing square uses the same standard radius as buttons and form fields —
`--nf-radius-sm` (8px) at both sizes. Do not soften it further.

```html
<span class="nf-icon-tile" data-tone="sky">
  <svg viewBox="0 0 24 24" aria-hidden="true"><!-- any Lucide icon paths --></svg>
</span>
```

Tones — pastel (Midnight glyph): `tint` (green-10, default) · `sky` (blue-10) ·
`violet` (purple-10) · `cloud` (midnight-10). Solid: `green` (Midnight glyph — icons
on green are fine) · `blue`, `purple`, `midnight` (White glyph).

React + Tailwind equivalent:

```jsx
const glyph = 56, tile = 48, offset = 8;   // lg — md is 48/40/6
<div className="relative size-16">
  <div className="absolute size-12 rounded-lg bg-[#E8F0FF]" />   {/* rounded-lg = 8px */}
  <FileText className="absolute left-2 top-2 size-14 text-[#000E38]"
            strokeWidth={24 / glyph} />
</div>
```

Note: legacy code used Tailwind `bg-blue-100` for the sky tile — standardise to
`--nf-blue-10` (#E8F0FF) — and `rounded-2xl` on the backing — standardise to
`rounded-lg` (8px).

## Iconography

- **Lucide, outline style, always.** No filled icons, no mixed sets, no emoji as UI.
- Midnight on light surfaces; White or Green on dark. Green icons are fine — the
  contrast ban applies to text only.
- Inline the SVG (preferred) or use the Lucide CDN. Default UI icons are 16–20px at
  `stroke-width: 2`; only icon tiles use the oversized-glyph maths above.
- Icons support a label or sit inside an icon tile. Do not scatter decorative icons
  next to every heading.

## Gradient backgrounds

Two families, drawn from the brand's slide backgrounds. These are the **only**
permitted gradients — no gradient text, no glows behind cards, no mesh noise.

**Backings** — soft pastel washes on white for light heroes and section backgrounds.
The colours are diffused and merge into each other and the white — never hard-edged
spots. Body text stays Midnight and fully legible; keep the washes away from dense
reading columns.

```html
<section class="nf-bg-backing-a">…</section>   <!-- green + blue, top-right -->
<section class="nf-bg-backing-b">…</section>   <!-- blue + green, bottom-left -->
<section class="nf-bg-backing-c">…</section>   <!-- purple + green, bottom-right corner -->
```

**Transitions** — Midnight with Green/Purple/Blue glows, for dark heroes, section
dividers, and closing panels. Text on these is White (headings) with Green reserved
for the underscore motif and icons.

```html
<section class="nf-bg-transition-a nf-on-dark">…</section>  <!-- green + purple, bottom -->
<section class="nf-bg-transition-b nf-on-dark">…</section>  <!-- purple + blue, right edge -->
<section class="nf-bg-transition-c nf-on-dark">…</section>  <!-- purple top, green below -->
```

Use at most one gradient surface per viewport. Everything between gradient sections is
plain white.

## Tables

```html
<div class="nf-table-wrap">
  <table class="nf-table">
    <thead><tr>
      <th scope="col">Service</th>
      <th scope="col" class="nf-numeric">Requests</th>
    </tr></thead>
    <tbody><tr>
      <td>Checkout API</td>
      <td class="nf-numeric">128,540</td>
    </tr></tbody>
  </table>
</div>
```

- Header row: Green fill, **Midnight Bitter bold** text — never white on green.
- Body: white rows, `--nf-grey-30` hairline separators, **no zebra striping**.
- Numeric columns right-aligned with `.nf-numeric` on both `th` and every `td`.
  Tabular numerals, consistent units and precision.

## Badges and alerts

```html
<span class="nf-badge" data-tone="green">Active</span>
<div class="nf-alert" data-tone="info">
  <svg viewBox="0 0 24 24" aria-hidden="true"><!-- Lucide status icon --></svg>
  <p><strong>Heads up.</strong> …</p>
</div>
```

Badge tones: default (grey) · `green` · `blue` · `purple` (all Midnight text with a
coloured dot) · `success` / `warning` / `danger` (status text colours). Alert tones:
`info`, `success`, `warning`, `danger` — tinted fill, a full 1px border in the status
colour, a Lucide status icon, Midnight text.

**Never build an alert (or anything else) with a coloured left-border stripe.** That
side-accent pattern is the default LLM tell and is banned across the entire system —
state is carried by the tint, the border, and the icon together. Do not use badges
for ordinary metadata; they mark state.

## Brand motifs

At most two motifs per page — seasoning, not structure.

- **Trailing underscore** — the signature move. The page's one or two most prominent
  headings may end with a Green underscore: `<h1>Engineered differently<span
  class="nf-u">_</span></h1>`. Never on every heading.
- **Accent bar** — `<span class="nf-accent-bar"></span>`: a 48×4px Green block above a
  section heading. Decorative only, never contains text.
- **Dark hero** — Midnight (or a transition gradient) with White text and Green
  accents. The core brand pairing for heroes and dividers.
- **Logo** — full wordmark where space allows; N_ monogram in compact contexts.
  Midnight wordmark + Green bar on light; White + Green on dark. The Green bar is
  always `#00E5A4`. SVG code lives in `Nearform_Brand.md`.

## Dark theme

The stylesheet ships a full dark theme. Set `data-theme="dark"` on `<html>`; the
semantic aliases (`--nf-text`, `--nf-surface`, `--nf-border-*`, `--nf-link`,
`--nf-focus`, `--nf-field-bg`, the status `-fg` tokens) flip and every component
follows. Components must only ever reference semantic aliases, never assume
Midnight-on-white.

To respect the visitor's stored choice or system preference before first paint, put
this in `<head>` before the stylesheet:

```html
<script>
(function () {
  var t = null;
  try { t = localStorage.getItem('nf-theme'); } catch (e) {}
  if (t !== 'dark' && t !== 'light') {
    t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.dataset.theme = t;
})();
</script>
```

A theme switcher toggles the attribute and persists to `localStorage('nf-theme')`
inside try/catch. Give it `aria-pressed` and a label that names the theme it
switches to.

What changes in dark:

- Surfaces move to the dark tier above; text is White with `--nf-midnight-30`
  secondary.
- Links become `--nf-blue-50`; the focus ring becomes Green; input focus rings use
  a `--nf-blue-50` glow.
- Checkbox and radio accents switch to Green (Midnight is invisible on dark). The
  switch keeps its Midnight knob; its off-track lightens to `--nf-midnight-30`.
- Status text uses the `-fg` aliases (`--nf-danger-fg` #FF8177, `--nf-warning-fg`
  #F0B429, `--nf-success-fg` green-80) so it passes contrast on dark surfaces.
  Always use the `-fg` token for status text, never the base status colour.
- Alerts switch to dark tinted fills with lightened icons. Badges keep their light
  pastel chips with Midnight text in both themes, as do icon tiles.
- Primary buttons are unchanged. Secondary and ghost switch to White, with a subtle
  White tint on hover.

What does not change: the Green/Midnight pairing, the gradient transition family
(already dark), sentence case, and every contrast rule. The pastel backing
gradients are light-theme surfaces only; on dark pages use the transition family.

## Motion

- Default to stillness. Animate `transform` and `opacity` only. Button state changes
  transition at 200ms with `--nf-ease-soft`, easing in on hover and back out when it
  ends; inputs and the switch knob transition at 150ms; micro-animations run at 400ms
  with `--nf-ease-soft`. No scroll-reveal, no parallax, no marquees, no typing
  effects.
- The sanctioned micro-interactions, in full: the button icon slide (opt-in via
  `.nf-btn-slide`; 4px out on hover, back on hover off, 400ms), button colour and
  border transitions at 200ms, input and switch transitions at 150ms, and the button
  loading spinner. Nothing else moves.
- Focus rings appear instantly — never animated.
- `prefers-reduced-motion` is honoured globally by the stylesheet.

## Accessibility

- WCAG AA is the floor. Landmarks, one `h1`, ordered headings, skip link on full
  pages, native controls, visible focus everywhere.
- Never rely on colour alone — pair state colour with text or an icon.
- The green/white text ban above is an accessibility rule, not a taste rule.
- Grid and flex children get `min-width: 0`; image grid tracks use `minmax(0, 1fr)`.
  Verify at 320 / 375 / 414 / 768px — no horizontal scroll, no two-line buttons.

## Never ship

- Green text on white, white text on green, colours outside the palette.
- Title case or ALL CAPS anywhere; tracked uppercase eyebrows or kicker labels.
- Bold or italic headings; Bitter in body copy, nav, or UI text.
- Drop shadows, glows, glassmorphism, gradient text, or gradients beyond the two
  published families.
- Invented metrics, logos, testimonials, or client names.
- Fake browser chrome, fake phone frames, fake code-window title bars.
- Off-scale radii, per-component spacing, or hard-coded hex values that bypass tokens.
- Coloured left-border stripes on alerts, callouts, quotes, or panels — the
  side-accent pattern is banned everywhere, with no exceptions.
- Zebra-striped tables, white-on-green table headers, centred numeric columns.
- Decorative icon scatter, filled icons, mixed icon sets, emoji as UI.
- A card around everything; nested cards; borders to repair weak hierarchy.

## Quick checklist

- [ ] Sentence case everywhere, UK English, "Nearform" spelt correctly
- [ ] Inter for all UI; Bitter only in pull-quotes and table headers
- [ ] Headings weight 500, never bold or italic
- [ ] All colour via `--nf-*` tokens; no green/white text combinations
- [ ] Radius from the five-step scale; buttons, inputs, and tile backings at 8px
- [ ] No coloured left-border stripes anywhere
- [ ] Colours reference semantic aliases so the dark theme works; status text uses
  the `-fg` tokens
- [ ] Icon tiles follow the glyph-overhang maths and tone list
- [ ] At most one gradient surface per viewport, from the published families
- [ ] Tables: Green header, Midnight Bitter bold, no zebra striping
- [ ] Focus visible on everything; WCAG AA contrast throughout
- [ ] No drop shadows; whitespace and colour blocking carry the hierarchy
