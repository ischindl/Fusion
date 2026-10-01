import { createContext, useContext } from "react";
import type { ChatLaunchMode } from "../utils/chatLaunchMode";

/*
FNXC:ChatPresentationToggle 2026-09-16-21:57:
App owns the Chat launch mode and the host-switch routine; every ChatView host (footer popover,
right-dock list, page) reaches them through this context instead of four parallel prop chains.
A null controller (mobile, or no provider) hides the toggle control entirely.
*/

export interface ChatPresentationController {
  mode: ChatLaunchMode;
  /** Persists the mode AND immediately re-presents Chat in the chosen host. */
  setMode: (mode: ChatLaunchMode) => void;
}

export const ChatPresentationContext = createContext<ChatPresentationController | null>(null);

export function useChatPresentation(): ChatPresentationController | null {
  return useContext(ChatPresentationContext);
}
