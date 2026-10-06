/**
 * The docked sidebar's view: a pure renderer.
 *
 * Kept separate from both the compositor (`dock.ts`, which owns terminal
 * columns and cursor positioning) and the wiring (`index.ts`), so the layout can
 * be unit-tested by asserting on rendered text at an exact width and height.
 */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { relativeTime, type SessionRow, type WorkspaceRow } from "./data.ts";

export type SidebarEntry =
	| { kind: "workspace"; workspace: WorkspaceRow; expanded: boolean }
	| { kind: "session"; workspace: WorkspaceRow; session: SessionRow };

export interface SidebarNotice {
	text: string;
	tone: "info" | "warning" | "error";
}

export interface SidebarView {
	workspaces: readonly WorkspaceRow[];
	/** Workspace cwds whose sessions are shown. */
	expanded: ReadonlySet<string>;
	/** Index into `sidebarEntries(...)`. */
	selected: number;
	/** True while the sidebar owns the keyboard. */
	focused: boolean;
	notice?: SidebarNotice | null;
}

interface Seg {
	text: string;
	color?: ThemeColor;
	bold?: boolean;
}

/** Rows of chrome around the list: header, rule, hint. */
const CHROME_ROWS = 3;
/** Below this the session count is dropped so the title keeps room. */
const WIDE_META_COLUMNS = 34;

const HINTS_FOCUSED = [
	"↑↓ move · ⏎ switch · n new · o panel · esc",
	"↑↓ · ⏎ switch · n · o panel · esc",
	"↑↓ · ⏎ · n · o · esc",
] as const;

const HINTS_IDLE = ["ctrl+shift+s to navigate", "ctrl+⇧+s to navigate", "ctrl+⇧+s"] as const;

/** Flatten workspaces into the rows the sidebar draws. */
export function sidebarEntries(
	workspaces: readonly WorkspaceRow[],
	expanded: ReadonlySet<string>,
): SidebarEntry[] {
	const out: SidebarEntry[] = [];
	for (const workspace of workspaces) {
		const open = expanded.has(workspace.cwd);
		out.push({ kind: "workspace", workspace, expanded: open });
		if (!open) continue;
		for (const session of workspace.sessions) out.push({ kind: "session", workspace, session });
	}
	return out;
}

/** Slide a fixed-height window over the entries, keeping `selected` visible. */
export function windowStart(total: number, height: number, selected: number): number {
	if (total <= height) return 0;
	const half = Math.floor(height / 2);
	return Math.max(0, Math.min(selected - half, total - height));
}

export function renderSidebar(
	view: SidebarView,
	width: number,
	height: number,
	theme: Theme,
): string[] {
	const w = Math.max(12, Math.floor(width));
	const h = Math.max(1, Math.floor(height));
	const entries = sidebarEntries(view.workspaces, view.expanded);
	const chrome = h > CHROME_ROWS ? CHROME_ROWS : 0;
	const bodyRows = Math.max(1, h - chrome);
	const lines: string[] = [];

	if (chrome > 0) {
		lines.push(renderHeader(view, w, theme));
		lines.push(theme.fg("borderMuted", "─".repeat(w)));
	}

	const start = windowStart(entries.length, bodyRows, view.selected);
	if (entries.length === 0) {
		for (let i = 0; i < bodyRows; i += 1) {
			lines.push(i === 0 ? ` ${theme.fg("dim", "no sessions yet")}` : "");
		}
	} else {
		for (let i = 0; i < bodyRows; i += 1) {
			const entry = entries[start + i];
			if (!entry) {
				lines.push("");
				continue;
			}
			const index = start + i;
			lines.push(renderEntry(entry, view.focused && index === view.selected, w, theme));
		}
	}

	if (chrome > 0) lines.push(renderHint(view, w, theme));
	return lines;
}

function renderHeader(view: SidebarView, width: number, theme: Theme): string {
	const left = theme.style(" WORKSPACES", { fg: "accent", bold: true });
	const right = view.focused ? theme.fg("success", "● ") : "";
	return padBetween(left, right, width);
}

