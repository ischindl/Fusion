#!/usr/bin/env bash
#
# lan-backup.sh — push this checkout to the LAN OneDev mirror, safely and idempotently.
#
# Usage: scripts/lan-backup.sh [--always] [--only-main] [--detach]
#                              [--lock-wait SECONDS] [--install-hooks]
#
# FNXC:Backup 2026-09-05-11:20: LAN backup of the Fusion checkout to OneDev
# (http://192.168.12.60:6610/fusion.git, remote `lan`). Operator decision: the
# local `main` existed only on this box while `fork/main` was stale since
# 2026-07-18, so the operator asked for an off-box copy that can be pushed at
# any time and must be refreshed whenever `main` moves. Every local branch and
# tag is backed up (`git push --all` + `--tags`); stashes are not refs and are
# deliberately out of scope.
#
# FNXC:Backup 2026-09-05-11:20: The checkout was a shallow clone
# (.git/shallow, one graft at 2026-07-30) and OneDev's receive-pack refuses
# shallow updates, so 42 of 43 branches — `main` included — were unpushable.
# That is why the repo was unshallowed from origin first: never assume a
# shallow clone can be mirrored anywhere.
#
# FNXC:Backup 2026-09-05-11:20: Non-interactive by construction. Credentials come
# from git's own credential helper (`credential.helper=store`), and
# GIT_TERMINAL_PROMPT=0 guarantees a missing credential fails fast instead of
# parking a detached process forever on a stdin prompt nobody can answer.
#
# FNXC:Backup 2026-09-05-11:20: Serialized under one lock file. Engine auto-merge,
# task worktrees and heartbeat wakes can all move refs concurrently, and two
# simultaneous `git push --all` runs on one repo race on the same refs.
# --lock-wait bounds how long a caller queues instead of wedging a git hook;
# the detached heartbeat path uses a generous wait.
#
# FNXC:Backup 2026-09-05-11:20: Plain push, never --atomic: one protected or
# refused ref must not block the other 202 refs. Never --prune: a backup lane
# must not propagate local ref deletions, so a destroyed branch stays
# recoverable on the server.
#
# FNXC:Backup 2026-09-05-11:20: Default mode is drift-driven, so an unchanged
# checkout costs one network round trip (ls-remote) and zero pack bytes. The
# remote refs are the source of truth — no local state file to drift from a
# reset or a worktree rewrite.
#
# FNXC:Backup 2026-09-05-14:07: This copy is TRACKED (under scripts/) at the
# operator's explicit request, because the tool previously lived only in
# gitignored `.fusion/` and `.git/hooks` — i.e. the backup did not contain its
# own tooling, so a disk loss would have cost the operator the very thing that
# prevented a disk loss. Tracked-local precedent in this repo:
# `scripts/deploy-rufu-*.mjs`. Operator-local by design and NOT an upstream PR
# candidate: it hardcodes a LAN address and an operator path.
#
# FNXC:Backup 2026-09-05-14:07: `--install-hooks` exists so the hook half of the
# mechanism is recoverable from the tracked copy alone (git hooks are not
# objects; a clone or a restored disk never receives them). It refuses to
# overwrite any hook it did not write rather than silently replacing a
# third-party hook (this checkout already carries worktrunk's
# `pre-commit`/`commit-msg`/`prepare-commit-msg`, which must survive).
#
# FNXC:Backup 2026-09-05-14:07: Hooks are a FAST PATH, never the guarantee. The
# engine merger advances `main` by plumbing (`update-ref`/commit in a throwaway
# worktree), which fires no hook at all, and other agent sessions commit without
# this process knowing. The durable guarantee is the caller that runs this script
# on a schedule/wake; a hook only narrows the window.
set -euo pipefail

