# Command Center — UI/UX Specification

> Companion to `COMMAND_CENTER_BLUEPRINT.md` (architecture, schema, stack) and `ROADMAP.md` (build order).
> This document defines **what the app looks like and how it behaves**. If this file and the blueprint disagree on visuals or interaction, this file wins. On data, schema and APIs, the blueprint wins.

---

## 1. Product Frame

**What it is:** a desktop cockpit where one human (the Operator) watches and steers a project that AI agents are actively working on. Agents write state through the MCP server; the app renders it live.

**Primary user:** a solo operator running several agents (Claude Code, sub-agents, external models) against one project.

**The three questions every screen must answer in under 3 seconds:**

1. Where is the project vs. plan? (on track / behind, how many days)
2. What is happening right now? (which agent is doing what)
3. What needs me? (tasks in Review, Blocked tasks, failed audits)

### Design principles

1. **Glanceable first, detailed on demand.** Dense summary on the surface; depth in the slide-out panel or modal.
2. **The Operator's attention is the scarce resource.** Anything needing a human decision (Review, Blocked) is visually louder than everything else.
3. **Live, never jumpy.** State changes animate in place (200ms); nothing reorders under the cursor while the user is interacting.
4. **Agents are first-class citizens.** Every task, log line and change shows *who* did it, with the agent's color.
5. **Keyboard-first.** Every action reachable without the mouse. Command palette is the escape hatch.
6. **Calm dark UI.** Low-contrast chrome, high-contrast data. Color is reserved for meaning (status, domain, agent).

---

## 2. Information Architecture

```
App Shell
├── Title bar (project name, sync status, theme, command palette trigger)
├── Tab bar  ── Swim Lane | Task Board | Agent Hub | Calendar | Terminal
├── View area (active tab)
│   └── Slide-out Detail Panel (milestone)   [Swim Lane, Task Board]
│   └── Task Detail Modal                    [anywhere a task is clicked]
├── Status bar (db path, agent count, webhook status, blocked/review counts)
└── Overlays: Command Palette, Toasts, Confirm dialogs, Settings
```

### Cross-view navigation rules

- Clicking a **milestone** anywhere → opens the Milestone Panel (480px slide-out). "View in Task Board" button inside it jumps to the Task Board with that milestone selected.
- Clicking a **task** anywhere → opens the Task Detail Modal.
- Clicking an **agent** chip anywhere → switches to Agent Hub with that agent filtered.
- Selected milestone (`selectedMilestoneId`) is global and persists across tabs.
- Active tab and theme persist across launches (electron-store or localStorage in renderer).

---

## 3. App Shell

### 3.1 Window

