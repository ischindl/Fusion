---
"@runfusion/fusion": patch
---

Fix Planning Mode modal being pushed up when virtual keyboard opens on mobile. The modal now uses `useMobileKeyboard` to track viewport changes and adjusts its height via CSS variables instead of relying on `100dvh`.
