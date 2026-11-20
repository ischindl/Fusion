/**
 * FNXC:TelegramBridge 2026-11-20-02:49 (RUFU-782):
 * Every Telegram event the bridge has seen is attributed to a project, and two operators' instincts both
 * need that record: "which projects has this bridge actually talked to" (status) and "should this project
 * get its own topic" (the multi-project argument for Topics over one shared chat). This registry is that
 * record — an in-process view built from accepted ingest events, never a second source of truth about
 * delivery.
 *
 * It is deliberately not the delivery queue: a registry entry proves an event arrived, not that a Telegram
 * message was sent.
 */

export interface ProjectBinding {
  projectId: string;
  projectName?: string;
  firstSeenAt: number;
  lastEventAt: number;
  eventCount: number;
  /** Last thread this project's events were delivered into; `null` means flat delivery. */
  lastThreadId: number | null;
}

export interface ProjectAnswer {
  projectId: string;
  chatId: string;
  botMessageId: number;
  questionId: string;
  at: number;
}

export interface ProjectRegistry {
  record(projectId: string, projectName?: string): void;
  noteDelivery(projectId: string, threadId: number | null): void;
  snapshot(): ProjectBinding[];
  /**
   * Projects this instance has actually talked to, hub first and then most-recently-seen. An inbound
   * reply arrives carrying no project, so a correlation search needs exactly this candidate list.
   */
  knownProjectIds(hubProjectId?: string): string[];
  /**
   * A reply also carries the topic it was typed in, and a thread belongs to one project, so this turns
   * the common topics-mode case into a single correlation read instead of a scan.
   */
  projectForThread(chatId: string, threadId: number): string | null;
  /** Records which project owns a thread, learned from a successful correlation. */
  noteThreadOwner(projectId: string, chatId: string, threadId: number): void;
  noteAnswer(answer: ProjectAnswer): void;
  recentAnswers(limit?: number): ProjectAnswer[];
}

export function createProjectRegistry(now: () => number = Date.now): ProjectRegistry {
  const bindings = new Map<string, ProjectBinding>();
  const threadOwners = new Map<string, string>();
  const answers: ProjectAnswer[] = [];
  const ANSWER_HISTORY = 50;

  // Plain closures rather than object-literal methods: callers destructure this registry, and a method
  // reaching for `this` would be undefined the moment it is pulled off the object.
  function ensure(projectId: string, projectName?: string): ProjectBinding {
    const existing = bindings.get(projectId);
    if (existing) return existing;
    const created: ProjectBinding = {
      projectId,
      projectName: projectName?.trim() || undefined,
      firstSeenAt: now(),
      lastEventAt: now(),
      eventCount: 0,
      lastThreadId: null,
    };
    bindings.set(projectId, created);
    return created;
  }

  function record(projectId: string, projectName?: string): void {
    const binding = ensure(projectId, projectName);
    binding.lastEventAt = now();
    binding.eventCount += 1;
    if (projectName?.trim()) binding.projectName = projectName.trim();
  }

  function noteDelivery(projectId: string, threadId: number | null): void {
    // A delivery is evidence the project exists, so it must not be lost when a send is reached by a path
    // that never went through the ingest route (a retry, a future proactive question). It is not a second
    // event, so it must not inflate the count the ingest route already charged for the same event.
    ensure(projectId).lastThreadId = threadId;
  }

  function snapshot(): ProjectBinding[] {
    return [...bindings.values()]
      .map((binding) => ({ ...binding }))
      .sort((left, right) => right.lastEventAt - left.lastEventAt);
  }

  function threadKey(chatId: string, threadId: number): string {
    return `${chatId}:${threadId}`;
  }

  function knownProjectIds(hubProjectId?: string): string[] {
    const ordered = snapshot().map((binding) => binding.projectId);
    const hub = hubProjectId?.trim();
    // The hub owns the bot, so its own cards are the likeliest answer target; it goes first.
    const candidates = hub ? [hub, ...ordered.filter((id) => id !== hub)] : ordered;
    return [...new Set(candidates)];
  }

  function projectForThread(chatId: string, threadId: number): string | null {
    // "" is the disputed-owner marker: no owner is claimed, so the caller scans candidates instead.
    return threadOwners.get(threadKey(chatId, threadId)) || null;
  }

  function noteThreadOwner(projectId: string, chatId: string, threadId: number): void {
    const key = threadKey(chatId, threadId);
    const known = threadOwners.get(key);
    if (known && known !== projectId) {
      /*
      * Two projects claiming one thread means the bindings disagree — flat mode, where every project
      * shares chat and thread 0, shows this shape. The pair then carries no owner and the caller falls
      * back to scanning candidates rather than guessing which project an answer belongs to.
      */
      threadOwners.set(key, "");
      return;
    }
    threadOwners.set(key, projectId);
  }

  function noteAnswer(answer: ProjectAnswer): void {
    answers.push(answer);
    if (answers.length > ANSWER_HISTORY) answers.shift();
  }

  function recentAnswers(limit = 5): ProjectAnswer[] {
    if (limit <= 0) return [];
    return answers.slice(-limit).reverse();
  }

  return { record, noteDelivery, snapshot, knownProjectIds, projectForThread, noteThreadOwner, noteAnswer, recentAnswers };
}
