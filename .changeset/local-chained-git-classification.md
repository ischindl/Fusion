---
"@runfusion/fusion": patch
---

summary: A git write in a chained shell command is no longer classified as a read and left ungated.
category: fix
dev: classifyGitCommand used a non-global String.match and inspected only the first git invocation, so putting a read in front of a write let the write run under a policy that gates git_write. It now scans every invocation, classifies each against its own slice of the command so per-subcommand flag tests cannot read a flag belonging to a different invocation, and lets any write win. The subcommand capture narrows from `([^\s]+)` to `([^\s;&|]+)`, because the greedy form swallowed an abutting separator and hid the following invocation from the scan entirely. isGitWriteCommand and the permanent-agent gate inherit the fix.
