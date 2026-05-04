---
"@fusion/dashboard": patch
---

Fix mobile keyboard regressions in the dashboard.

- **Dashboard pushed up after closing a modal on mobile.** Adds a shared `useMobileScrollLock` hook that pins `body` with `position: fixed; top: -scrollY; width: 100%` while a fullscreen mobile overlay is open and restores scroll on cleanup — the same pattern Bootstrap, Headless UI, and Stripe Elements use to prevent iOS Safari from scrolling the document (and shifting `visualViewport.offsetTop`) when an input inside a `position: fixed` overlay is focused. Reference-counted so nested overlays don't release each other's locks. Wired into TodoModal, PlanningModeModal, TaskDetailModal, NewTaskModal, SettingsModal, MailboxModal, AddNodeModal, MissionInterviewModal, MilestoneSliceInterviewModal, SubtaskBreakdownModal, GitHubImportModal, AgentGenerationModal, AgentImportModal, ScriptsModal, ResearchTaskActionModal, and ChatView (replacing its inline body-overflow effect).
- **Auto-reload prompt missed rebuilds.** Widens `computeBuildVersion` in `vite.config.ts` to hash the entire `app/` source tree (FN-3333 follow-up). The previous version only hashed `app/main.tsx` and `package.json`, so edits to any other component or stylesheet produced an identical build version and the version-check poll never noticed the rebuild.
- **ChatView composer crawled down with iOS's keyboard-dismiss animation.** On blur, ChatView now suppresses keyboard-aware sizing for ~450ms so the composer snaps back to full height immediately instead of following iOS's slow keyboard slide-out (matches the existing QuickChatFAB behavior).
