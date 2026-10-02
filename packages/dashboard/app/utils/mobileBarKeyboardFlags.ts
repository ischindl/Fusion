/*
FNXC:MobilePillKeyboard 2026-09-13-09:32:
Android Chrome can resize the document layout viewport before refreshing `window.innerHeight`. Keyboard detection and mobile-pill placement must read this shared document-first height so a stale window metric cannot lift the pill above an already reduced viewport.
*/
export function getMobileKeyboardLayoutViewportHeight(): number {
  if (typeof window === "undefined") return 0;
  if (typeof document === "undefined") return window.innerHeight;
  return document.documentElement?.clientHeight || window.innerHeight;
}

export interface MobileBarKeyboardFlagsInput {
  isMobile: boolean;
  keyboardOpen: boolean;
  keyboardFocusPending: boolean;
  /** True until the visual viewport has proven that navigation no longer needs keyboard placement. */
  navigationViewportActive: boolean;
  anyModalOpen: boolean;
  /** True when a fullscreen mobile overlay owns keyboard/viewport layout. */
  overlayOpen: boolean;
}

export interface MobileBarKeyboardFlags {
  footerHidden: boolean;
  navKeyboardOpen: boolean;
  footerKeyboardOpen: boolean;
}

/*
FNXC:MobileChatKeyboardLayout 2026-06-26-09:04:
While the soft keyboard is up on mobile, the dashboard must NOT show the executor footer (task counts / Running indicator) and must NOT leave dead space above the keyboard. `footerHidden` drives both: it returns the ExecutorStatusBar null AND drops `.project-content`'s reserved footer+nav padding-bottom, letting the composer sit directly above the keyboard.

This applies to BOTH iOS and Android. Previously `footerHidden` was iOS-only (FN-5707): on Android `interactive-widget=resizes-content` shrinks the layout viewport, so the footer's stacked bottom position was technically "correct" while its reserved stack still rendered as an empty gap. Matching iOS removes both the footer and the gap on Android without hiding the official navigation pill.

Footer and nav reservations now follow the same focus signal so an unsettled keyboard sample cannot leave invisible navigation space under the composer.

FNXC:MobileChatKeyboardLayout 2026-09-01-05:36:
The footer bottom reservation is only correct while the nav bar is on screen. Use the nav bar's unsettled-tolerant trigger for the footer collapse on both platforms; otherwise a rendered footer rises with an empty mobile-nav-height and safe-area band beneath it.

Fullscreen mobile drawers own their own visual viewport handling. Treat them like modals for board-layout padding so drawer-local keyboards never shift the underlying board.
*/
export function computeMobileBarKeyboardFlags({
  isMobile,
  keyboardOpen,
  keyboardFocusPending,
  navigationViewportActive,
  anyModalOpen,
  overlayOpen,
}: MobileBarKeyboardFlagsInput): MobileBarKeyboardFlags {
  /*
  FNXC:MobilePillKeyboard 2026-09-13-09:10:
  Keyboard focus still collapses the executor footer immediately, but the official pill remains mounted and interactive. `navKeyboardOpen` now marks the period in which its visual-viewport lift may apply; it no longer authorizes an off-screen transform.

  FNXC:MobilePillKeyboard 2026-09-13-11:20:
  Menu focus ends the input-owned keyboard interaction before iOS finishes restoring its visual viewport. Keep only navigation in keyboard-placement mode for that closing interval; footer visibility and reservation remain tied to the immediate focus-owned signals.
  */

  /* FNXC:MobileChatKeyboardLayout 2026-09-01-05:36 (superseded 2026-09-13-09:10): upstream later tied
  footerHidden to the unsettled nav trigger so both bars release space together; this line keeps the
  footer on the immediate focus signal because a rendered footer must not inherit the visual-viewport
  dismissal tail (see formulas below). */
  /*
  FNXC:MobilePillKeyboard 2026-10-01-15:15:
  The footer must release its space on the SAME immediate focus signal as its reservation, so `footerHidden` keeps `keyboardFocusPending` and deliberately excludes `navigationViewportActive`: a rendered footer must not inherit the visual-viewport dismissal tail. FN-374 narrowed `footerHidden` to `keyboardOpen` alone, which left the footer and its reserved padding visible through the whole focus transition while `footerKeyboardOpen` already claimed the space — the red `collapses the footer as soon as mobile keyboard focus is pending` case. Upstream FN-9444 makes that pending flag expire after one focus transition, so honouring it can no longer keep chrome hidden on a stale focus sample.
  */
  const boardLayoutSuppressed = anyModalOpen || overlayOpen;
  const footerHidden = isMobile && (keyboardOpen || keyboardFocusPending) && !boardLayoutSuppressed;
  const navKeyboardOpen = isMobile && (keyboardOpen || keyboardFocusPending || navigationViewportActive);
  const footerKeyboardOpen = isMobile && (keyboardOpen || keyboardFocusPending);

  return {
    footerHidden,
    navKeyboardOpen,
    footerKeyboardOpen,
  };
}
