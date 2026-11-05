/*
FNXC:PostMergeEvidenceContract 2026-11-05-04:13 (RUFU-456):
One status renderer for the two surfaces that expose the post-merge evidence contract — the workflow
editor's post-merge optional-group inspector and Settings → Merge. Both read the same
`GET /api/post-merge-evidence` row so an operator always sees ONE measurement, never two opinions.

Rules encoded here:
- The vocabulary is rendered from the `@fusion/core` exports (the `PostMergeEvidenceReason` /
  `PostMergeEvidenceProvider` / `PostMergeEvidenceKind` unions + `POST_MERGE_EVIDENCE_KINDS`), and the label
  tables are exhaustive `Record`s keyed by those unions — a kind/provider/reason added in core makes the
  UI fail to compile rather than silently drop the entry from a hand-copied list.
- An absent/failed observation renders NOTHING (a status line is never fabricated from a guess); the
  surfaces hide the line rather than claim a reporter nobody observed.
- The renderer is module-scope and lowercase (a render function, not a component) — the repo's
  no-nested-component-definition rule, and it keeps focus state stable across parent re-renders.
- The contract carries only ids/enums plus the presence-only `endpointHost`/`credentialConfigured` pair, so
  displaying it verbatim can never leak a URL, path, or credential.
*/
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import {
  POST_MERGE_EVIDENCE_KINDS,
  resolvePostMergeEvidenceKind,
  type PostMergeEvidenceContract,
  type PostMergeEvidenceKind,
  type PostMergeEvidenceProvider,
  type PostMergeEvidenceReason,
} from "@fusion/core";

type AppT = TFunction<"app">;

/** Option label per authored evidence kind — the node axis of the contract. */
const KIND_LABELS: Record<PostMergeEvidenceKind, { key: string; fallback: string }> = {
  "github-actions-full-suite": { key: "postMergeEvidence.kind.githubActionsFullSuite", fallback: "GitHub Actions Full Suite" },
  "integration-only": { key: "postMergeEvidence.kind.integrationOnly", fallback: "Integration-only" },
  "onedev-pipeline": { key: "postMergeEvidence.kind.onedevPipeline", fallback: "OneDev pipeline" },
  "gitlab-pipeline": { key: "postMergeEvidence.kind.gitlabPipeline", fallback: "GitLab pipeline" },
};

/** Option label per project reporter — the board axis of the contract. */
const PROVIDER_LABELS: Record<PostMergeEvidenceProvider, { key: string; fallback: string }> = {
  "github-actions": { key: "postMergeEvidence.provider.githubActions", fallback: "GitHub Actions" },
  onedev: { key: "postMergeEvidence.provider.onedev", fallback: "OneDev" },
  gitlab: { key: "postMergeEvidence.provider.gitlab", fallback: "GitLab" },
  none: { key: "postMergeEvidence.provider.none", fallback: "None (no CI reporter)" },
};

/** Why the board has this reporter — all eight derivations, keyed by the core enum. */
const REASON_LABELS: Record<PostMergeEvidenceReason, { key: string; fallback: string }> = {
  "operator-declared": { key: "postMergeEvidence.reason.operatorDeclared", fallback: "declared by operator" },
  "github-remote-with-workflows": { key: "postMergeEvidence.reason.githubRemoteWithWorkflows", fallback: "derived: this repo is on GitHub and has workflow files" },
  "github-remote-without-workflows": { key: "postMergeEvidence.reason.githubRemoteWithoutWorkflows", fallback: "derived: this repo is on GitHub but has no workflow files" },
  "onedev-endpoint": { key: "postMergeEvidence.reason.onedevEndpoint", fallback: "derived: this repo's remote matches a configured OneDev endpoint" },
  "gitlab-endpoint": { key: "postMergeEvidence.reason.gitlabEndpoint", fallback: "derived: this repo's remote matches a configured GitLab endpoint" },
  "non-github-remote": { key: "postMergeEvidence.reason.nonGithubRemote", fallback: "derived: the remote host has no configured CI reporter" },
  "no-remote": { key: "postMergeEvidence.reason.noRemote", fallback: "derived: this repository has no git remote" },
  "repo-facts-unreadable": { key: "postMergeEvidence.reason.repoFactsUnreadable", fallback: "repo facts could not be read — the gate keeps its historical contract" },
};

