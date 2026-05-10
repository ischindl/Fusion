# Reports Plugin

## Rendering & Export

The reports plugin renders deterministic HTML via `src/render/html-template.ts` using ordered `data-section` blocks and tokenized styles from `src/render/html-styles.ts`. Section toggles and `sectionOrder` are respected from report settings metadata, and both dark/light themes are embedded directly in the output document (no dashboard stylesheet dependency).

Standalone exports are produced by `renderStandaloneReportHtml` in `src/render/standalone-html.ts`. The export is fully self-contained (single document, inlined `<style>`, no remote CSS/fonts, and no non-allowlisted external `href/src` URLs). Exported HTML is cached back into the report store (`rendered_html`, `rendered_html_generated_at`) on first export.

HTTP endpoints:
- `GET /api/plugins/fusion-plugin-reports/reports/:id/export.html` → attachment download (`Content-Disposition` + `text/html`)
- `GET /api/plugins/fusion-plugin-reports/reports/:id/preview.html` → body-only HTML fragment for embedded preview viewers