REPO="${LAN_BACKUP_REPO:-/home/schindler/git/Fusion}"
REMOTE="${LAN_BACKUP_REMOTE:-lan}"
URL="${LAN_BACKUP_URL:-http://192.168.12.60:6610/fusion.git}"
LOG="${LAN_BACKUP_LOG:-$REPO/.fusion/logs/lan-backup.log}"
LOCK="${LAN_BACKUP_LOCK:-${XDG_RUNTIME_DIR:-/tmp}/fusion-lan-backup.lock}"

# Written into every managed hook so re-runs recognize their own files and a
# foreign hook is never clobbered. Keep in sync with install_hooks below.
HOOK_MARKER="lan-backup:managed-hook"

usage() { awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"; }

MODE="auto"
LOCK_WAIT=5
DETACH=0
INSTALL_HOOKS=0
MODE_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --detach) DETACH=1; LOCK_WAIT=120; shift ;;
    --always) MODE="always"; MODE_ARGS+=(--always); shift ;;
    --only-main) MODE="main"; MODE_ARGS+=(--only-main); shift ;;
    --install-hooks) INSTALL_HOOKS=1; shift ;;
    --lock-wait) LOCK_WAIT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "lan-backup: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

mkdir -p "$(dirname "$LOG")"
cd "$REPO"
export GIT_TERMINAL_PROMPT=0

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG"; }

# Installs post-commit / post-merge / post-rewrite — the three events that fire
# when `main` gains commits, is merged into, or is rewritten (rebase/amend).
install_hooks() {
  local hooks_dir hook target wrote=0 refused=0
  # `--git-path hooks` is the only correct resolution: it honors core.hooksPath
  # and, from a linked worktree, resolves the SHARED hooks dir that every
  # worktree actually reads.
  hooks_dir="$(git rev-parse --git-path hooks)"
  mkdir -p "$hooks_dir"
  for hook in post-commit post-merge post-rewrite; do
    target="$hooks_dir/$hook"
    # An existing hook is only ours if it was written by this function. The
    # `lan-backup.sh` alternative matches hooks installed before the marker
    # existed, so re-running on this box updates them instead of refusing.
    # Anything else (worktrunk, husky, a hand-written hook) is left strictly alone.
    if [ -e "$target" ] && ! grep -Eq "$HOOK_MARKER|lan-backup\.sh" "$target" 2>/dev/null; then
      printf 'lan-backup: refusing to overwrite foreign hook %s\n' "$target" >&2
      refused=1
      continue
    fi
    cat >"$target" <<'HOOK'
#!/usr/bin/env bash
# lan-backup:managed-hook — written by scripts/lan-backup.sh --install-hooks.
#
# FNXC:Backup 2026-09-05-14:07: LAN backup fast path. Refresh the OneDev copy
# (`lan` -> http://192.168.12.60:6610/fusion.git) when `main` moves. This hook
# only pays for itself when the current branch IS main: task-worktree commits
# move fusion/<task> refs and must not reach the network. The work is handed to
# the detached script, which owns locking, drift detection and logging, so a
# commit never waits on a LAN transfer. Always exits 0 — a backup must never be
# able to fail a commit.
[ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "main" ] || exit 0
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
SCRIPT="$ROOT/scripts/lan-backup.sh"
# A linked worktree on an older branch predates this tracked file; fall back to
# the canonical checkout rather than silently skipping the push.
[ -x "$SCRIPT" ] || SCRIPT="/home/schindler/git/Fusion/scripts/lan-backup.sh"
[ -x "$SCRIPT" ] || exit 0
"$SCRIPT" --only-main --detach >/dev/null 2>&1
exit 0
HOOK
    chmod +x "$target"
    wrote=$((wrote + 1))
  done
  printf 'lan-backup: managed hooks installed=%d refused=%d dir=%s\n' "$wrote" "$refused" "$hooks_dir"
  exit "$refused"
}

if [ "$INSTALL_HOOKS" = 1 ]; then
  install_hooks
fi

