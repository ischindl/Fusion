---
category: ui-bugs
module: dashboard
tags: [escape, modal-nesting, event-order, focus-ownership, capture-phase]
problem_type: bug
applies_when: a document-level keydown listener must close exactly the topmost layer, or an owned modal defers Escape to the app-wide arbiter
---

# One Escape, one layer: capture-phase claim with focus ownership (PrCreateModal)

Related tasks: RUFU-203 (introduced the capture-phase pattern on `TaskTransferModal` and recorded this
residual risk), RUFU-205 (this fix).

## Symptom

With any overlay stacked over the Create PR sheet — including its own host, Task Detail — one `Escape`
press dismissed **both** layers and threw away the drafted PR title, body, and generated description.
The operator's framing: the window "should detect the ESC key and close only itself, not also close
the modal that launched it." Worse, the same keystroke could close an in-place confirmation **and**
discard what it was confirming, and the everyday click-a-heading-then-Escape flow closed the whole
stack through the app-wide dismissal owner.

## Root cause: three loss paths, one defect

`PrCreateModal` answered Escape from an unguarded **bubble-phase** `document` keydown listener
(`event.preventDefault(); onClose()`; no `stopPropagation()`, no ownership guard) registered whenever
`open` flipped true. Every overlay is a portal sibling under `<body>`, so all document listeners see
every keystroke. Two listeners on the same node and phase run in **registration order**, so the sheet
responded to keystrokes other handlers were aimed at:

1. **Host registered first.** Task Detail mounts Create PR and carries its own document-level
   Escape→close (`TaskDetailModal.tsx`); the host's earlier registration runs first, closes the host,
   and the draft dies with it. Create PR can never preempt an earlier bubble listener on the same node
   with `stopPropagation()` — stopping propagation is only noticed by listeners that run *after* you.
2. **The arbiter runs first and owns the page-targeted keystroke.** The app-wide Escape arbiter
   (`useDashboardKeyboardShortcuts` + `closeTopmostDashboardPopupForShortcut`) claims any Escape whose
   target is not a text field and closes the topmost popup it owns — Task Detail among them. After a
   click on Create PR's own static chrome (a heading, a pre-flight row, the body preview — none
   focusable), focus blurs to `<body>`: the Escape is page-targeted, the arbiter claims it, the host
   closes, the draft dies. A guard that deferred such "orphan" keystrokes turned the single-layer sheet
   into the prohibited un-closable sheet — the arbiter finds nothing else to close and the Escape is
   simply lost.
3. **Create PR itself over-answered.** With no guard at all, the sheet also closed on app shortcuts'
   and page shortcuts' Escapes and on keystrokes aimed at layers above it — so a Quick Chat or terminal
   behind it could no longer be closed with Escape while the sheet was open, breaking the dashboard's
   one-Escape-one-popup contract in the other direction.

## Why a target/focus-only guard is insufficient

The natural guard — "claim when the event target or `document.activeElement` is inside Create PR" — has
a hole exactly at path 2: clicking Create PR's non-focusable static content leaves
`event.target === document.body` **and** `document.activeElement === document.body`, so neither test is
true, the guard defers, and paths 2's cascade returns. This is the everyday interaction, not an edge
case. The state is only observable through **focus history**: some overlay previously had focus.

## Invariant and the one-principle claim rule

*One Escape keystroke dismisses exactly one modal layer, and it is the layer the keystroke was aimed
at.* Create PR implements exactly one claim principle:

> **Create PR answers Escape unless a different overlay owns the keystroke.**

Ownership is decided from DOM facts only — never registration order, never z-index (CSS paint bands
page/floating/modal do not match the arbiter's dismissal priority, and CSS stacking does not participate
in DOM event propagation at all):

1. `event.defaultPrevented` → defer (a page/app shortcut or upper layer already consumed it);
2. event target **or** `document.activeElement` inside a floating window / dialog / modal overlay
   outside Create PR's own portal subtree → defer (a different overlay owns it);
3. target **or** current focus inside Create PR's own subtree → claim;
4. otherwise (target and focus are outside every overlay — a blur to `<body>`, a removed focused
   control, or a keystroke aimed at the live page behind the non-blocking shell) → claim exactly while
   Create PR's overlay was the **most recently focused** one, tracked by one capture-phase `focusin`
   listener (the idiom already used by `ExecutorStatusBar.tsx:211`, `ChatView.tsx:1738`,
   `InlineCreateCard.tsx:368`; `blur()` never fires `focusin`, so a blur to `<body>` preserves the
   last real ownership verdict instead of erasing it).

