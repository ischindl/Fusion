import { PanelRight, PictureInPicture2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ChatLaunchMode } from "../utils/chatLaunchMode";
import { UiButton } from "./ui";
import "./ChatPresentationToggle.css";

/*
FNXC:ChatPresentationToggle 2026-09-16-21:57:
Operator requirement: chat may sit next to the terminal as a view, but the operator must be able to
choose per browser whether the Chat entry opens the anchored popover (popup) or the persistent side
surface (view). Clicking a segment persists the launch preference AND immediately re-presents Chat in
that host, so the control is both a preference and an instant switch. The active segment is
aria-pressed; both segments are always present (no hidden current state).
*/

export interface ChatPresentationToggleProps {
  mode: ChatLaunchMode;
  onModeChange: (mode: ChatLaunchMode) => void;
}

export function ChatPresentationToggle({ mode, onModeChange }: ChatPresentationToggleProps) {
  const { t } = useTranslation("app");
  return (
    <div
      className="chat-presentation-toggle"
      role="group"
      aria-label={t("chat.presentationModeGroup", "Chat display mode")}
      data-testid="chat-presentation-toggle"
    >
      <UiButton
        type="button"
        className={`btn-icon chat-presentation-toggle__btn${mode === "popup" ? " chat-presentation-toggle__btn--active" : ""}`}
        onClick={() => onModeChange("popup")}
        aria-pressed={mode === "popup"}
        aria-label={t("chat.presentationModePopup", "Open chat as popup")}
        title={t("chat.presentationModePopup", "Open chat as popup")}
        data-testid="chat-presentation-popup"
      >
        <PictureInPicture2 size={16} />
      </UiButton>
      <UiButton
        type="button"
        className={`btn-icon chat-presentation-toggle__btn${mode === "view" ? " chat-presentation-toggle__btn--active" : ""}`}
        onClick={() => onModeChange("view")}
        aria-pressed={mode === "view"}
        aria-label={t("chat.presentationModeView", "Open chat as view")}
        title={t("chat.presentationModeView", "Open chat as view")}
        data-testid="chat-presentation-view"
      >
        <PanelRight size={16} />
      </UiButton>
    </div>
  );
}
