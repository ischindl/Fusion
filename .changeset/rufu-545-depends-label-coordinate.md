---
"@runfusion/fusion": patch
---

summary: Step dependency annotations now point at the step they name, instead of one step earlier.
category: fix
dev: A Markdown `(depends: N)` heading annotation resolves against the authored heading label `### Step N` in the same PROMPT.md instead of the Nth parsed step, so a fan-in like `### Step 6 (depends: 1,2,3,4,5)` keeps every predecessor it names. A plan carrying such an annotation must now number its headings as an exact `0..n-1` sequence (or the legacy exact `1..n`): numbering that is neither refuses with the new `ambiguous-labels` reason naming the annotated heading, instead of resolving to a wrong step. A token equal to its own heading label is treated as redundant boilerplate and resolves to the immediately preceding step. `json-steps` `depends` values and plugin parsers keep their 0-based storage indices, and no stored task data changes — only the translation from an annotation to an index moves.
