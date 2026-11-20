/**
 * The answer path's second half: what an operator's Telegram answer does to a parked card.
 *
 * FNXC:TelegramBridge 2026-11-20-04:05 (RUFU-782):
 * This is the one place in the bridge that may change a card's lifecycle, and it mirrors the dashboard's
 * own `POST /api/tasks/:taskId/workflow/input` exactly (`packages/dashboard/src/routes/register-workflow-routes.ts`):
 * `addSteeringComment(taskId, text, "user")` then `updateTask(taskId, { status: null, paused: false })`.
 * Two rules come from core and are not the plugin's to renegotiate:
 *
 * 1. `pausedReason` is never cleared here. `runAwaitInputNode` checks that its own `workflow-input:<node>@<epoch>:`
 *    marker is still present to prove the pause it is consuming, and clears the marker itself once it has
 *    taken the answer. A plugin that wiped the marker would make every later run re-pause without ever
 *    consuming an answer.
 * 2. The steering comment is written BEFORE the unpause. The node consumes the newest steering comment
 *    created at or after the pause watermark; resuming first could let the run re-park before the answer
 *    exists, and a park with no answer in it looks identical to a park that was never answered.
 *
 * The dashboard keeps authority over the card: an answer that arrives after someone already answered is
 * reduced to removing the buttons, and a card parked for any reason other than this node family is left
 * exactly as it is. The plugin's own Postgres row is what makes a double resume impossible; `paused` is a
 * boolean with no claim primitive behind it, so two simultaneous answers must be serialized by the row.
 */

import type { PluginContext } from "@fusion/plugin-sdk";
import { clipText, hasAwaitInputMarker } from "./format.js";
import type { TelegramLogger } from "./bot-api.js";
import type { AnswerHandler } from "./inbound.js";
import type { QuestionRepository, StoredQuestion } from "./persistence.js";
import { STEERING_TEXT_CHAR_LIMIT } from "./settings.js";

type TaskStoreLike = Pick<PluginContext["taskStore"], "getTask" | "addSteeringComment" | "updateTask">;

export interface AnswerHandlerPorts {
  logger: TelegramLogger;
  /** Only the four reads/writes this path needs; the rest of the table is another module's business. */
  questions: Pick<QuestionRepository, "findQuestion" | "findOpenByMessage" | "markAnswered" | "reopenQuestion">;
  /**
   * The store that owns the project behind a question. Task ids are project-local, so an answer must be
   * written through its own project's store and never through the hub's.
   */
  storeFor(projectId: string): Promise<TaskStoreLike | null>;
  registry: {
    noteAnswer(answer: { projectId: string; chatId: string; botMessageId: number; questionId: string; at: number }): void;
  };
  now?: () => number;
}

/** What the operator sees in Telegram. The refusal reason is the product surface, never only a log line. */
interface Answered {
  notice: string;
  dropButtons: boolean;
}

