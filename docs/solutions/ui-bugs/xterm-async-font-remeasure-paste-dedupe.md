---
title: "xterm async font remeasure and native paste"
date: 2026-06-13
category: ui-bugs
module: packages/dashboard/app/components/TerminalModal
problem_type: ui_bug
component: frontend_terminal
applies_when: "An xterm.js terminal opens before its web font finishes loading, or a custom paste shortcut competes with xterm's helper textarea paste path."
symptoms:
  - "Terminal glyphs render with oversized inter-character spacing after a font-display: swap web font loads"
  - "Cmd/Ctrl+V paste sends the same payload to the PTY twice"
root_cause: xterm_opened_with_fallback_font_metrics_and_duplicate_clipboard_delivery
resolution_type: code_fix
severity: high
related_components:
  - packages/dashboard/app/components/TerminalModal.tsx
  - packages/dashboard/app/components/SessionTerminal.tsx
  - packages/dashboard/app/components/__tests__/TerminalModal.test.tsx
  - packages/dashboard/app/components/__tests__/SessionTerminal.test.tsx
  - FN-6390
tags:
  - xterm
  - font-loading
  - font-display-swap
  - clipboard
  - paste
  - mobile-safari
---

# xterm async font remeasure and native paste

## Problem

xterm.js measures character-cell geometry when `terminal.open()` runs. If a custom web font is declared with `font-display: swap`, a cold load can let xterm cache fallback-font metrics and then swap to the real font later. The renderer may keep the stale cell width, producing widely spaced glyphs on mobile/DOM-renderer surfaces.

A second pitfall is custom paste handling. If an `attachCustomKeyEventHandler` Cmd/Ctrl+V branch reads `navigator.clipboard.readText()` and forwards that text to the PTY while the browser also performs the native paste into xterm's helper textarea, the same payload reaches `terminal.onData` and is sent twice.

## Solution

Keep one canonical paste path and remeasure after font resolution.

- Prefer xterm's native helper-textarea paste for Cmd/Ctrl+V; return `true` from the custom key handler so the browser/xterm path runs, and do not read/send clipboard text manually.
- Preserve custom copy behavior only for selected text, where suppressing terminal input is intentional.
- After `terminal.open()`, call `document.fonts.load()` for the terminal font stack and await `document.fonts.ready` when the FontFaceSet API exists.
- Guard async remeasure work with the expected session id and current terminal/addon refs so stale font-load promises cannot mutate a disposed or switched terminal.
- Reapply font options, run `fitAddon.fit()`, publish the resized cols/rows, and refresh visible rows once the web font has resolved.

`SessionTerminal` is unaffected by the custom-font symptom because it uses a system monospace stack, and unaffected by paste duplication because it does not install a custom paste handler; native xterm paste is its only input path.

## Regression coverage

Cover the invariant across terminal surfaces and input paths:

- Keyboard paste on macOS (`metaKey`) and non-mac (`ctrlKey`) returns `true`, does not call `clipboard.readText()`, and sends exactly one PTY input frame via xterm `onData`.
- Native helper-textarea paste without the shortcut handler sends exactly once, covering mobile/iOS context-menu paste.
- A controlled `document.fonts.load()` promise resolving after `terminal.open()` triggers a post-font-load fit, resize, and refresh.
- `SessionTerminal` asserts it uses the system monospace stack, does not attach a custom key handler, and sends one native xterm paste input frame.

This avoids downstream byte de-duplication and fixes the two root causes at their renderer/input seams.
