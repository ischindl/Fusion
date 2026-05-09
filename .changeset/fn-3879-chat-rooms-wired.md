---
"@runfusion/fusion": patch
---

Wire chat rooms UI to backend. Creating a room now persists via /api/chat/rooms, the sidebar lists real rooms, room threads load history and stream new messages over chat:room:* SSE events, and the FN-3807 "Coming soon" placeholder is gone.
