import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Database, MessageStore, TaskStore } from "@fusion/core";
import { NotificationService } from "../notification/notification-service.js";

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), "fn-msg-notify-pipeline-"));
}

describe("message notification pipeline integration", () => {
  let rootDir: string;
  let taskStore: TaskStore;
  let messageDb: Database;
  let messageStore: MessageStore;
  let service: NotificationService;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    rootDir = makeTempRoot();
    taskStore = new TaskStore(rootDir, undefined, { inMemoryDb: true });
    await taskStore.init();

    messageDb = new Database(join(rootDir, ".fusion"), { inMemory: true });
    messageDb.init();
    messageStore = new MessageStore(messageDb);

    fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    service = new NotificationService(taskStore, { messageStore });
    await service.start();
  });

  afterEach(async () => {
    await service.stop();
    vi.unstubAllGlobals();
    messageDb.close();
    taskStore.close();
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("sends and suppresses agent-to-agent notifications according to runtime ntfy settings", async () => {
    await taskStore.updateGlobalSettings({
      ntfyEnabled: true,
      ntfyTopic: "test-topic",
      ntfyEvents: ["message:agent-to-user", "message:agent-to-agent"],
    });

    messageStore.sendMessage({
      fromId: "agent-A",
      fromType: "agent",
      toId: "agent-B",
      toType: "agent",
      content: "hi from agent A",
      type: "agent-to-agent",
    });

    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://ntfy.sh/");
    const firstOptions = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const firstHeaders = firstOptions.headers as Record<string, string>;
    expect(firstHeaders["Content-Type"]).toBe("application/json");
    const firstPayload = JSON.parse(String(firstOptions.body)) as { title: string; message: string; topic: string };
    expect(firstPayload.topic).toBe("test-topic");
    expect(firstPayload.title).toBe("agent-A → agent-B");
    expect(firstPayload.message).toContain("agent-A messaged agent-B: hi from agent A");

    messageStore.sendMessage({
      fromId: "agent-A",
      fromType: "agent",
      toId: "agent-B",
      toType: "agent",
      content: "reply preview",
      type: "agent-to-agent",
      metadata: { replyTo: { messageId: "msg-origin" } },
    });

    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
    expect(fetchSpy.mock.calls[1]?.[0]).toBe("https://ntfy.sh/test-topic");
    const replyRequest = fetchSpy.mock.calls[1]?.[1] as RequestInit;
    const replyHeaders = replyRequest.headers as Record<string, string>;
    expect(replyHeaders.Title).toBe("Re: reply preview");
    expect(String(replyRequest.body)).toContain("agent-A messaged agent-B: reply preview");

    await taskStore.updateGlobalSettings({ ntfyEvents: ["message:agent-to-user"] });

    messageStore.sendMessage({
      fromId: "agent-A",
      fromType: "agent",
      toId: "agent-B",
      toType: "agent",
      content: "should be filtered",
      type: "agent-to-agent",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await taskStore.updateGlobalSettings({ ntfyEvents: ["message:agent-to-user", "message:agent-to-agent"] });

    messageStore.sendMessage({
      fromId: "agent-A",
      fromType: "agent",
      toId: "agent-B",
      toType: "agent",
      content: "enabled again",
      type: "agent-to-agent",
    });

    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    await taskStore.updateGlobalSettings({ ntfyEnabled: false });

    messageStore.sendMessage({
      fromId: "agent-A",
      fromType: "agent",
      toId: "agent-B",
      toType: "agent",
      content: "disabled should suppress",
      type: "agent-to-agent",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("keeps agent-to-user notifications working", async () => {
    await taskStore.updateGlobalSettings({
      ntfyEnabled: true,
      ntfyTopic: "test-topic",
      ntfyEvents: ["message:agent-to-user", "message:agent-to-agent"],
    });

    messageStore.sendMessage({
      fromId: "agent-A",
      fromType: "agent",
      toId: "user-1",
      toType: "user",
      content: "hello user",
      type: "agent-to-user",
    });

    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://ntfy.sh/");
    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const headers = request.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    const payload = JSON.parse(String(request.body)) as { title: string; message: string; topic: string };
    expect(payload.topic).toBe("test-topic");
    expect(payload.title).toBe("New message from agent-A");
    expect(payload.message).toContain("agent-A → you: hello user");
  });
});
