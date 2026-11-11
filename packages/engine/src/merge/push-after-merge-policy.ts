import type { Settings } from "@fusion/core";

export type PushAfterMergeLane = "single-repo" | "workspace";

/**
 * Why publishing is withheld, as a closed vocabulary an operator can query without re-deriving anything.
 *
 * `setting-disabled` names the operator: "Push to remote after merge" is off, so nothing will ever reach
 * a remote from this project until they flip it. `merge-strategy-suppressed` names the mechanism: the
 * operator DID ask for publishing, but the pull-request strategy owns the transport, so a push here would
 * be wrong rather than merely unwanted. The two read the same way in a log but have opposite remedies,
 * which is exactly why they are two codes and not one.
 *
 * FNXC:MergePublish 2026-10-31-22:57 (RUFU-338 F-4):
 * The boolean answer used to be the whole interface, so the merge lane that acted on it could not say why
 * it did nothing, and "publish disabled by config" was indistinguishable from a merge-lane dispatch
 * failure (RUFU-337 F-4, measured on main tip 05a0e0c786). The explanation is derived from the SAME
 * predicate rather than a second copy of the rule, so a trace can never disagree with the decision.
 */
export type PushAfterMergeDisabledReason = "setting-disabled" | "merge-strategy-suppressed";

/** One evaluated publish decision: enabled, or disabled with the fixed reason that says why. */
export type PushAfterMergeDecision =
  | { enabled: true }
  | { enabled: false; reasonCode: PushAfterMergeDisabledReason };

/**
 * FNXC:MergePush 2026-08-30-09:14:
 * FN-263 makes push-after-merge one policy across direct and workspace landing. A workspace task
 * always uses direct per-repository landing and never reaches `processPullRequestMerge` (FN-7610
 * at project-engine.ts:4694), so pull-request strategy suppresses only the single-repository push.
 *
 * FNXC:MergePublish 2026-10-31-22:57 (RUFU-338 F-4):
 * This is now the single decision point that ALSO explains itself; `isPushAfterMergeEnabled` is a
 * derivation over it, so every existing call site keeps byte-identical results while the two surfaces
 * that report a withheld publish name the cause instead of the silence.
 */
export function explainPushAfterMergeDecision(
  settings: Pick<Settings, "pushAfterMerge" | "mergeStrategy">,
  options: { lane?: PushAfterMergeLane } = {},
): PushAfterMergeDecision {
  if (settings.pushAfterMerge !== true) return { enabled: false, reasonCode: "setting-disabled" };
  if (options.lane !== "workspace" && settings.mergeStrategy === "pull-request") {
    return { enabled: false, reasonCode: "merge-strategy-suppressed" };
  }
  return { enabled: true };
}

export function isPushAfterMergeEnabled(
  settings: Pick<Settings, "pushAfterMerge" | "mergeStrategy">,
  options: { lane?: PushAfterMergeLane } = {},
): boolean {
  return explainPushAfterMergeDecision(settings, options).enabled;
}

/**
 * The canonical refusal for "publishing is on but no publish remote is configured".
 * One string on purpose: the parser throws it, both merge lanes put it in
 * `MergeResult.pushError`, and all three publish paths write it to task history, so a
 * support question about a refused publish has exactly one sentence to grep for.
 *
 * FNXC:MergePush 2026-11-08-16:19 (RUFU-366).
 */
export const PUBLISH_REMOTE_UNCONFIGURED = 'merge.pushRemote is not configured \u2014 publishing the merge result requires an explicit publish remote (e.g. "lan" or "lan main"); nothing was pushed.';

/**
 * The publish remote an operator actually configured, or `undefined` when they did not.
 *
 * FNXC:MergePush 2026-11-08-16:19 (RUFU-366):
 * This is the single answer to "where may this merge result be pushed?", and it deliberately
 * has NO default. Before this helper, four independent layers each re-derived `"origin"` when
 * the setting was unset — the schema default, two fallbacks in `parsePushRemoteTarget`, six
 * run-audit metadata fallbacks, and the confirmed-landing recovery lane's own statement — so an
 * operator who enabled "push after merge" without naming a remote silently published the
 * integration branch to a server nobody chose. Operator decision 2026-09-27 for this deployment
 * is that the engine publishes to the OneDev remote `lan` and that pushes to GitHub are
 * forbidden; the fix is explicit configuration plus refusal, NOT a provider blocklist, because
 * deployments that legitimately publish to GitHub must keep working untouched.
 * Whitespace-only counts as unset, and the returned string is trimmed, which is what lets
 * callers split it on whitespace and trust a non-empty first token.
 *
 * This names a PUBLISH target only. It is never a CI-evidence repository — see
 * `postMergeCiRepo` and the NO-FALLBACK rule in `post-merge-ci-repository.ts`, which names
 * `merge.pushRemote` as answering a different question.
 */
export function resolvePublishRemote(
  settings: Pick<Settings, "pushRemote">,
): string | undefined {
  return settings.pushRemote?.trim() || undefined;
}
