---
"@dustinbyrne/kb": minor
---

Add interactive terminal to dashboard

The dashboard now includes a fully interactive PTY-based terminal where users can execute
shell commands directly from the web interface. Key features:

- Real PTY terminal using node-pty with authentic shell behavior (bash/zsh/powershell)
- xterm.js for full terminal emulation with colors, cursor handling, and ANSI support
- WebSocket bidirectional communication for instant input/output
- Auto-resizing terminal with zoom support (Ctrl++/-)
- Scrollback buffer with reconnection support
- Copy/paste support via keyboard shortcuts
- Session management with configurable limits
- Security: path traversal protection, environment sanitization, shell allowlist
