# UGEM Operations Workspace branding

## Verified source (October 21, 2026)

Read-only inspection of https://www.ugemconsulting.com returned HTTP 200. The web text reader could not open it, but the public HTML and its linked [Squarespace stylesheet](https://static1.squarespace.com/static/versioned-site-css/6a7ce2f2b1ef85630571d31e/12/5c5a519771c10ba3470d8101/6a7ce2f2b1ef85630571d326/1842/site.css?nocustom=true) were retrieved successfully. These are source-level findings, not a screenshot/computed-layout audit.

| Element | Source evidence | Workspace treatment |
| --- | --- | --- |
| Identity | Desktop/mobile `.header-title-text` contains the text “UGEM Consulting”; no header logo image | Reusable text wordmark; no invented or unlicensed logo |
| Palette | `--accent-hsl: 17.82,100%,55.1%`; white `0,0%,100%`; light accent `0,1.33%,85.29%`; dark accent `0,0%,15.69%`; black `0,0%,0%` | Original orange for brand accents, charcoal/neutral surfaces; accessible orange derivatives for interactive text |
| Type | Anton 400 headings/site title, 1.2em heading line height; Epilogue 400 body, 1.5em line height; zero letter spacing | Anton wordmark/page headings; Epilogue forms, tables, navigation and smaller section headings |
| Buttons | HTML declares solid primary pills, outline secondary pills; CSS primary padding 1.2em vertical / 2em horizontal | Shared pill buttons, 44px minimum height, compact internal-app spacing |
| Spacing | Site settings: 2000px max width, 4vw page padding; mobile gutter 6vw | Retain 1440px dashboard container, responsive 20–48px gutters and existing grids |
| Design language | High-impact display type, orange accents, black/white/charcoal contrast, generous marketing gutters | Functional cards, readable data, restrained accents and compact navigation |

The browser connection failed before navigation, so exact rendered spacing, responsive behavior, imagery and visual equivalence could not be verified. No standalone approved company logo was established. The typography wordmark is intentional. No marketing imagery or Squarespace font binaries were copied.

## Implementation

- `apps/web/src/lib/brand.ts` owns company/app/display names, website, description, logo mode and future domain. The future domain is descriptive only: no redirects, API URLs, cookie configuration or DNS changes.
- `apps/web/src/app/globals.css` owns palette, light/dark semantic Tailwind tokens, radii, typography, form boundaries and focus styling. Derived UI colors are adaptations, not claims about official brand colors.
- `BrandWordmark`, shared Button/Card, navigation and layouts carry the identity across staff and applicant pages. Existing review and IT screens inherit shared typography, surfaces, controls and semantic status colors.
- Anton and variable Epilogue are self-hosted through `next/font/local`. Original files and SIL Open Font Licenses came from the [Google Fonts Anton directory](https://github.com/google/fonts/tree/main/ofl/anton) and [Epilogue directory](https://github.com/google/fonts/tree/main/ofl/epilogue); license files are alongside the fonts in `apps/web/src/assets/fonts`. No third-party font request is needed at build or runtime.
- System theme remains the default, with manual light/dark switching now available on applicant pages too. Focus outlines, reduced-motion rules, 16px form text and readable status labels complement the existing accessibility behavior.
- Auth guards, server-provided navigation/permissions, mutations, validation and workflow rules remain unchanged. Navigation highlights the most specific authorized parent for detail pages.

## Contrast verification

WCAG relative-luminance calculations against the declared tokens (not a full rendered accessibility audit): normal text/background 13.76:1 light / 16.60:1 dark; muted text/card 6.10:1 / 7.82:1; primary button text 6.44:1 / 7.59:1; primary text/accent 5.79:1 / 5.72:1. Success/warning/error text on their semantic surfaces exceeds 5.7:1 in both modes. Input boundaries/background exceed 3.3:1 and focus rings/card exceed 6.4:1. Original orange is used with black text on the dashboard CTA, not white small text.

## Outstanding manual visual checks

Use fictional local accounts; no deployment or production account changes are required.

- Compare the live marketing header/type/buttons with the implementation when browser access is available; confirm the text wordmark with the brand owner or supply an approved logo later.
- At 375px, 768px and 1440px, inspect login, each role’s dashboard/navigation, applicant verification/draft/corrections, review queue/detail/decision dialogs, IT queue/checklist/task dialog and notifications in light and dark modes.
- Check font loading, long names/email/notes, table overflow, horizontal mobile navigation, dialog scrolling, validation/disabled/pending states and 200% zoom.
- Keyboard-check skip links, visible focus, tab order, theme toggle, approval/rejection confirmation and dialog dismissal; screen-reader-check headings, labels and status announcements.
- Confirm automatic theme selection and persisted manual switching without hydration warnings.

## Validation results

Completed with Node 24.22.0: `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` (both Next.js and NestJS) passed. Tests: 6 suites / 42 tests passed; 2 suites / 67 database integration tests skipped because no dedicated test database was selected. No database migrations, seed or bootstrap were run. The initial Node 22 attempt crashed during tests; the Node 24 sandbox run was blocked from binding localhost, and rerunning with approved local-port access passed. `git diff --check` passed. No deployment, Squarespace changes, DNS changes or infrastructure actions were performed.