Claimed keystrokes: `preventDefault(); stopPropagation(); onClose()`. Deferred keystrokes are left
byte-identical — no `preventDefault`, no `stopPropagation` — so hosts, sibling modals, and app/page
Escape shortcuts keep working. The claim listener registers **capture** on `document` (it must be able
to precede the host's earlier bubble listener — the phase, not a registry, buys the ordering), while
the Tab trap remains byte-identical on its original bubble listener, and the `focusin` tracker is
capture-phase so it observes focus moves into *any* subtree before consumers act.

### Residual limitation (documented, not papered over)

Focus blurred to `<body>` from another surface's *non-focusable static chrome*, without ever reaching a
focusable control inside that overlay, leaves ownership with Create PR — no `focusin` ever fired to
learn otherwise. Covering that would require a global last-interaction registry, which this task's
"no parallel modal-stack registry" constraint forbids.

## The two listener-leak traps

- **Capture flag symmetry.** `removeEventListener` matches on the exact capture flag. A capture listener
  removed without `true` is never removed; a leaked capture Escape handler keeps dismissing the sheet
  after it closes. Registration and removal must both pass `true` for the Escape claim and the `focusin`
  tracker, and both omit it for the bubble Tab trap.
- **Mixed-flag listeners.** A listener registered on `document` in one phase and cleaned up assuming the
  other (or cleaned up in a different effect than it was added) leaks silently in every browser — jsdom
  included. `PrCreateModal.escape.test.tsx` pins this behaviorally: it wraps `addEventListener`/
  `removeEventListener`, records each `(type, capture)` shape, and asserts the added and removed shapes
  match one-for-one after open→close.

## jsdom repro idiom

The reproduction cannot rely on a real browser's click-focus or blur model:

- jsdom `focus()`/`blur()` **do** synthesize `focusin`/`focusout`, so the ownership tracker is testable;
  **`blur()` sets `document.activeElement = body` without any focus event** — exactly the orphan state,
  and it proves blurs never rewrite the last `focusin` verdict.
- `fireEvent.click()` does **not** move focus the way a browser click does — explicitly
  `opener.focus()` before firing the click when a test needs focus-restoration targets, and explicitly
  `blur()` when it needs the click-blurred-to-page state.
- A keystroke "aimed at the page" is a `fireEvent.keyDown(document.body, { key: "Escape" })` (or on the
  page element); a document-targeted keystroke (`keyDown(document, …)`) exercises the registration-order
  hazard zone — document-node listeners run in registration order regardless of capture flag — which is
  why capture-phase + ownership must be tested there too.
- Build stacks from **real components plus your own document-level recorders**; never mock the inner
  layer. Assert `onClose` call counts (one per press), overlay presence via
  `data-testid="floating-window-overlay-{windowKey}"`, and that a deferred event was never
  `preventDefault`-ed (`fireEvent` returns `!defaultPrevented`).

## Guard snippet (behavior summary)

```tsx
const ownsEscapeKeystroke = (event: KeyboardEvent) => {
  if (event.defaultPrevented) return false;                                  // consumed already
  if (isInsideForeignOverlay(event.target) || isInsideForeignOverlay(document.activeElement)) return false;
  if (isInsideSelf(event.target) || isInsideSelf(document.activeElement)) return true;
  return lastFocusedOverlayWasSelfRef.current;                               // orphan → last overlay focused wins
};
// add: keydown(capture) claim · focusin(capture) tracker · Tab trap (bubble, unchanged)
// remove: same flags, same effect cleanup — leaks are the trap
document.addEventListener("keydown", handleEscape, true);
document.addEventListener("focusin", handleFocusIn, true);
```

`isInsideSelf` is containment inside the component's own overlay root; `isInsideForeignOverlay` is
`closest(".floating-window-overlay, .floating-window, .modal, .modal-overlay")` outside it
(`.modal-backdrop` does not exist as a generic class in this codebase). The tracker initializes to
`true` and re-initializes on open: opening a modal is itself an ownership act even when no `focusin`
lands.

## Premise-drift note

The spec's surface table claimed an in-place `ConfirmDialog` child (mounted via `confirmOverlayRef`)
inside Create PR; at execution HEAD none exists (no `ConfirmDialog`/`confirmOverlayRef`/`useConfirm`
anywhere in the file), and Create PR mounts no child overlay at all. The nested stack was therefore
reproduced with the **real host** (`TaskDetailModal`) plus independent document-level recorders, and
the in-place-dialog rule is covered by the foreign-overlay defer tests. Genuine affected siblings found
by the audit (`ConfirmDialog.tsx` bubble Escape without `stopPropagation`, the Task Detail host listener
without a `defaultPrevented` check, `NewTaskModal.tsx` over hosted blocking child dialogs) were filed as
follow-ups, not edited in this task.
