# fusion-plugin-dependency-graph

Plugin-provided top-level **Graph** dashboard view for Fusion.

## Rendering approach

- **Filtering**: includes `triage`, `todo`, `in-progress`, `in-review`; excludes `done`, `archived`
- **Graph build**: edges are resolved only from `task.dependencies` as `source=dependent`, `target=dependency`
- **Auto-layout**: Sugiyama-style layered layout (`computeAutoLayout`) groups nodes by dependency depth and spaces layers consistently
- **Edge drawing**: SVG bezier curves from source bottom-center to target top-center, with arrowheads showing dependent → dependency direction
- **Interaction**: pan, wheel zoom, pinch zoom, zoom-in/out controls, reset, and fit-to-screen
- **Fit-to-screen**: computes node bounding box with layout node dimensions and applies zoom/pan so the graph fits in viewport with padding

## Controls

- **Fit to screen** (`Maximize`)
- **Zoom in** (`ZoomIn`)
- **Zoom out** (`ZoomOut`)

All controls are rendered as floating `.btn-icon` actions in the bottom-right corner, with mobile-friendly sizing in the `@media (max-width: 768px)` override.
