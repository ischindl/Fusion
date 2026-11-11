---
"@runfusion/fusion": patch
---

summary: Publishing after a merge now requires an explicit remote; the silent "origin" default is gone.
category: fix
dev: Removed the implicit `merge.pushRemote` = "origin" default (schema default, both fallbacks in `parsePushRemoteTarget`, the run-audit metadata fallbacks, and the confirmed-landing recovery lane's own target derivation). With "Push to remote after merge" enabled and no remote configured, every automatic publish path now refuses BEFORE running any git command: both merge lanes record `push:origin` with `outcome: "refused"`, `reason: "publish-remote-unset"`, `remote: null` and the new `remoteConfigured: "unset"` key, write the task-history refusal sentence, and still finalize the merge; the pump-driven confirmed-landing recovery lane does nothing at all — no push, no `pushRecovery` retry record, no cooldown slot. When publishing does run, audit `remote` names the target actually offered instead of a guessed default. Enforcement is explicit configuration plus refusal only: no provider or URL blocklist was added, so deployments that publish to GitHub keep working once the remote is named. Set Settings → Merge → Push Remote (e.g. `lan`, or `lan main`) to publish.
