# Vespera Design System (`DESIGN.md`)

Updated: 2026-11-24

## 1. Visual Direction & Brand Identity

**Vespera** uses a matte **Carbon Bento** dark design system built for calm daily creator publishing operations. It eliminates noisy 7-column dense walls, oversized hero banners, and legacy desktop chrome in favor of rounded `18px` bento containers, crisp `1px` inner-lit borders, electric cobalt active highlights, authentic multi-color social vector icons, and clear `9:16` portrait video thumbnails.

### Brand Mark & Typography Lockup
- **Logo Mark (V4 Architectural 3-Slice V):** Rounded dark surface square (`#1B202C` -> `#10131B`) housing three tapered diagonal slices forming a layered geometric **V**: primary cobalt-blue descending left slice (`#60A5FA` -> `#2563EB`), recessed inner slate slice (`#7B9ACC` -> `#4A6593`), crisp white ascending center slice (`#FFFFFF` -> `#E2E8F0`), and outer silver-blue slice (`#A8C1E8` -> `#647EB0`). Canonical assets: `web/public/vespera-icon.svg` and `docs/vespera-logo.svg`.
- **Wordmark Typography (V2 Sleek Geometric Sans):** `Plus Jakarta Sans` at weight `500`, tight `-0.025em` tracking, rendered clean in `#F8FAFC`.

## 2. Color Tokens (Dark Default + Light Mode Parity)

### Dark Mode (`:root[data-theme="dark"]` / default)
- Canvas background: `#0D0E12` (`--bg-canvas`)
- Sidebar / header chrome: `#101218` (`--bg-sidebar`)
- Primary bento surface: `#15171C` (`--bg-surface`)
- Subcard / control fill: `#1B1E26` (`--bg-elevated`)
- Hover surface: `#222631` (`--bg-hover`)
- Hairline border: `rgba(255, 255, 255, 0.08)` (`--border-subtle`)
- Focus / active border: `rgba(255, 255, 255, 0.16)` (`--border-strong`)
- Primary text: `#F8FAFC` (`--text-primary`)
- Secondary text: `#A1A8B8` (`--text-secondary`)
- Muted metadata text: `#6F778A` (`--text-muted`)
- Brand accent: `#3B82F6` (`--accent-primary`, Electric Cobalt)
- Accent hover: `#60A5FA` (`--accent-hover`)

### Light Mode (`:root[data-theme="light"]`)
- Canvas background: `#F3F5F9`
- Primary bento / sidebar surface: `#FFFFFF`
- Subcard / input fill: `#F1F4F9`
- Hover surface: `#E5EAF3`
- Hairline border: `rgba(15, 23, 42, 0.09)`
- Focus / active border: `rgba(15, 23, 42, 0.18)`
- Primary text: `#0F172A`
- Secondary text: `#475569`
- Muted text: `#64748B`
- Brand accent: `#2563EB`

### Semantic Status Palette
- Published / Verified Signed In: `#10B981`
- Scheduled: `#38BDF8`
- Queued / Draft / Waiting: `#F59E0B`
- Running: `#3B82F6`
- Needs Login / Action / Failed: `#F43F5E`

## 3. Typography & Numeric Discipline

- **Wordmark:** `"Plus Jakarta Sans", "Inter", system-ui, sans-serif`
- **UI Sans:** `"Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
- **Monospace / Telemetry:** `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace`
- Apply `font-variant-numeric: tabular-nums` across KPI readouts, timestamps, file sizes, bar values, and tables.

## 4. Bento Architecture & Views

- **Grouped Navigation Rail (`228px` expanded, `74px` collapsed, slide-in drawer below `md`):**
  - `MAIN MENU`: Overview, Calendar, Queue, Analytics
  - `CHANNELS`: Channels & Connect
  - `SYSTEM`: Automations, API & MCP
  - Top bar includes working `⌘K` / `Ctrl+K` Command Search Modal, workspace scope switcher, theme switch, and refresh control.
- **Overview (Default Home):**
  - Hero Reach & Output bento with primary CTA buttons and `Connected Platforms` `2x3` sub-cards using authentic multi-color SVG social icons.
  - `Publishing Overview` 7-day bar chart with interactive day selection and glowing cobalt active bar.
  - `Channel Release Readiness` progress cards and calm 5-row `Upcoming Releases` list with `9:16` covers.
- **Calendar (Grouped Episode Agenda):**
  - Groups multi-platform campaign jobs per `(channelId, targetDate, episode)` into one readable bento card with `9:16` thumbnail and clickable platform status chips inside a responsive `1 -> 2 -> 3` column grid plus optional `Month` grid.
- **Channels & Connect + Dedicated `/connect` App Route:**
  - Quick platform icon bar, wrapped workspace cards (zero horizontal clipping at `1024px`, `1280px`, `1440px`), and a standalone frameless `/connect` web view.

## 5. Motion, Accessibility & Verification Checklist

- Smooth `150ms cubic-bezier(0.16, 1, 0.3, 1)` transitions with full `@media (prefers-reduced-motion: reduce)` disable rule.
- Keyboard `Escape` dismisses drawer, command search, and modals; explicit `aria-label` on all icon buttons.
- Zero horizontal overflow (`scrollWidth <= innerWidth`) verified visually at `1440x900`, `1280x800`, `1024x768`, `980x720` (`/connect`), and `390x844` (mobile).