function renderHint(view: SidebarView, width: number, theme: Theme): string {
	const available = Math.max(1, width - 2);
	if (view.notice) {
		const color = view.notice.tone === "error" ? "error" : view.notice.tone === "warning" ? "warning" : "muted";
		return ` ${theme.fg(color, truncateToWidth(view.notice.text, available, "…"))}`;
	}
	const hints = view.focused ? HINTS_FOCUSED : HINTS_IDLE;
	const chosen = hints.find((hint) => visibleWidth(hint) <= available) ?? hints[hints.length - 1] ?? "";
	return ` ${theme.fg("dim", truncateToWidth(chosen, available, "…"))}`;
}

function renderEntry(entry: SidebarEntry, selected: boolean, width: number, theme: Theme): string {
	if (entry.kind === "workspace") {
		const workspace = entry.workspace;
		const meta = `(${workspace.sessions.length})`;
		const badges = `${workspace.branch ? ` ⟨${workspace.branch}⟩` : ""}${workspace.isCurrent ? " ●" : ""}${workspace.missing ? " ⚠" : ""}`;
		// Reserve the badges and the count so a deep path cannot push them off.
		const labelBudget = Math.max(6, width - 4 - visibleWidth(badges) - visibleWidth(meta) - 2);
		const segs: Seg[] = [
			{ text: ` ${entry.expanded ? "▾" : "▸"} `, color: "accent" },
			{
				text: truncateToWidth(workspace.label, labelBudget, "…"),
				color: workspace.isCurrent ? "accent" : "text",
				bold: true,
			},
		];
		if (workspace.branch) segs.push({ text: ` ⟨${workspace.branch}⟩`, color: "muted" });
		if (workspace.isCurrent) segs.push({ text: " ●", color: "success" });
		if (workspace.missing) segs.push({ text: " ⚠", color: "warning" });
		return paintRow(withRight(segs, { text: `${meta} `, color: "dim" }, width), width, selected, theme);
	}

	const session = entry.session;
	const meta =
		width >= WIDE_META_COLUMNS
			? `${relativeTime(session.modified)} · ${session.messageCount}`
			: relativeTime(session.modified);
	const titleBudget = Math.max(6, width - 6 - visibleWidth(meta) - 2);
	const segs: Seg[] = [
		{ text: "   " },
		{ text: session.isCurrent ? "● " : "○ ", color: session.isCurrent ? "success" : "muted" },
		{
			text: truncateToWidth(session.title, titleBudget, "…"),
			color: session.isCurrent ? "accent" : "text",
		},
	];
	if (session.missingCwd) segs.push({ text: " ⚠", color: "warning" });
	return paintRow(withRight(segs, { text: `${meta} `, color: "dim" }, width), width, selected, theme);
}

/** Pad a row to exactly `width` columns, highlighting it when selected. */
function paintRow(segs: Seg[], width: number, selected: boolean, theme: Theme): string {
	if (selected) {
		const plain = truncateToWidth(
			segs.map((seg) => seg.text).join(""),
			width,
			"…",
		);
		const padded = plain + " ".repeat(Math.max(0, width - visibleWidth(plain)));
		return theme.style(padded, { bg: "selectedBg", fg: "text", bold: true });
	}
	let remaining = width;
	let out = "";
	for (const seg of segs) {
		if (remaining <= 0) break;
		const piece = truncateToWidth(seg.text, remaining, "…");
		if (seg.bold) {
			out += theme.style(piece, seg.color ? { fg: seg.color, bold: true } : { bold: true });
		} else {
			out += seg.color ? theme.fg(seg.color, piece) : piece;
		}
		remaining -= visibleWidth(piece);
	}
	return out + " ".repeat(Math.max(0, remaining));
}

function withRight(segs: Seg[], right: Seg, width: number): Seg[] {
	const leftWidth = segs.reduce((total, seg) => total + visibleWidth(seg.text), 0);
	const gap = Math.max(2, width - leftWidth - visibleWidth(right.text));
	return [...segs, { text: " ".repeat(gap) }, right];
}

function padBetween(left: string, right: string, width: number): string {
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	if (leftWidth + rightWidth <= width) {
		return left + " ".repeat(width - leftWidth - rightWidth) + right;
	}
	if (rightWidth >= width) return truncateToWidth(right, width, "", true);
	return truncateToWidth(left, width - rightWidth, "…", true) + right;
}