export function postMergeEvidenceKindLabel(t: AppT, kind: PostMergeEvidenceKind): string {
  const entry = KIND_LABELS[kind];
  return t(entry.key, entry.fallback);
}

export function postMergeEvidenceProviderLabel(t: AppT, provider: PostMergeEvidenceProvider): string {
  const entry = PROVIDER_LABELS[provider];
  return t(entry.key, entry.fallback);
}

/** The authored-kind options for a select, mapped from the core export (never a hand-copied list). */
export function postMergeEvidenceKindOptions(t: AppT): Array<{ value: PostMergeEvidenceKind; label: string }> {
  return POST_MERGE_EVIDENCE_KINDS.map((kind) => ({ value: kind, label: postMergeEvidenceKindLabel(t, kind) }));
}

/**
 * One-time read of the board's contract for a mounted surface (the editor session, the Settings section).
 * Fetch failure and `contract: null` both settle to `null` — the status line then hides itself.
 */
export function usePostMergeEvidenceContract(): PostMergeEvidenceContract | null {
  const [contract, setContract] = useState<PostMergeEvidenceContract | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/post-merge-evidence")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { contract?: PostMergeEvidenceContract | null } | null) => {
        if (!cancelled) setContract(data?.contract ?? null);
      })
      .catch(() => {
        // No observation is a legitimate state; the status line hides rather than fabricates.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return contract;
}

/**
 * "This board's post-merge reporter: OneDev — derived: … , pipeline at host:6610, credential configured."
 * Returns null for an unobserved contract; the caller renders nothing then.
 *
 * `nameInheritedResolution` adds the honest inherit reading — only correct when the node authored NO kind,
 * because an authored kind always wins and a "resolves to" line would then describe a different contract
 * than the one enforced.
 */
export function renderPostMergeEvidenceStatus(
  t: AppT,
  contract: PostMergeEvidenceContract | null,
  options: { nameInheritedResolution?: boolean } = {},
): ReactNode | null {
  if (!contract) return null;
  const reason = REASON_LABELS[contract.reason];
  const parts: ReactNode[] = [
    <span key="lead">{t("postMergeEvidence.statusLead", "This board's post-merge reporter:")} </span>,
    <strong key="provider">{postMergeEvidenceProviderLabel(t, contract.provider)}</strong>,
    <span key="reason">{" — "}{t(reason.key, reason.fallback)}</span>,
  ];
  if (contract.endpointHost) {
    parts.push(
      <span key="pipelineLead">{", "}{t("postMergeEvidence.pipelineAt", "pipeline at")} </span>,
      <code key="pipelineHost">{contract.endpointHost}</code>,
    );
  }
  if (contract.credentialConfigured) {
    parts.push(<span key="credential">{", "}{t("postMergeEvidence.credentialConfigured", "credential configured")}</span>);
  }
  if (options.nameInheritedResolution) {
    // Absent kind + this board's provider = the contract actually enforced (resolvePostMergeEvidenceKind);
    // on a OneDev/GitLab board this names the platform pipeline, NEVER the historical Full Suite reading.
    const effective = resolvePostMergeEvidenceKind({ authored: undefined, provider: contract.provider });
    parts.push(
      <span key="resolution">{". "}{t("postMergeEvidence.inheritResolves", "This step inherits the board's platform default, which resolves to")} </span>,
      <strong key="resolutionKind">{postMergeEvidenceKindLabel(t, effective)}</strong>,
    );
  }
  return parts;
}