export function createAnswerHandler(ports: AnswerHandlerPorts): AnswerHandler {
  const now = ports.now ?? Date.now;

  /** The question row a pressed button refers to, searched across the projects this instance serves. */
  async function locateCallbackQuestion(
    projectIds: string[],
    questionId: string,
    chatId: string,
    botMessageId: number | null,
  ): Promise<StoredQuestion | null> {
    for (const projectId of projectIds) {
      const row = await ports.questions.findQuestion(projectId, questionId);
      if (!row) continue;
      /*
      * A question id is opaque and random, so a cross-project collision is not a realistic path; the chat
      * and message checks are still made because the button arrives inside a specific message, and a row
      * that names a different chat is evidence of a mismatched correlation, not a license to resume.
      */
      if (row.chatId !== chatId) continue;
      if (botMessageId !== null && row.botMessageId !== botMessageId) continue;
      return row;
    }
    return null;
  }

  async function deliver(row: StoredQuestion, rawText: string, chatId: string): Promise<Answered> {
    const text = clipText(rawText.trim(), STEERING_TEXT_CHAR_LIMIT);
    if (!text) return { notice: "The answer arrived empty, so nothing was recorded.", dropButtons: false };

    if (!row.taskId) {
      // A delivery that was never tied to a card (a plain event notice) has no lifecycle to change.
      await ports.questions.markAnswered(row.projectId, row.questionId).catch(() => undefined);
      return { notice: "That message was not a question for a card.", dropButtons: true };
    }

    const store = await ports.storeFor(row.projectId);
    if (!store) {
      // Row left open on purpose: the answer was not recorded, so it must stay answerable.
      return { notice: "Fusion could not be reached for this project. Answer in the dashboard, or try again.", dropButtons: false };
    }

    const task = await store.getTask(row.taskId);
    if (!task) {
      await ports.questions.markAnswered(row.projectId, row.questionId).catch(() => undefined);
      return { notice: `Card ${row.taskId} no longer exists.`, dropButtons: true };
    }
    if (!task.paused) {
      /*
      * The dashboard already handled it. The spec's rule: switch the buttons off and say so. Resuming here
      * would unpause a card that had moved on under its own steam, and writing a steering comment into a
      * running card is a surprise the operator did not ask for.
      */
      await ports.questions.markAnswered(row.projectId, row.questionId).catch(() => undefined);
      return { notice: "Already answered in the dashboard.", dropButtons: true };
    }
    if (!hasAwaitInputMarker(task.pausedReason ?? undefined)) {
      /*
      * The card is parked, but not by an await-input node: a plan approval, a CLI approval, a wedge, or a
      * manual pause. Each of those has its own approval surface and its own resume semantics; releasing
      * them from a chat message would bypass exactly the check that pause exists for. The question row
      * stays open, because the operator has not actually answered anything yet.
      */
      return {
        notice: `Card ${row.taskId} is parked for a different reason. Answer it in the dashboard.`,
        dropButtons: false,
      };
    }

    const claimed = await ports.questions.markAnswered(row.projectId, row.questionId);
    if (!claimed) {
      // Another answer won the claim a moment ago: that one is already steering the card.
      return { notice: "Already answered.", dropButtons: true };
    }

    try {
      await store.addSteeringComment(row.taskId, text, "user");
      await store.updateTask(row.taskId, { status: null, paused: false });
    } catch (error) {
      /*
      * The claim is given back so the answer is not swallowed: a transient store failure must leave the
      * operator a way to retry from Telegram. If the card has since been re-asked, the one-open-per-card
      * index refuses the reopen and the dashboard is the remaining path — which the notice says.
      */
      const reopened = await ports.questions.reopenQuestion(row.projectId, row.questionId).catch(() => false);
      ports.logger.error(`[telegram] could not deliver an answer to ${row.taskId}: ${describe(error)}`);
      return {
        notice: reopened
          ? "Fusion did not accept the answer, so the question is still open. Try again or answer in the dashboard."
          : "Fusion did not accept the answer. Answer in the dashboard.",
        dropButtons: false,
      };
    }

    ports.registry.noteAnswer({ projectId: row.projectId, chatId, botMessageId: row.botMessageId, questionId: row.questionId, at: now() });
    return { notice: `Answered ${row.taskId}. The card is running again.`, dropButtons: true };
  }

  async function onReply(projectId: string, chatId: string, botMessageId: number, text: string): Promise<Answered> {
    const row = await ports.questions.findOpenByMessage(projectId, chatId, botMessageId);
    if (!row) {
      // The caller proved an open row a moment ago; losing that race means another answer got there first.
      return { notice: "Already answered.", dropButtons: true };
    }
    return deliver(row, text, chatId);
  }

  return {
    async onCallback({ questionId, chatId, botMessageId, candidateProjectIds, optionIndex }) {
      const row = await locateCallbackQuestion(candidateProjectIds, questionId, chatId, botMessageId);
      if (!row) return { notice: "This question is no longer here.", dropButtons: true };

      if (optionIndex === null) {
        return { notice: "Reply to the message instead - this button predates option tracking.", dropButtons: false };
      }
      const option = row.options[optionIndex];
      if (option === undefined) {
        // A button from an earlier question whose options no longer match says nothing trustworthy.
        return { notice: "Those options are no longer the current ones. Reply to the message instead.", dropButtons: false };
      }
      /*
      * FNXC:TelegramBridge 2026-11-20-05:33 (RUFU-782 code review, P0):
      * A row closed as `superseded` was never answered by anybody: the card was re-asked (typically because
      * the operator answered the previous question in the dashboard, which never tells Telegram). Saying
      * "Already answered." here would point the operator at an action they did not take, and the reason
      * this row is dead at all is the newest question's message — so name it.
      */
      if (row.superseded) {
        return { notice: "This question was replaced by a newer one for the same card. Answer the newest message.", dropButtons: true };
      }
      if (!row.open) return { notice: "Already answered.", dropButtons: true };
      return deliver(row, option, chatId);
    },

    onReply: (input) => onReply(input.projectId, input.chatId, input.botMessageId, input.text),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
