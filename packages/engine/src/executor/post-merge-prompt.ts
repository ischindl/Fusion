/**
 * Post-merge prompt materialization (RUFU-457).
 *
 * The built-in post-merge gate carries ONE prompt text, written in GitHub Actions vocabulary: five named
 * workflows, four test shards, four timing artifacts, `gh` to read them. On a board whose CI is OneDev or
 * GitLab that demand cannot be satisfied as written, and RUFU-430 measured the consequence — 66 of 98
 * durable post-merge `failed` rows reported a CI run the reviewer could not find. The reviewer was correct;
 * the prompt was wrong about the platform.
 *
 * This module is the single place that swaps in the platform's own wording at dispatch time.
 */
import {
  POST_MERGE_VERIFICATION_PROMPT,
  buildPostMergeVerificationPrompt,
  resolvePostMergeEvidenceKind,
  type PostMergeEvidenceContract,
  type PostMergeEvidenceKind,
} from "@fusion/core";
import { resolvePostMergeEvidenceContract, type PostMergeContractStore } from "../merge/post-merge-evidence-contract.js";

/*
FNXC:PostMergeEvidenceContract 2026-10-01-07:58 (RUFU-457):
The substitution fires ONLY on a byte-for-byte match against the untampered built-in text, and that
condition is the whole safety property. An operator who edited this gate in the workflow editor keeps their
wording — including an edit that deliberately softens or hardens the evidence list — because anything other
than an exact comparison ("mentions CI", "contains shard") would overwrite authored text with generated
text. The trade-off is deliberate: a workflow with edited text gets no platform correction and stays
exactly as written, which is what an edit means.
*/
/**
 * Rewrite the built-in post-merge reviewer prompt into the reporter platform's own vocabulary.
 *
 * @param prompt the node's authored prompt text, read exactly as the IR carries it
 * @param authoredKind the evidence kind the workflow AUTHORED on the owning gate, if any
 * @param store the task store, used to read the project's evidence contract (cached per root)
 * @returns the platform prompt for the resolved contract, or `prompt` unchanged
 */
export async function materializePostMergePrompt(params: {
  prompt: string;
  authoredKind?: PostMergeEvidenceKind;
  store: PostMergeContractStore | null | undefined;
  /** Injectable for tests and for a caller that already holds the contract. */
  resolveContract?: (store: PostMergeContractStore | null | undefined) => Promise<PostMergeEvidenceContract | undefined>;
}): Promise<string> {
  const { prompt, authoredKind, store } = params;
  /*
  FNXC:PostMergeEvidenceContract 2026-10-01-07:58 (RUFU-457):
  The byte comparison runs BEFORE any store read, which is both the safety property above and the reason the
  contract lookup stays out of every unrelated prompt node. Had the order been reversed, each prompt node in
  the graph would ask the contract question on dispatch, and because the engine reader deliberately refuses to
  cache an observation whose facts could not be read, a board with an unreadable repository would shell out to
  `git remote` once per node instead of once per finalization attempt — the hot-path cost RUFU-430 added the
  cache to avoid. Only the post-merge gate's own text can substitute, so only it pays for the read.
  */
  if (prompt !== POST_MERGE_VERIFICATION_PROMPT) return prompt;

  const resolveContract = params.resolveContract ?? resolvePostMergeEvidenceContract;
  let contract: PostMergeEvidenceContract | undefined;
  try {
    contract = await resolveContract(store);
  } catch {
    /*
    FNXC:PostMergeEvidenceContract 2026-10-01-07:58 (RUFU-457):
    Prompt materialization must never be the reason a gate fails to dispatch. With no readable contract the
    historical GitHub text is what ships — the same text this node dispatched with before the change — and
    the gate seam stays authoritative on its own evidence (it reads the contract independently and exempts
    via `isPostMergeEvidenceUnreportable`, so a prompt fallback cannot turn an exemption into a demand or
    the other way round).
    */
    return POST_MERGE_VERIFICATION_PROMPT;
  }

  return buildPostMergeVerificationPrompt(resolvePostMergeEvidenceKind({
    authored: authoredKind,
    provider: contract?.provider,
  }));
}
