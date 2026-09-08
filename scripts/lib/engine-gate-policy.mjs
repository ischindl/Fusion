/*
FNXC:MergeGatePolicy 2026-09-08-11:02 (RUFU-197):
The merge-gate policy test used to freeze the gate's exact membership as literal arrays (a 21-file
engine-core allow-list, a 23-name former-PG-member list, `removedFromGate.length === 22`, a 16-validator
mirror). Every legitimate gate admission or deletion forced a matching edit to this test, so the two live
lanes that drift most — the engine-core lane and the PG canary lane — were exactly the lanes whose guards
went red on an unrelated day and were then left red, hiding the NEXT real drift ("a red policy test protects
nothing"). These evaluators replace those mirrors. They are PURE — the caller injects already-derived
inputs (config include lists via `vitest-config-parse`, filesystem discovery, ledger rows), so both the
violation and no-violation directions can be exercised with fabricated data instead of mutating the repo.
Membership/count/validator mirrors are gone; what remains is the load-bearing contract: a gate selects real
files, a quarantined file is never also a gate member, a canary is never hidden, and the PG lane stays
narrow.
*/

function asSet(values) {
  return values instanceof Set ? values : new Set(values ?? []);
}

/*
FNXC:MergeGatePolicy 2026-09-08-11:27 (RUFU-197):
This file's own pre-existing rule is that "a red policy test protects nothing" and the ledger must never be
left red, yet the guard that enforced that rule was itself red: it re-typed the engine allow-list as an ordered
literal, so deletion-ratchet commit 82c635384d (which legitimately retired an expired quarantined PG test) was
indistinguishable here from lost coverage. Membership is therefore DERIVED from the declaration plus the
filesystem; only the load-bearing contract is asserted, and each violation kind is a real disagreement rather
than a diff against a stale copy.

Engine-core lane: an explicit allow-list inside a Vitest `projects` entry. `members` are the concrete test
files extracted from that project's `include:` (package-relative, e.g. `src/__tests__/x.test.ts`). `fileExists`
resolves a member against the engine package. `quarantinedFiles` are package-relative engine files that carry
a quarantine ledger row. A lane that selects nothing is as broken as one that names deleted files, so an empty
allow-list is reported too.
*/
export function evaluateEngineCoreGate({ members, fileExists, quarantinedFiles = [] }) {
  const list = Array.isArray(members) ? members : [];
  const quarantined = asSet(quarantinedFiles);
  const violations = [];

  if (list.length === 0) {
    violations.push({ kind: "empty-membership", detail: "engine-core include selects no concrete test files" });
  }

  const seen = new Set();
  for (const member of list) {
    if (seen.has(member)) violations.push({ kind: "duplicate-member", file: member });
    seen.add(member);
    if (typeof fileExists !== "function" || !fileExists(member)) {
      violations.push({ kind: "member-file-missing", file: member });
    }
    if (quarantined.has(member)) {
      violations.push({ kind: "quarantined-member", file: member });
    }
  }

  return { members: list, violations };
}

/*
PG canary lane — the retired-member ledger is now an accounting invariant, not a name list. Deletion-ratchet
commit 82c635384d removed `src/__tests__/postgres/mission-store.pg.test.ts` (expired quarantine, no rescue
evidence) together with its ledger row, and the old guard failed with "former PG gate member must remain
discovered" because it had frozen the former members as 23 literals plus `removedFromGate.length === 22`. What
that list was actually protecting is "every live PG file has a disposition", so it is now computed from the live
postgres directory: each discovered file is either a gate member or non-blocking, and every exclusion is
explained by the gate or the ledger. FN-8497 keeps only lifecycle + transactional-handoff canaries in `test:pg-gate` because every
PG file spins up a real database; putting the whole inventory on each PR made the gate 26-45s. The old guard
encoded the NON-canary members as a frozen list and asserted they stay discovered — the ratchet this replaces.
It is now derived: iterate the LIVE discovered PG files, require the required canaries exist and run, forbid a
canary being hidden by exclusion or quarantine, and keep the speed-fix invariant that the gate is a proper
subset of discovery (if discovery collapses to only the canaries, or every discovered file is on the gate, the
narrowness is gone). `gateMembers` come from the package script; `discoveredPgFiles` from the filesystem;
`excludedPgFiles` from the key-aware test-level exclude reader (NOT coverage.exclude); `quarantinedPgFiles`
from the ledger.
*/
export function evaluatePgGate({
  requiredCanaries = [],
  gateMembers = [],
  discoveredPgFiles = [],
  excludedPgFiles = [],
  quarantinedPgFiles = [],
}) {
  const gate = Array.isArray(gateMembers) ? gateMembers : [];
  const discovered = asSet(discoveredPgFiles);
  const excluded = asSet(excludedPgFiles);
  const quarantined = asSet(quarantinedPgFiles);
  const gateSet = asSet(gate);
  const violations = [];

  for (const canary of requiredCanaries) {
    if (!gateSet.has(canary)) {
      violations.push({ kind: "required-canary-dropped", file: canary });
    }
  }

  for (const member of gate) {
    if (!discovered.has(member)) {
      violations.push({ kind: "canary-file-missing", file: member });
    }
    if (excluded.has(member)) {
      violations.push({ kind: "canary-excluded", file: member });
    }
    if (quarantined.has(member)) {
      violations.push({ kind: "canary-quarantined", file: member });
    }
  }

  /*
  Every PG exclusion has to be explained by exactly one of the three sanctioned dispositions. An exclude that
  names a file no longer on disk is stale — it hides nothing and outlives the deletion it was written for. An
  exclude that names a live file and is neither a gate member (already reported as `canary-excluded`) nor a
  quarantine ledger row is coverage that quietly stopped running with no record saying why: the ledger owns the
  "quarantined files must also be excluded" direction (`check-quarantine-ledger.mjs` `missing-exclude`), so this
  is the only owner of the reverse direction for the blocking PG lane.
  */
  for (const file of excluded) {
    if (!discovered.has(file)) {
      violations.push({ kind: "stale-exclude", file });
    } else if (!gateSet.has(file) && !quarantined.has(file)) {
      violations.push({ kind: "unaccounted-exclusion", file });
    }
  }

  // Lane-existence and narrowness (FN-8497 speed fix). An empty gate silently removes every PG invariant from
  // the blocking lane; a gate equal to the whole inventory re-creates the 26-45s merge gate the narrow-canary
  // ledger exists to prevent. Both ends of the collapse are reported, so neither can pass vacuously.
  if (discovered.size === 0) {
    violations.push({ kind: "empty-discovery", detail: "no PG test files discovered for the canary lane" });
  } else if (gate.length === 0) {
    violations.push({ kind: "empty-gate", detail: "test:pg-gate selects no PG canary at all" });
  } else if (![...discovered].some((file) => !gateSet.has(file))) {
    violations.push({ kind: "gate-not-narrow", detail: "every discovered PG file is on the blocking gate" });
  }

  return { gateMembers: gate, violations };
}
