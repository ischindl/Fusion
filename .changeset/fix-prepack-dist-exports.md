---
"@runfusion/fusion": patch
---

fix: keep `./dist/*` subpaths resolvable in the packed manifest

The prepack transform injects an `exports` field for the plugin-sdk subpath,
which flips Node into strict subpath mode and hid every other `./dist/*` file.
That broke the runfusion.ai alias (which imports
`@runfusion/fusion/dist/bin.js`) with `ERR_PACKAGE_PATH_NOT_EXPORTED`, failing
the pre-publish smoke test. Add a `./dist/*` passthrough so the alias bin and
the pi `./dist/extension.js` loader keep resolving after pack.
