/*
FNXC:ChatPresentationToggle 2026-09-16-21:57:
Operator requirement: the footer Chat entry may open as the anchored popover (popup) or as the
persistent side surface (view, dock/page per the resolved Chat host). The choice is a per-browser
presentation preference, so it persists in localStorage — never project settings — and every failure
path (private mode, quota, missing API) falls back to "popup", which is the pre-feature behavior.
*/

export type ChatLaunchMode = "popup" | "view";

const STORAGE_KEY = "fusion:chat-launch-mode";

export function readStoredChatLaunchMode(): ChatLaunchMode {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "view" ? "view" : "popup";
  } catch {
    return "popup";
  }
}

export function writeStoredChatLaunchMode(mode: ChatLaunchMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* Best-effort: an unwritable store keeps the in-memory choice for this session only. */
  }
}
