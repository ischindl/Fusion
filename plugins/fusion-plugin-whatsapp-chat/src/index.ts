import { createHmac, timingSafeEqual } from "node:crypto";
import { definePlugin } from "@fusion/plugin-sdk";
import type { FusionPlugin, PluginContext, PluginRouteDefinition, PluginRouteResponse, PluginSettingSchema } from "@fusion/plugin-sdk";

const MAX_WHATSAPP_MESSAGE_CHARS = 4096;

const settingsSchema: Record<string, PluginSettingSchema> = {
  verifyToken: { type: "password", label: "Verify Token", required: true },
  appSecret: { type: "password", label: "App Secret", required: true },
  accessToken: { type: "password", label: "Access Token", required: true },
  phoneNumberId: { type: "string", label: "Phone Number ID", required: true },
  graphApiVersion: { type: "string", label: "Graph API Version", defaultValue: "v21.0" },
  allowedSenders: { type: "array", label: "Allowed WhatsApp Senders", itemType: "string" },
  agentSystemPrompt: { type: "string", label: "Agent System Prompt", multiline: true, defaultValue: "You are a helpful assistant replying in WhatsApp chats." },
};

type ChatTurn = { role: "user" | "assistant"; text: string; createdAt: string };

type PluginDb = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    run(...args: unknown[]): unknown;
  };
};

type IncomingMessage = { id: string; from: string; text: string };

type PluginRequest = {
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: Buffer;
};

function getSettingString(settings: Record<string, unknown>, key: string): string | undefined {
  const value = settings[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getAllowedSenders(settings: Record<string, unknown>): Set<string> {
  const senders = settings.allowedSenders;
  if (!Array.isArray(senders)) return new Set<string>();
  return new Set(senders.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()));
}

function splitMessageForWhatsapp(text: string): string[] {
  if (text.length <= MAX_WHATSAPP_MESSAGE_CHARS) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_WHATSAPP_MESSAGE_CHARS) {
      chunks.push(remaining);
      break;
    }
    const candidate = remaining.slice(0, MAX_WHATSAPP_MESSAGE_CHARS);
    const splitAt = Math.max(candidate.lastIndexOf("\n"), candidate.lastIndexOf(" "));
    const breakpoint = splitAt > 0 ? splitAt : MAX_WHATSAPP_MESSAGE_CHARS;
    chunks.push(remaining.slice(0, breakpoint).trim());
    remaining = remaining.slice(breakpoint).trimStart();
  }
  return chunks.filter(Boolean);
}

function verifyMetaSignature(rawBody: Buffer, signatureHeader: string | undefined, appSecret: string): boolean {
  if (!signatureHeader?.startsWith("sha256=")) {
    return false;
  }

  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const provided = signatureHeader.slice("sha256=".length);
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(provided, "hex");
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, providedBuf);
}

function extractIncomingMessages(payload: unknown): IncomingMessage[] {
  const body = payload as {
    entry?: Array<{ changes?: Array<{ value?: { messages?: Array<{ id?: string; from?: string; text?: { body?: string }; type?: string }> } }> }>;
  };

  const messages: IncomingMessage[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value?.messages ?? []) {
        if (message.type !== "text") continue;
        if (!message.id || !message.from || !message.text?.body?.trim()) continue;
        messages.push({ id: message.id, from: message.from, text: message.text.body.trim() });
      }
    }
  }
  return messages;
}

function ensureSchema(db: PluginDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_chat_sessions (
      sender TEXT PRIMARY KEY,
      history TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS whatsapp_chat_dedupe (
      messageId TEXT PRIMARY KEY,
      sender TEXT NOT NULL,
      receivedAt TEXT NOT NULL
    );
  `);
}

function loadHistory(db: PluginDb, sender: string): ChatTurn[] {
  const row = db.prepare("SELECT history FROM whatsapp_chat_sessions WHERE sender = ?").get(sender) as { history: string } | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.history) as ChatTurn[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveHistory(db: PluginDb, sender: string, history: ChatTurn[]): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO whatsapp_chat_sessions(sender, history, updatedAt)
    VALUES(?, ?, ?)
    ON CONFLICT(sender) DO UPDATE SET history = excluded.history, updatedAt = excluded.updatedAt
  `).run(sender, JSON.stringify(history), now);
}

function wasProcessed(db: PluginDb, messageId: string): boolean {
  const row = db.prepare("SELECT 1 as found FROM whatsapp_chat_dedupe WHERE messageId = ?").get(messageId) as { found: number } | undefined;
  return Boolean(row?.found);
}

function markProcessed(db: PluginDb, messageId: string, sender: string): void {
  db.prepare("INSERT INTO whatsapp_chat_dedupe(messageId, sender, receivedAt) VALUES(?, ?, ?)").run(messageId, sender, new Date().toISOString());
}