# The push body runs with stdout/stderr appended to the log file, never to a
# terminal: a detached caller has no tty to read and a hook must not hold a
# session open.
do_push() {
  exec 3>>"$LOG"
  if ! flock -w "$LOCK_WAIT" 3; then
    log "RESULT=lock-timeout lock=$LOCK wait=${LOCK_WAIT}s"
    exit 0
  fi

  if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
    git remote add "$REMOTE" "$URL" >>"$LOG" 2>&1 \
      || { log "RESULT=remote-add-failed remote=$REMOTE"; exit 0; }
  fi

  # `2>&3`, never `2>>3`: the latter is a shell redirect to a FILE literally named
  # "3", which dropped an untracked empty `3` into the primary checkout and lost
  # the diagnostic (measured 2026-09-05, caught via `git status --porcelain`).
  # A 404 here reads as "Project not found or inaccessible" — that is what a
  # server-side project deletion looks like, so it must reach the log.
  if ! git ls-remote "$REMOTE" >/dev/null 2>&3; then
    log "RESULT=remote-unreachable remote=$REMOTE url=$URL"
    exit 0
  fi

  local tmp drift branch rc_total=0
  tmp="$(mktemp)"
  git ls-remote "$REMOTE" 2>&3 | awk '{print $2 " " $1}' | sort >"$tmp" || {
    log "RESULT=ls-remote-failed remote=$REMOTE"; rm -f "$tmp"; exit 0; }

  drift=0
  if [ "$MODE" != "always" ]; then
    # Only refs/heads (plus HEAD for --only-main) matter here; tags ride along
    # with the branch push because both pushes are cheap once drift exists.
    if [ "$MODE" = "main" ]; then
      local local_sha remote_sha
      local_sha="$(git rev-parse main 2>/dev/null || echo none)"
      remote_sha="$(awk '$1=="refs/heads/main"{print $2}' "$tmp")"
      [ "$local_sha" != "$remote_sha" ] && drift=1
      log "check mode=only-main local=${local_sha:0:10} remote=${remote_sha:0:10} drift=$drift"
    else
      while read -r ref sha; do
        case "$ref" in
        refs/heads/*) ;;
        *) continue ;;
        esac
        if [ "$(awk -v r="$ref" '$1==r{print $2}' "$tmp")" != "$sha" ]; then
          drift=$((drift + 1))
        fi
      done < <(git for-each-ref --format='%(refname) %(objectname)' refs/heads)
      log "check mode=auto drifted_branches=$drift"
    fi
  fi
  rm -f "$tmp"

  # `--always` must still reach the push loop: drift is only ever *computed* in
  # auto/only-main mode, so without this forced flag a --always run would fall
  # into the in-sync early-exit and push nothing (measured on first test).
  [ "$MODE" = "always" ] && drift=1

  if [ "$drift" = 0 ]; then
    log "RESULT=in-sync"
    exit 0
  fi

  for branch in --all --tags; do
    if git push "$REMOTE" "$branch" >>"$LOG" 2>&1; then
      log "push $branch ok"
    else
      rc_total=1
      log "push $branch FAILED"
    fi
  done
  log "RESULT=$([ "$rc_total" = 0 ] && echo ok || echo partial) drifted_branches=$drift"
  exit "$rc_total"
}

if [ "$DETACH" = 1 ]; then
  # Detached so a git hook or heartbeat never blocks on a LAN transfer. setsid
  # breaks the caller's process group so the hook exits immediately; hang-up
  # immunity plus closed stdin (process-supervisor-allowlist) keeps the run from
  # surviving on a pipe or blocking on a prompt.
  # process-supervisor-allowlist: operator-invoked LAN backup self-detach, not a Fusion-managed
  # child process; superviseSpawn is for engine-tracked subprocesses and cannot apply in a shell script.
  setsid nohup bash "$0" ${MODE_ARGS[@]+"${MODE_ARGS[@]}"} </dev/null >/dev/null 2>&1 & # process-supervisor-allowlist
  log "spawned detached run pid=$! mode=${MODE_ARGS[*]:-auto}"
  exit 0
fi

do_push
