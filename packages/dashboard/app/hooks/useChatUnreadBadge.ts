/*
FNXC:ChatBadge 2026-06-24-00:00:
Header/mobile-nav unread indicator for assistant chat responses. Set when an assistant message arrives over SSE while the user is not viewing chat, and cleared when the chat view (or quick-chat window) opens. Extracted verbatim from AppInner.

FNXC:ChatBadge 2026-07-01-00:00:
Task-detail planner chats use synthetic `task-planner:<taskId>` direct sessions that are hidden from the common Chat feed unless the project explicitly opts them back in. Ignore planner assistant events only while the SSE visibility metadata says that planner session is absent from global Chat, so opt-in shared-feed projects still get normal unread badges.
*/

import { useEffect, useState } from "react";
import type { ChatRoomMessage } from "@fusion/core";
import { subscribeSse } from "../sse-bus";
import type { TaskView } from "./useViewState";

const TASK_PLANNER_CHAT_AGENT_ID_PREFIX = "task-planner:";

type ChatMessageAddedPayload = {
  role?: string;
  projectId?: string | null;
  agentId?: string | null;
  session?: { agentId?: string | null } | null;
  chatSession?: { agentId?: string | null } | null;
  taskChatVisibleInCommonFeed?: boolean | null;
};

function isTaskPlannerChatMessage(payload: ChatMessageAddedPayload): boolean {
  const candidateAgentIds = [
    payload.agentId,
    payload.session?.agentId,
    payload.chatSession?.agentId,
  ];
  return candidateAgentIds.some(
    (agentId) => typeof agentId === "string" && agentId.startsWith(TASK_PLANNER_CHAT_AGENT_ID_PREFIX),
  );
}

function isHiddenTaskPlannerChatMessage(payload: ChatMessageAddedPayload): boolean {
  return isTaskPlannerChatMessage(payload) && payload.taskChatVisibleInCommonFeed !== true;
}

export interface UseChatUnreadBadgeOptions {
  taskView: TaskView;
  quickChatOpen: boolean;
}

export interface UseChatUnreadBadgeResult {
  chatHasUnreadResponse: boolean;
}

export function useChatUnreadBadge(
  currentProjectId: string | undefined,
  { taskView, quickChatOpen }: UseChatUnreadBadgeOptions,
): UseChatUnreadBadgeResult {
  const [chatHasUnreadResponse, setChatHasUnreadResponse] = useState(false);

  useEffect(() => {
    if (taskView === "chat" || quickChatOpen) {
      setChatHasUnreadResponse(false);
    }
  }, [quickChatOpen, taskView]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (currentProjectId) {
      params.set("projectId", currentProjectId);
    }
    const query = params.size > 0 ? `?${params.toString()}` : "";

    return subscribeSse(`/api/events${query}`, {
      events: {
        "chat:message:added": (event: MessageEvent) => {
          try {
            const payload = JSON.parse(event.data) as ChatMessageAddedPayload;
            if (payload.role !== "assistant") return;
            if (isHiddenTaskPlannerChatMessage(payload)) return;
            if (taskView === "chat" || quickChatOpen) return;
            if (payload.projectId && currentProjectId && payload.projectId !== currentProjectId) return;
            setChatHasUnreadResponse(true);
          } catch {
            // no-op
          }
        },
        "chat:room:message:added": (event: MessageEvent) => {
          try {
            const payload = JSON.parse(event.data) as ChatRoomMessage & { projectId?: string | null };
            if (payload.role === "user") return;
            if (taskView === "chat" || quickChatOpen) return;
            if (payload.projectId && currentProjectId && payload.projectId !== currentProjectId) return;
            setChatHasUnreadResponse(true);
          } catch {
            // no-op
          }
        },
      },
    });
  }, [currentProjectId, quickChatOpen, taskView]);

  return { chatHasUnreadResponse };
}
