import { useEffect, useRef, useState } from "react";
import {
  ZOOMED_SCALE_THRESHOLD,
  isKeyboardEditableElement,
} from "../utils/mobileKeyboardViewport";

/*
FNXC:MobileKeyboardViewport 2026-09-17-14:23:
FN-512 makes this hook share the canonical editable predicate and zoom threshold with keyboard
detection, so a non-text control can never hide mobile chrome and the two cannot drift apart.

It deliberately keeps its OWN direct listeners rather than subscribing to the shared frame: this
flag must release the instant focus leaves an editor, and a blur frequently changes no geometry at
all. A frame-change subscription would be deduplicated away and leave mobile chrome stuck
keyboard-up for the whole dismissal animation.
*/

/**
 * Reports the focus transition that precedes a settled visual-viewport keyboard sample.
 * Released immediately on blur so composers and the executor footer are never stuck keyboard-up.
 */
export function useKeyboardFocusPending(enabled: boolean, keyboardOpen = false): boolean {
  const [pending, setPending] = useState(false);
  const keyboardOpenRef = useRef(keyboardOpen);
  const acknowledgedFocusRef = useRef(false);
  keyboardOpenRef.current = keyboardOpen;

  useEffect(() => {
    if (keyboardOpen) {
      acknowledgedFocusRef.current = true;
      setPending(false);
    }
  }, [keyboardOpen]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      acknowledgedFocusRef.current = false;
      setPending(false);
      return;
    }

    const clear = () => {
      acknowledgedFocusRef.current = false;
      setPending(false);
    };
    const beginFocusTransition = () => {
      const scale = window.visualViewport?.scale ?? 1;
      if (scale > ZOOMED_SCALE_THRESHOLD || !isKeyboardEditableElement(document.activeElement)) {
        clear();
        return;
      }

      if (keyboardOpenRef.current) {
        acknowledgedFocusRef.current = true;
        setPending(false);
        return;
      }

      acknowledgedFocusRef.current = false;
      setPending(true);
    };
    const updateViewport = () => {
      const scale = window.visualViewport?.scale ?? 1;
      if (scale > ZOOMED_SCALE_THRESHOLD || !isKeyboardEditableElement(document.activeElement)) {
        clear();
        return;
      }

      if (keyboardOpenRef.current || acknowledgedFocusRef.current) {
        setPending(false);
      }
    };

    const viewport = window.visualViewport;
    window.addEventListener("focusin", beginFocusTransition);
    window.addEventListener("focusout", clear);
    viewport?.addEventListener("resize", updateViewport);
    viewport?.addEventListener("scroll", updateViewport);
    beginFocusTransition();

    return () => {
      window.removeEventListener("focusin", beginFocusTransition);
      window.removeEventListener("focusout", clear);
      viewport?.removeEventListener("resize", updateViewport);
      viewport?.removeEventListener("scroll", updateViewport);
      setPending(false);
    };
  }, [enabled]);

  /*
  FNXC:ViewportChrome 2026-10-01-05:33:
  Focus can hide mobile chrome only until measured keyboard state acknowledges the opening. iOS can retain textarea focus after dismissal, so a closing VisualViewport event must not recreate pending state or keep navigation off-screen.

  FNXC:MobileKeyboardViewport 2026-10-01-15:14:
  Merge of upstream FN-9444 into FN-512: the acknowledgement state machine above is upstream's,
  the predicate and zoom bound stay shared. A local copy of the editable predicate or a bare 1.01
  literal here would re-open the drift FN-512 closed, so both sides of the merge keep ONE source.
  */
  return pending;
}
