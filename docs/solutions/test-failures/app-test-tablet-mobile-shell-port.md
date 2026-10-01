---
category: test-failures
module: "@fusion/dashboard"
date: 2026-09-24
component: App.test.tsx viewport tier fixture
severity: high
problem_type: convention
applies_when:
  - "A viewport-tier change turns a previously wide tier into the mobile shell"
  - "A large App-level suite goes red in a wall of 'Unable to find an element' errors while the gate stays green"
  - "A shared readiness helper fails before any case body runs"
tags:
  - viewport-tier
  - mobile-shell
  - FN-468
  - stale-seam
  - test-maintenance
---

# Porting App.test.tsx after tablet became part of the mobile shell

## What happened

FN-468 redrew the responsive boundary: `isMobileShellMode()` returns true for `mobile` **and**
`tablet`, and `resolveNavigationSurfaces()` gates the wide shell behind
`wideShell = projectShellPresent && viewportMode === "desktop"`. The left rail, the wide footer
bar, and the right dock therefore exist **only at desktop**.

`App.test.tsx` still pinned its shared `beforeEach` to `"tablet"` while its fixture opted into
`navigationPlacement: "sidebar"`. That combination renders no primary wide surface, so the shared
readiness helper failed for every case that did not set its own tier, and roughly a third of the
file failed on missing controls rather than on broken behavior.

## The decision rule that made it tractable

For each red case, ask one question: **is the case's subject the wide placement, or the tier?**

- Subject is the wide placement (left-rail routing, footer placement, right-dock hosting) →
  **retarget the tier** to `desktop`. The assertion keeps its meaning; only the tier that can
  exhibit it changes.
- Subject is the tier itself (what navigation owns the medium screen) → **restate the assertion**
  at the new truth (the pill owns navigation; wide surfaces are absent). Never delete the leg.
- Subject is an affordance another change already removed → **restate the surviving invariant and
  name the removing change** in the comment, or delete the case with that same citation. Leaving
  it to wait for a control that no longer exists at any tier is not coverage.

Both `it.each(["tablet", "desktop"])` matrices kept both legs and branched the expected owner per
tier, each with a **positive** anchor (the pill really rendered, the wide host really rendered)
before the absence assertions, so an empty hydration can never satisfy them by accident.

## Two traps that cost the most time

**The navigation pill has no test id.** It is `nav.mobile-nav-bar` — class only — and
`mobile-drawer-trigger` does not exist in production. Six sites were waiting on
`findByTestId("mobile-nav-bar")`, which no amount of tier retargeting could fix. The shipped
anchors are `.mobile-nav-bar` (class), `mobile-nav-tab-${item}` (tabs), and `mobile-menu-trigger`
(the overflow entry when the official design is on and the gesture is off).

**The phone dismissal surface is a `FloatingWindow` drawer, not a `MobileDrawer`.** By the FN-406
invariant a mobile drawer carries no close control, so dismissal is a handle drag — and the two
presentations use different handle classes (`.mobile-drawer__handle-target` vs
`.floating-window__drawer-handle-target`). A dismissal helper that hard-codes one class silently
fails on the other. The History matrix also proved the tier predicate must be
`viewport === "mobile"`, not `viewport !== "desktop"`: tablet hosts History in a wide
`floating-window-overlay` that still has a real close button.

## Ledger: what stayed red and why

Three companions are red **at base** (`fc30c8d34e`, clean tree, identical counts) and are outside
this file's scope, so they were recorded rather than folded in:

- `app/__tests__/dashboard-footer-mobile-layout.test.ts`
- `app/components/__tests__/LeftSidebarNav.test.tsx`
- `app/components/__tests__/RightDock.test.tsx`

Six cases total. Prove-before-classifying is the habit here: `git checkout <base>`, run the ONE
file, `git checkout <branch>`. That converts "did I break it?" into owned follow-up work in one
glance, and the base SHA belongs in the commit message and the task log.

## Related

- `docs/solutions/test-failures/optional-flags-seam-hides-unconverted-column-guards.md` — same
  "guard added, fixtures left encoding the old contract" family.
- `app/__tests__/mobile-shell-breakpoint.test.tsx` and
  `app/__tests__/navigation-placement-exclusivity.test.tsx` — the suites that pin the shipped
  tier contract this port had to agree with. Trust them over the spec's prose.
