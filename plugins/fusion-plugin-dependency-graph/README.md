# fusion-plugin-dependency-graph

Plugin-provided top-level **Graph** dashboard view for Fusion.

- Registers `dashboardViews: [{ viewId: "graph", placement: "more" }]`
- Renders active task dependency graph for `triage`, `todo`, `in-progress`, `in-review`
- Excludes `done` and `archived`
- Persists drag positions in browser localStorage at:
  - `kb:${projectId}:dependency-graph-positions`

The first version uses a lightweight custom SVG/HTML renderer (no React Flow dependency).

## Mobile Support

The dependency graph view is fully usable on mobile devices:

- **Pinch-to-zoom** — Two-finger pinch gestures scale the graph proportionally, clamped to `[0.4×, 2×]`
- **Mouse wheel zoom** — Desktop users can scroll-wheel to zoom toward the pointer position
- **Auto-fit on mobile** — On initial mobile load, the graph automatically fits all nodes into the viewport
- **Touch-friendly controls** — Zoom In, Zoom Out, and Fit buttons have 44px minimum touch targets on mobile
- **Sticky control bar** — Controls remain accessible at the top of the viewport while panning the graph on mobile
- **Touch-action isolation** — `touch-action: none` on the canvas prevents browser gesture interference with custom pan/zoom
- **Empty state** — When no active tasks exist, a centered message guides the user instead of showing an empty canvas

### Supported Interactions

| Input | Action |
|-------|--------|
| Single pointer drag on canvas | Pan the graph |
| Single pointer drag on node | Move the node |
| Single pointer click on node | Open task detail |
| Two-finger pinch | Zoom in/out |
| Mouse wheel | Zoom toward pointer |
| Zoom In / Zoom Out buttons | Step zoom ±0.1× |
| Fit button | Auto-fit all nodes to viewport |