| Property | Value |
|---|---|
| Default size | 1400 × 900 |
| Minimum size | 1200 × 800 |
| Background | `--bg` (#0A0A10) — set on the BrowserWindow to avoid white flash |
| Frame | macOS: frameless with inset traffic lights; Windows/Linux: native frame. Title bar region is draggable (`-webkit-app-region: drag`), interactive controls inside it are `no-drag`. |

> The primary development machine is Windows. Verify native frame + custom top bar looks right there first.

### 3.2 Title bar (height 40px)

Left → right:

- App mark + **project name** (click to open project switcher/settings later; v1: plain text)
- **Schedule pill**: `ON TRACK` (green) / `AT RISK` (amber) / `BEHIND · 6d` (red). Derived from `project.schedule_status` + max drift.
- **Overall progress**: thin 96px bar + `42%` in mono.
- Spacer
- **Sync indicator**: green dot `Live` / amber pulsing dot `Syncing…` / red dot `Disconnected — retrying`. Tooltip shows last sync time.
- **Command palette** button (`Ctrl/Cmd+K` hint)
- **Theme toggle** (sun/moon)

### 3.3 Tab bar (height 44px)

- 5 tabs, left-aligned, icon + label (Lucide: `GanttChart`/`Timeline`, `LayoutGrid`, `Cpu`, `CalendarDays`, `Terminal`).
- Active tab: label `--text`, 2px accent underline that **slides** between tabs (Framer Motion `layoutId`).
- Badges on tabs (small pill, mono):
  - Task Board: count of **Review** tasks (amber) and **Blocked** (red) — shown only when > 0.
  - Agent Hub: count of **ACTIVE** agents (green dot + number).
  - Terminal: count of open sessions.
- Shortcuts: `Ctrl/Cmd+1…5` jump to tab; `Ctrl/Cmd+Tab` cycles.

### 3.4 Status bar (height 24px, mono 11px, `--muted`)

`command-center.db · WAL` · `Webhook :38120 ● running` · `Agents 3 active / 7` · `Review 2` · `Blocked 1` · right-aligned: app version.
Each segment is clickable (opens the relevant view/filter).

---

## 4. Design Tokens

Implement as CSS variables in `styles.css`, mapped into the Tailwind v4 `@theme` block. **Never hard-code hex values in components.**

### 4.1 Color — Dark (default)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0A0A10` | App background |
| `--surface` | `#111118` | Cards, panels, columns |
| `--surface-2` | `#16161F` | Hovered cards, inputs, popovers |
| `--surface-3` | `#1C1C28` | Active/pressed, selected rows |
| `--border` | `#1A1A2E` | Default borders |
| `--border-strong` | `#2A2A44` | Focus-adjacent, dividers on hover |
| `--muted` | `#9B9BAA` | Secondary text, icons |
| `--text` | `#FFFFFF` | Primary text |
| `--accent` | `#585CF0` | Primary actions, active tab, focus ring |
| `--accent-light` | `#8286FF` | Accent text/links on dark |
| `--success` | `#22C55E` | On track, Done |
| `--warning` | `#F59E0B` | Review, At risk |
| `--danger` | `#EF4444` | Behind, Blocked, errors |

### 4.2 Color — Light (blueprint does not define it; use this)

| Token | Value |
|---|---|
| `--bg` | `#F6F6FA` |
| `--surface` | `#FFFFFF` |
| `--surface-2` | `#F0F0F6` |
| `--surface-3` | `#E7E7F0` |
| `--border` | `#E1E1EC` |
| `--border-strong` | `#C9C9DA` |
| `--muted` | `#6B6B7B` |
| `--text` | `#0F0F18` |
| `--accent` | `#4549D6` |
| `--accent-light` | `#585CF0` |

Status colors stay the same hue; darken text-on-light variants by ~10% for contrast (verify ≥ 4.5:1).

### 4.8 Theme — Calm (light and dark, optional)

Source: the "CALM / SYSTEM" UI component study (operator-approved, 2026-10-13). The hex values in the study are exact; every other value is inferred from it and marked **(inferred)**. This theme is an **addition**: the default dark theme (§4.1) and the existing light theme (§4.2) stay. Settings → Appearance gains a fourth option, **Calm**, in milestone M13.2. Status colours (§4.3) keep their hue meaning in every theme.

| Token | Value | Source |
|---|---|---|
| `--bg` | `#FAF9F4` | Ivory (study) |
| `--surface` | `#FFFFFF` | study cards on ivory |
| `--surface-2` | `#F3F2EC` | (inferred) one step darker than ivory |
| `--surface-3` | `#ECEAE2` | (inferred) |
| `--border` | `#E4E1D8` | (inferred) between ivory and stone |
| `--border-strong` | `#D6D3C8` | Stone (study) |
| `--muted` | `#5E6B63` | (inferred) green-grey secondary text, ≈5.3:1 on ivory |
| `--text` | `#1B2A22` | (inferred) deep green-black, ≈15:1 on ivory |
| `--accent` | `#0F5132` | Forest (study) |
| `--accent-light` | `#2D7A52` | (inferred) hover state for accent |
| `--accent-soft` | `#B7D9C1` | Mint (study); tints, selected rows, soft fills only, never text |
| `--success` | `#176A3D` | (inferred) text-safe green, ≥4.5:1 as text and as a 10% tag tint on white and surface-2; distinct from accent by lightness (first pick `#1E7F4F` failed the tint case) |
| `--warning` | `#9A4507` | (inferred) darker than the §4.2 light override: tags tint their own colour 10% over the surface, and `#B45309` fell to 4.45:1 there |
| `--danger` | `#B42318` | (inferred) text-safe red |
| `--focus` | `#0F5132` | focus ring, 2px, 2px offset |

**Shape and elevation**

| Token | Value |
|---|---|
| `--radius-pill` | `999px` (buttons, inputs, tabs, switches, search) |
| `--radius-card` | `20px` (panels and cards on the calm theme only) |
| `--radius-inner` | `12px` (rows, menus, popovers) |
| `--shadow-card` | `0 1px 2px rgba(27,42,34,0.06), 0 8px 24px rgba(27,42,34,0.06)` |

Dense surfaces (Task Board columns, Swim Lane, activity feed, terminal) use `--border` instead of `--shadow-card`. Soft shadows on dense lists lose the edges that keep rows readable.

**Type**

| Role | Font | Notes |
|---|---|---|
| View titles and display numbers | Source Serif 4 (inferred), 18px / 500 | Serif for presence, used sparingly: view titles, the hero number on Planning and Calendar. Bundled offline via `@fontsource`. |
| Body, UI | Inter, 13px / 400 | unchanged from §4.5 |
| Labels | Inter, 11px / 600, uppercase, +0.12em | wider tracking than §4.5 because the study uses it; still 11px |
| IDs, timestamps, terminal | JetBrains Mono | unchanged |

**Components (from the study)**
- **Primary button:** `--accent` fill, `--bg` text, pill, arrow icon right-aligned. Hover `--accent-light`.
- **Secondary button:** `--surface` fill, `--border-strong` 1px border, pill, `--text`.
- **Search / input:** pill, `--surface` fill, `--border` 1px, search icon left, filter icon right.
- **Switch:** 44×24 pill, on = `--accent` track with white knob, off = `--surface-3` track.
- **Checkbox:** 18px, 6px radius, checked = `--accent` fill with white tick.
- **Segmented tabs:** pill group, active segment `--accent` fill with `--bg` text.
- **Progress bar:** 6px tall pill, track `--surface-3`, fill `--accent`.
- **Notification:** `--surface` card, icon disc in `--accent-soft` with `--accent` tick, title 600, body `--muted`.

**Domain colours (both Calm modes):** `--domain-1..10` cycle amber, violet and blue; light Calm uses `#D97706`, `#7C5CD6`, `#2F6FB0` (inferred), Calm Dark the three values in its table. `--on-accent` is the label colour on any accent fill (ivory in light Calm, `#0F3A25` in Calm Dark; white in the default themes).

**Tags and chips:** the light themes (§4.2, Calm) mix a tag's own hue 55% with `--text` for the tag's text (`--tag-ink`), because palette hues such as orange and cyan are under 3:1 on ivory. Agent-avatar initials and swim-lane phase labels use `--text`; the hue stays on the ring and the tint.

**Rules for this theme**
- Small captions in the study are light grey and fail contrast. In this theme no text below 4.5:1 on its background, and captions use `--muted`, never a lighter grey.
- `--accent-soft` (mint) is never a text colour.
- The forest accent is not the success colour. Success uses `--success` and always carries a label or icon (§4.4: colour is never the only signal).
- Verify with the `test/a11y-tokens` contrast test (add the calm tokens to it, same thresholds as §4.2).

**Calm Dark (dark mode of Calm, operator-approved 2026-10-13, milestone M13.3)**

Calm is one theme with two modes. The roles invert: Mint becomes the accent, forest-black becomes the background, ivory becomes the text. Values below are **(inferred)** from the Calm study and the operator-approved mock; contrast ratios were computed, not eyeballed.

| Token | Value | Notes |
|---|---|---|
| `--bg` | `#0C1410` | forest-black |
| `--surface` | `#121C17` | columns, panels |
| `--surface-2` | `#18241E` | cards, rows |
| `--surface-3` | `#202F27` | tracks, avatar discs |
| `--border` | `#243329` | |
| `--border-strong` | `#355043` | |
| `--muted` | `#A3B5A9` | ≈7.4:1 on `--bg` |
| `--text` | `#EEF0E6` | ivory, ≈13.9:1 on `--bg` |
| `--accent` | `#B7D9C1` | Mint, ≈12.2:1 on `--bg`; may be text in dark mode |
| `--on-accent` | `#0F3A25` | label on an accent fill |
| `--accent-soft` | `rgba(183,217,193,0.14)` | tints, selected rows |
| `--success` | `#6FC48E` | saturated green, always with a ✓ icon or label |
| `--warning` | `#E6B04F` | |
| `--danger` | `#EE7B6F` | |
| `--focus` | `#B7D9C1` | 2px ring, 2px offset |
| domain dots | amber `#E6B04F`, violet `#B79BEA`, blue `#7FB6E6` | no green domain colour in Calm Dark, so green only ever means accent or success |

Dark-mode component rules: active tab and primary button are a Mint fill with `--on-accent` text; secondary buttons are outlined with `--border-strong`; Review cards get an amber border and tint, Blocked cards a red border; Done cards are dimmed with a ✓; shadows are off (borders only); `color-scheme: dark` for native controls; the terminal uses the dark ANSI palette. Shape, type and tag rules are the same as light Calm, except `--tag-ink` is 100% (hues are already text-safe on dark). Selected through Settings → Appearance (Calm → Light / Dark) and the title-bar cycle; `system` maps Calm to its light or dark mode from the OS.

### 4.3 Status → color map (single source of truth)

| Status | Label | Color |
|---|---|---|
| `todo` | TO DO | `--muted` `#9B9BAA` |
| `in_progress` | IN PROGRESS | `--accent` `#585CF0` |
| `review` | REVIEW | `--warning` `#F59E0B` |
| `done` | DONE | `--success` `#22C55E` |
| `blocked` | BLOCKED | `--danger` `#EF4444` |

Priority: `P0` red, `P1` amber, `P2` muted, `P3` muted/dim. Shown as a small mono pill.

### 4.4 Domain and agent colors

- Domain palette (assigned in order on creation, user can override): `#f59e0b #22c55e #8286FF #ef4444 #14B8A6 #EC4899 #F97316 #6366F1 #06B6D4 #9B9BAA`
- Agent color comes from `agents.color`. Default `#9B9BAA`. If two agents share a color, the avatar also shows initials so they remain distinguishable.
- **Color is never the only signal.** Status also has an icon/label; agents have initials.

### 4.5 Typography

| Role | Font | Size / weight |
|---|---|---|
| Body, UI | Inter | 13px / 400 (the app is dense; 13px base, not 16) |
| Labels, column headers | Inter | 11px / 600, uppercase, +0.06em tracking |
| Section titles | Inter | 14px / 600 |
| View titles | Inter | 18px / 600 |
| Numbers, IDs, timestamps, terminal, code | JetBrains Mono | 12px / 400–500 |
| Tags/badges | Inter or Mono | 10px / 600 |

Bundle fonts locally (no CDN) — the app must work offline. Enable `font-variant-numeric: tabular-nums` on all numbers.

### 4.6 Spacing, radius, elevation

- Spacing scale: 4 / 8 / 12 / 16 / 24 / 32. Card padding 12. Panel padding 16–20.
- Radius: 6 (inputs, chips), 8 (cards), 12 (modals/panels), 999 (pills).
- Elevation: borders do the work. Shadows only on popovers/modals: `0 8px 32px rgba(0,0,0,.45)`. Modal backdrop: `rgba(5,5,10,.6)` + `backdrop-filter: blur(6px)`.

### 4.7 Motion

| Interaction | Spec |
|---|---|
| Panel slide-in | `transform: translateX`, 200ms ease-out |
| Modal open | fade + scale .98→1, 150ms |
| Card moves columns | Framer `layout` spring (stiffness 500, damping 40) |
| Live data update | affected element flashes `--surface-3` → base over 600ms (never toast spam) |
| Progress rings | stroke-dashoffset transition 400ms |
| Tab underline | shared `layoutId`, 200ms |
| Reduced motion | Respect `prefers-reduced-motion`: disable layout springs and flashes, keep opacity fades only |

---

## 5. Shared Components

Build these once in `renderer/components/ui/` (shadcn/ui as base) before building any view.

| Component | Spec |
|---|---|
| **Tag / Badge** | 10px, pill, text in the semantic color, background same color at 10% opacity, 1px border at 20%. |
| **StatusDot** | 8px circle; `in_progress` and ACTIVE agents pulse (1.6s). |
| **ProgressRing** | SVG, props: `size`, `value (0–1)`, `color`, `label` (e.g. `6/11`). Track `--border`, stroke round-capped. |
| **AgentAvatar** | 20/24px circle in agent color @ 20% bg, 1px border in full color, 2-letter initials. Type icon overlay for `human`/`external`. |
| **AssigneeChip** | Avatar + name (truncate). Unassigned → dashed outline "Unassigned". |
| **DomainTag** | Domain color dot + label. |
| **PriorityPill** | `P0…P3`, mono. |
| **EmptyState** | Icon (48px, muted), title, one-line help, optional primary action. Every list/column/lane has one. |
| **Skeleton** | Shimmer blocks matching final layout; used while `loading`. |
| **Toast** | Bottom-right, max 3 stacked, 4s auto-dismiss, errors persist until dismissed. |
| **ConfirmDialog** | For destructive actions only (`reset_task`, delete). Default focus on Cancel. |
| **SlidePanel** | 480px, right-anchored, closes on `Esc` / backdrop click / close button. Does not block the view behind it (no backdrop dimming in Swim Lane; light dim elsewhere). |
| **Modal** | Backdrop blur, `z-50`, focus-trapped, `Esc` closes, backdrop click closes (the blueprint’s own LESSONS_LEARNED example is exactly this bug — test it). |
| **CommandPalette** | `Ctrl/Cmd+K`. Fuzzy search over: tasks (by id/label), milestones, agents, plus actions (Go to tab, Toggle theme, New terminal, Copy context string, Create task). |
| **Tooltip** | 500ms delay, 11px, `--surface-2`. |

---

## 6. View Specs

### 6.1 Swim Lane (default tab)

**Purpose:** strategic timeline — "are we on schedule?"

**Layout** (from blueprint Phase 4, constants preserved):

```
WEEK_W 100 · LANE_H 200 · LABEL_W 140 · HEADER_H 44 · NODE_R 20 · KEY_NODE_R 26 · PANEL_W 480
```

- **Header row (sticky top):** `W1 / 01-01` per week; phase bands rendered behind the header in a second 20px row with phase title and tint.
- **Left label column (sticky left):** one row per domain: color bar (6px), domain name, `done/total` tasks in mono.
- **Canvas:** horizontally scrollable, vertically scrollable if > 4 lanes. Both sticky axes stay visible.
- **Phase bands:** full-height translucent rectangles in `phase.color` @ 6%.
- **NOW marker:** 1.5px accent vertical line at fractional week position, with a "NOW" flag on top. On first load and via the "Today" button, auto-scroll so NOW sits at ~30% from the left.
- **Milestone node:** circle R20, `ProgressRing` inside showing `done/total`; domain-colored ring. Label below (2 lines max, truncated), week-date in mono underneath.
- **Status styling:** all done → filled green with check; has blocked task → red ring + `!`; in review → amber pulse.
- **Drift visualization:** if `drift_days ≠ 0`: ghost node (dashed outline, 40% opacity) at planned position, solid node at actual/forecast position, thin dashed connector, and a drift badge `+3d` (red) / `−1d` (green).
- **Dependencies:** curved connectors between milestones with `dependencies` (arrowhead). Dim by default; highlight (accent, 2px) the full upstream/downstream chain on hover of a node.
- **Adjacent connection lines:** subtle solid line between consecutive milestones in the same lane.
- **Key milestones:** diamond R26 with label flag ("Beta Release", "V1.0 Launch"), rendered above lanes in a dedicated "Key" row so they never collide with lane nodes.
- **Zoom:** `Ctrl+scroll` or +/− buttons scales `WEEK_W` between 60 and 160. Keep NOW stable under zoom.

**Interactions**

| Action | Result |
|---|---|
| Click node | Open Milestone Panel (selected node gets accent halo) |
| Hover node | Tooltip: title, planned→actual dates, progress, drift |
| Double-click node | Jump to Task Board filtered to that milestone |
| Drag horizontally on empty canvas | Pan |
| Right-click node | Context menu: Open, View tasks, Add task, Set dates… |
| `←/→` with node focused | Move focus to prev/next milestone in lane; `Enter` opens |

**Milestone Panel (480px)**

1. Header: title, domain tag, phase tag, week, close button.
2. Dates block: planned start/end, actual start/end, drift badge.
3. Progress: ring + counts per status (mini stacked bar).
4. Dependencies: list with status of each (click to navigate).
5. Task list: grouped by status; each row is a clickable task (opens Task Detail Modal). Inline "+ Add task".
6. Notes: reverse-chronological list from `milestones.notes`; add-note input at top.

**States:** *Empty* — "No milestones yet. Hydrate this project with a manifesto and roadmap, or ask an agent to call `create_milestone`." with a "Copy hydration prompt" button. *Loading* — skeleton lanes. *Error* — inline banner with Retry.

### 6.2 Task Board

**Purpose:** tactical flow — "what's moving, what's stuck, what needs me?"

**Structure (top → bottom):**

1. **ContextBar** (56px): milestone carousel — `◀ [ring 6/11] M3 · Auth & Onboarding · Week 4 · Phase B ▶` + "All milestones" toggle. Arrow keys / `[` `]` switch milestone.
2. **FilterBar** (40px): segmented `All | My Tasks | Agent Tasks | Blocked`, search input (`/` to focus), priority multi-select, assignee multi-select, "Clear" when any filter active.
3. **Board:** 5 columns, equal width, horizontally scrollable below 1200px.

**Column:** sticky header = colored dot + LABEL + count (mono) + "+" quick-add (To Do column only). Body scrolls independently. Column background `--surface`, drop-target highlight = 2px dashed column color + 4% tint.

**Column order:** TO DO · IN PROGRESS · REVIEW · DONE · BLOCKED. The Review and Blocked columns get a subtle attention treatment (header count pill filled when > 0).

**TaskCard** (min-height 84px):

```
┌──────────────────────────────────────┐
│ ● DomainTag                     [P1] │
│ Implement OAuth callback handler     │  ← 2 lines max, 13px/500
│ TASK-014 · ⛓ 2 deps · 🔒 blocked      │  ← mono 11px muted
│ [AG] claude-code      ▸ 3/5 criteria │
└──────────────────────────────────────┘
```

- Left 3px border in the status color.
- In-progress cards: animated running indicator + elapsed time since `started`.
- Blocked cards: red reason line (`blocked_reason`, 1 line).
- Review cards: amber "Awaiting your review" footer with inline **Approve** / **Reject** icon buttons (Reject opens a reason popover — required, becomes the `lessons_learned` entry).
- Hover reveals quick-actions: open, copy task id, copy `TASK_CONTEXT` command.
- Cards with unmet `depends_on` show a lock; dragging them to In Progress prompts "Dependencies incomplete — start anyway?".

**Drag & drop** (@dnd-kit, PointerSensor 5px, KeyboardSensor): follows the blueprint's drop rules. Additional UX rules:

- Drag overlay is a rotated 2° copy of the card with elevated shadow; origin slot shows a dashed placeholder.
- Illegal transitions (see state machine below) show the column in "not allowed" style (red dashed, cursor not-allowed) and snap the card back with a toast explaining why.
- Dropping into **Blocked** opens a small popover to enter a reason (required, default focus). Dropping into **Done** from anywhere other than Review asks for confirmation ("Skip review?").
- Dropping into **Review → In Progress** (reject) opens the rejection reason popover.
- All moves are **optimistic** and roll back with a toast on DB failure.
- Within-column ordering: priority, then `updated_at`. Manual reordering is out of scope for v1.

**State machine as UX rules** (blueprint transitions)

| From → To | Drag allowed? | Extra UI |
|---|---|---|
| todo → in_progress | Yes | Sets `last_run_id` |
| in_progress → review | Yes | Optional summary prompt |
| review → done | Yes | Equivalent to `approve_task` |
| review → in_progress | Yes | Reject reason **required** |
| any → blocked | Yes | Reason required |
| blocked → previous | Yes (unblock) | Return to the status it came from |
| todo → done / todo → review | Confirm | "Skip steps?" |

> Build note: "returns to previous state" requires remembering the pre-block status. Add a `blocked_from TEXT` column to `subtasks` (see ROADMAP decisions).

**TaskDetailModal** (near-full-screen, max 1100×720, centered)

- **Header:** task id (mono), editable title, status pill (dropdown = same transitions), priority, assignee, close.
- **Tabs:** `Details` | `History` | `Context` (adds the agent-facing view).
- **Details:** description/notes, acceptance criteria (checklist — checking is persisted and counts toward card `3/5`), constraints, context files (monospace list, click copies path), reference docs, dependencies (`depends_on` / `blocked_by`) with live status, execution mode + agent target, builder prompt (collapsible, mono, copy button).
- **History:** timeline from `agent_log` filtered to this task — avatar, action tag, description, relative time (absolute on hover); lessons-learned entries shown as amber "Rejected" cards with reason + fix.
- **Context:** the rendered `TASK_CONTEXT.md` preview, with "Copy" and "Open in terminal" (runs `command-center prepare --id …` in a new terminal session).
- **Footer actions** change with status: To Do → *Prepare*, *Start*; In Progress → *Complete*, *Block*; Review → *Approve*, *Reject*; Blocked → *Unblock*; any → *Reset* (confirm).
- Edits autosave on blur with a subtle "Saved" tick. Esc closes; unsaved edits are never lost (autosave).

**States:** *Empty column* — dashed outline with muted text ("Nothing here"); *Empty board* — "No tasks in this milestone" + Add task; *Filter yields nothing* — "No tasks match" + Clear filters.

### 6.3 Agent Hub

**Purpose:** "who is doing what, and what has happened?" Two-column layout: left fixed 340px, right fluid. Each column scrolls independently.

**Left column (stacked cards, 12px gap)**

1. **Connected Agents**
   - Tree: orchestrators on top, sub-agents indented 16px with a connector line. Collapse/expand chevron on orchestrators (state persisted).
   - Row: avatar, name, `ACTIVE` (green, pulsing) / `IDLE` (muted) / `ERROR` (red) badge, "2m ago" (live-updating), permission badges (max 3 then `+n`), mono `session_action_count`, `source_model` in a muted second line.
   - Click row → filters the Activity Feed to that agent. Right-click → "View tasks", "Copy agent id".
   - "ACTIVE" is derived: `last_action_at` within the last 5 minutes OR `status = 'active'`.
2. **Shared State**
   - DB path (mono, truncated middle, copy button), watcher status dot, counts: milestones, subtasks, log entries, "Last change 4s ago".
3. **Context Injection Preview**
   - Mono block: `WEEK 4, Phase: Build, Progress: 42%, Schedule: on_track, Blocked: 1`
   - **Copy** button (toast "Context copied"). The string updates live.
4. **Today's Summary**
   - Three stat tiles (Completed / In Progress / Blocked), then a contribution bar per agent (stacked horizontal bar, agent colors, legend).

**Right column**

1. **Activity Feed** (flex-1)
   - Filter tabs: `All | <one per agent> | Manual | System` (scrolls horizontally if many).
   - Search box (matches description, task id, action).
   - Day group headers: `TODAY`, `YESTERDAY`, then `Mon, Oct 5`. Sticky while scrolling.
   - Entry: avatar · **agent name** · action tag pill · description · target link (`TASK-014`, opens modal) · time (`14:32`). Tags are colored pills.
   - New entries slide in at the top with the flash highlight; if the user is scrolled down, show a "↑ 3 new" pill instead of jumping.
   - Virtualized list (500+ entries; DB query limit is 500, add "Load older" via `get_activity_feed` pagination).
2. **Agent Performance (this calendar week)**
   - Per-agent card: total actions (large mono number), tag breakdown as horizontal mini bars, comparison arrow vs. previous week (optional v1.1).

**States:** *No agents* — "No agents connected. Add the MCP server to Claude Code and it will register itself." + copyable MCP config snippet with the user's real `PROJECT_ROOT`. *No activity* — "Waiting for the first agent action…" with a live pulse.

### 6.4 Calendar

**Purpose:** "what did we actually finish, and when?"

- Header: `◀  Week 41 · Oct 5 – Oct 11 · 12 completed  ▶` + **Today** button + week/day-of-month picker (popover).
- 7 columns Mon–Sun (Mon start is the default; setting later). Column header = `Mon` + date number; today column header gets an accent bar and slightly lighter body.
- Chips stack per `completed_at` day, ordered by time. Chip: 3px domain-color left border, label (1 line truncated), DomainTag, green check, assignee avatar; hover shows full label + time.
- Click chip → Task Detail Modal.
- Day column footer: `n done`. Empty days show a faint "—".
- Optional header strip (v1.1): 12-week mini heat-map of completions for context.
- Weekends are visually dimmer but still functional.
- `←/→` change week, `T` jumps to today.

**States:** *No completions this week* — centered "Nothing completed this week" with prev-week link.

### 6.5 Terminal

**Purpose:** run Claude Code / operator CLI without leaving the app.

- **Top strip (40px):** session tabs (name, shell icon, close ×, "running"/"exited" dot), `+` new session split-button (default shell; dropdown: bash / zsh / powershell / cmd — only those detected on the OS), right side: **Clear**, **Split** (v1.1), font-size −/+.
- **Body:** xterm.js fills the remaining space, `FitAddon` re-fits on window resize and when the panel becomes visible (important: call `fit()` after tab switch — hidden xterm instances report 0 size). Web links addon on. Scrollback 10,000. Theme colors derived from tokens; cursor accent.
- **Persistence:** sessions survive tab switches (keep xterm instances mounted but hidden; do not kill PTYs on tab change). They are killed on close or app quit.
- **Default cwd:** the `PROJECT_ROOT` (not the home folder; blueprint says home — override this so `command-center …` and `claude` run in the project).
- **Quick actions bar** (collapsible, under the strip): chips that type (not auto-run) into the active session — `command-center status`, `command-center agents`, `claude`. Selecting a task in the app offers "Run prepare for TASK-014 here".
- **Shortcuts:** `Ctrl/Cmd+Shift+T` new session, `Ctrl/Cmd+W` close, `Ctrl+Shift+C/V` copy/paste (Windows/Linux), standard on macOS.
- **States:** *No sessions* — EmptyState with a "New Session" button and auto-spawn on first visit. *Exited process* — banner "Process exited (code 0). Restart" inside the pane. *PTY failure* (node-pty missing/mismatched build) — clear error with rebuild hint.

---

## 7. Cross-Cutting Behavior

### 7.1 Real-time sync

- Main process owns the SQLite connection. The renderer never opens the DB file.
- **Change detection:** `fs.watch` on a WAL-mode DB is unreliable (writes land in `-wal`). Implement detection by watching the `-wal` and main file **and** polling `PRAGMA data_version` every 500ms as the authoritative check; debounce bursts to 100ms.
- On change: main sends a `db:changed` event → renderer refetches (`db:getAll`) and diffs into the Zustand store; only changed entities re-render (use selectors + `React.memo` on cards).
- Sync indicator states: `Live` → `Syncing…` (during refetch) → `Disconnected` (watcher or DB error; auto-retry with backoff, show retry button).
- **Concurrent edit rule:** if the user is mid-drag or has an input focused on an entity that changes externally, defer that entity's visual update until interaction ends; show a small "updated by claude-code" notice in the modal.

### 7.2 Attention system

- Review and Blocked tasks raise: tab badges, status-bar counts, a OS-level notification (Electron `Notification`) when the window is unfocused and a task newly enters Review/Blocked (opt-in in settings, default on). Clicking the notification opens the task modal.
- Never use alert/confirm dialogs; use in-app components.

### 7.3 Keyboard map (global)

| Keys | Action |
|---|---|
| `Ctrl/Cmd+K` | Command palette |
| `Ctrl/Cmd+1…5` | Switch tab |
| `/` | Focus search in current view |
| `Esc` | Close top-most overlay |
| `T` | Today (Swim Lane / Calendar) |
| `[` `]` | Previous / next milestone |
| `?` | Shortcut cheat-sheet |
| `Ctrl/Cmd+,` | Settings |

### 7.4 Settings (modal, minimal v1)

Project root path (display + change), theme (dark/light/system), week start (Mon/Sun), notifications on/off, terminal default shell + font size, webhook status (+ port, + token regenerate), "Copy MCP config".

### 7.5 First-run experience

1. If no `PROJECT_ROOT`/DB: full-window welcome — pick project folder → creates `command-center.db`, seeds the `project` row.
2. Empty state on every view includes the **hydration prompt** (copyable) from the blueprint's post-build notice.
3. A one-time checklist card on Swim Lane: *Pick project folder ✓ · Add MCP server to Claude Code · Hydrate with manifesto + roadmap · Run your first task*. Dismissible.

### 7.6 Error & loading conventions

- Initial load: skeletons that mirror the final layout; never a blank window.
- Recoverable errors: inline banner at the top of the view with Retry. Mutations: toast + rollback.
- Fatal (DB cannot open, locked, corrupt): full-window error screen with the path, the error text, and "Choose another project" / "Retry".

### 7.7 Accessibility

- Contrast ≥ 4.5:1 for text, ≥ 3:1 for UI graphics in both themes.
- Visible focus ring: 2px `--accent` with 2px offset on all interactive elements.
- Drag & drop operable by keyboard (space to lift, arrows to move, space to drop) with live-region announcements.
- ARIA: tabs pattern for the tab bar, `role="status"` for the sync indicator, `aria-live="polite"` for toasts and the activity feed's new-entry pill.
- Minimum hit target 28×28px.
- Swim Lane SVG nodes are focusable with accessible names (`"M3 Auth, 6 of 11 tasks, 3 days behind"`).

### 7.8 Responsive behavior (desktop only)

| Width | Behavior |
|---|---|
| ≥ 1600 | Comfortable: wider Agent Hub columns, Board columns up to 340px |
| 1200–1599 | Default layout |
| < 1200 (window can't go below min but panels can) | Board scrolls horizontally; Milestone Panel overlays instead of pushing; Agent Hub left column collapses to icon rail |

---

## 8. Content & Microcopy

- Voice: terse, operational, no exclamation marks, no emoji.
- Dates: `Oct 8` for current year, `Oct 8, 2025` otherwise; relative times under 24h (`3m ago`), absolute on hover.
- IDs always mono, always copyable on click.
- Status labels UPPERCASE in headers, Sentence case in sentences.
- Destructive confirmations name the object: "Reset TASK-014? Its status, blockers and run history will be cleared."

---

## 9. Acceptance Checklist (use for QA of each view)

- [ ] Renders correctly with 0 items, 1 item, and 200 items.
- [ ] Skeleton on load, error state on failure, empty state with next action.
- [ ] Updating the DB from another process (MCP server / sqlite3 CLI) updates the view within 1s without a manual refresh.
- [ ] Every interactive element reachable and operable by keyboard; focus visible.
- [ ] Looks correct in dark and light theme.
- [ ] No hard-coded colors outside tokens/domain palette.
- [ ] No layout shift when data updates; nothing reorders under the cursor mid-interaction.
- [ ] Esc closes the top overlay; backdrop click closes modals.
- [ ] Works at 1200×800 minimum size.
- [ ] No console errors or React key warnings.