async function sendWhatsappText(ctx: PluginContext, to: string, text: string): Promise<void> {
  const accessToken = getSettingString(ctx.settings, "accessToken");
  const phoneNumberId = getSettingString(ctx.settings, "phoneNumberId");
  const graphApiVersion = getSettingString(ctx.settings, "graphApiVersion") ?? "v21.0";
  if (!accessToken || !phoneNumberId) {
    throw new Error("WhatsApp plugin missing accessToken or phoneNumberId settings");
  }

  for (const chunk of splitMessageForWhatsapp(text)) {
    const response = await fetch(`https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: chunk },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`WhatsApp Graph API request failed (${response.status}): ${errorText}`);
    }
  }
}

async function generateReply(ctx: PluginContext, sender: string, text: string, history: ChatTurn[]): Promise<string> {
  if (!ctx.createAiSession) {
    throw new Error("AI session factory unavailable: engine not registered");
  }

  const systemPrompt = getSettingString(ctx.settings, "agentSystemPrompt") ?? "You are a helpful assistant replying in WhatsApp chats.";
  const sessionResult = await ctx.createAiSession({
    cwd: ctx.taskStore.getRootDir(),
    systemPrompt,
    tools: "readonly",
  });

  const promptLines = [
    "Continue this WhatsApp conversation.",
    ...history.map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text}`),
    `User: ${text}`,
    "Assistant:",
  ];

  await sessionResult.session.prompt(promptLines.join("\n"));
  const assistantMessages = sessionResult.session.state.messages.filter((message) => message.role === "assistant");
  const latest = assistantMessages[assistantMessages.length - 1];
  const content = latest?.content;
  if (typeof content === "string" && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const textParts = content
      .map((part) => (part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string") ? (part as { text: string }).text : "")
      .filter(Boolean);
    if (textParts.length > 0) return textParts.join("\n").trim();
  }

  throw new Error("AI session returned no assistant text");
}

async function getDbFromTaskStore(ctx: PluginContext): Promise<PluginDb> {
  const pluginStore = ctx.taskStore.getPluginStore();
  const db = (pluginStore as unknown as { db?: PluginDb }).db;
  if (!db) {
    throw new Error("Plugin database unavailable");
  }
  return db;
}

async function webhookGetHandler(req: PluginRequest, ctx: PluginContext): Promise<PluginRouteResponse> {
  const verifyToken = getSettingString(ctx.settings, "verifyToken");
  const mode = req.query?.["hub.mode"];
  const challenge = req.query?.["hub.challenge"];
  const token = req.query?.["hub.verify_token"];

  if (mode === "subscribe" && verifyToken && token === verifyToken && typeof challenge === "string") {
    return { status: 200, body: challenge };
  }

  return { status: 403, body: { error: "Verification failed" } };
}

async function webhookPostHandler(req: PluginRequest, ctx: PluginContext): Promise<PluginRouteResponse> {
  const appSecret = getSettingString(ctx.settings, "appSecret");
  if (!appSecret) {
    return { status: 500, body: { error: "appSecret is not configured" } };
  }

  const signatureHeader = (req.headers?.["x-hub-signature-256"] ?? req.headers?.["X-Hub-Signature-256"]) as string | undefined;
  if (!req.rawBody || !verifyMetaSignature(req.rawBody, signatureHeader, appSecret)) {
    return { status: 401, body: { error: "Invalid webhook signature" } };
  }

  const db = await getDbFromTaskStore(ctx);
  const allowedSenders = getAllowedSenders(ctx.settings);
  const inboundMessages = extractIncomingMessages(req.body);

  for (const inbound of inboundMessages) {
    if (wasProcessed(db, inbound.id)) {
      continue;
    }
    markProcessed(db, inbound.id, inbound.from);

    if (allowedSenders.size > 0 && !allowedSenders.has(inbound.from)) {
      continue;
    }

    try {
      const history = loadHistory(db, inbound.from);
      const reply = await generateReply(ctx, inbound.from, inbound.text, history);
      const now = new Date().toISOString();
      const nextHistory: ChatTurn[] = [
        ...history,
        { role: "user" as const, text: inbound.text, createdAt: now },
        { role: "assistant" as const, text: reply, createdAt: now },
      ].slice(-40);
      saveHistory(db, inbound.from, nextHistory);
      await sendWhatsappText(ctx, inbound.from, reply);
    } catch (error) {
      ctx.logger.error("WhatsApp chat processing failed", error);
      await sendWhatsappText(ctx, inbound.from, "Sorry, I hit an internal error while processing that message.");
    }
  }

  return { status: 200, body: { processed: inboundMessages.length } };
}

const routes: PluginRouteDefinition[] = [
  { method: "GET", path: "/webhook", handler: webhookGetHandler as unknown as PluginRouteDefinition["handler"] },
  { method: "POST", path: "/webhook", handler: webhookPostHandler as unknown as PluginRouteDefinition["handler"] },
];

const plugin: FusionPlugin = definePlugin({
  manifest: {
    id: "fusion-plugin-whatsapp-chat",
    name: "WhatsApp Chat",
    version: "0.1.0",
    description: "Bridge WhatsApp Cloud webhook messages to a Fusion agent conversation",
    author: "Fusion Team",
    settingsSchema,
  },
  state: "installed",
  routes,
  hooks: {
    onSchemaInit: (db) => {
      ensureSchema(db);
    },
  },
});

export default plugin;
export {
  extractIncomingMessages,
  generateReply,
  splitMessageForWhatsapp,
  verifyMetaSignature,
  webhookGetHandler,
  webhookPostHandler,
};
