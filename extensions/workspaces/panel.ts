/**
 * The /ws sidebar: a toggleable right-anchored panel that lists workspaces
 * (grouped by working directory) and the sessions inside them, and lets you
 * switch, create, rename, and delete without leaving the keyboard.
 *
 * The panel is pure UI. It never switches sessions itself -- it resolves to a
 * PanelAction which the caller performs, because only a command context may
 * call switchSession().
 */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import {
	abbreviatePath,
	expandHome,
	listDirectories,
	parentDirectory,
	relativeTime,
	type DirectoryEntry,
	type SessionRow,
	type WorkspaceRow,
} from "./data.ts";

export type PanelAction =
	| { type: "cancel" }
	| { type: "switch"; sessionPath: string }
	| { type: "new-session"; cwd: string };

export interface PanelDeps {
	theme: Theme;
	tui: TUI;
	currentCwd: string;
	workspaces: WorkspaceRow[];
	/** Reload the workspace model after a rename or delete. */
	reload: () => Promise<WorkspaceRow[]>;
	/** Persist a new display name; returns an error message on failure. */
	rename: (sessionPath: string, name: string) => { ok: boolean; error?: string };
	/** Delete a session file; returns an error message on failure. */
	remove: (sessionPath: string) => Promise<{ ok: boolean; method?: string; error?: string }>;
	done: (action: PanelAction) => void;
	initialFilter?: string;
}

interface Seg {
	text: string;
	color?: ThemeColor;
	bold?: boolean;
}

type Entry =
	| { kind: "workspace"; workspace: WorkspaceRow; expanded: boolean }
	| { kind: "session"; workspace: WorkspaceRow; session: SessionRow };

type FolderRow =
	| { kind: "create"; path: string }
	| { kind: "jump"; path: string }
	| { kind: "parent"; path: string }
	| { kind: "dir"; entry: DirectoryEntry };

type Mode = "list" | "rename" | "confirm-delete" | "folder";

const MIN_BODY_ROWS = 6;
const MAX_BODY_ROWS = 18;
/** Lines the panel spends on chrome (borders, separators, filter, hints). */
const CHROME_ROWS = 8;

export class WorkspacePanel implements Component {
	private readonly theme: Theme;
	private readonly tui: TUI;
	private readonly currentCwd: string;
	private readonly reload: () => Promise<WorkspaceRow[]>;
	private readonly rename: PanelDeps["rename"];
	private readonly remove: PanelDeps["remove"];
	private readonly done: PanelDeps["done"];

	private workspaces: WorkspaceRow[];
	private expanded = new Set<string>();
	private filter: string;
	/**
	 * True while printable keys extend the filter instead of firing actions.
	 * Entered with `/` (or by an initialFilter), left with Esc/Ctrl+U, so the
	 * single-keypress actions below stay unambiguous.
	 */
	private searching: boolean;
	private mode: Mode = "list";
	private selected = 0;
	private scroll = 0;
	private notice?: { text: string; tone: "info" | "error" };

	private renameTarget?: SessionRow;
	private renameValue = "";

	private deleteTarget?: SessionRow;

	private folderPath: string;
	private folderRows: FolderRow[] = [];
	private folderSelected = 0;
	private folderScroll = 0;
	private folderFilter = "";

	constructor(deps: PanelDeps) {
		this.theme = deps.theme;
		this.tui = deps.tui;
		this.currentCwd = deps.currentCwd;
		this.workspaces = deps.workspaces;
		this.reload = deps.reload;
		this.rename = deps.rename;
		this.remove = deps.remove;
		this.done = deps.done;
		this.filter = deps.initialFilter ?? "";
		this.searching = this.filter.length > 0;
		this.folderPath = deps.currentCwd || expandHome("~");

		for (const workspace of this.workspaces) {
			if (workspace.isCurrent || workspace.sessions.length === 0) this.expanded.add(workspace.cwd);
		}
	}

	// ---------------------------------------------------------------- rendering

	render(width: number): string[] {
		const innerW = Math.max(24, width - 2);
		const bodyRows = this.bodyRows();
		const lines: string[] = [];

		if (this.mode === "folder") {
			lines.push(this.renderFolderHeader(innerW));
			lines.push(this.separator(innerW));
			lines.push(...this.renderFolderBody(innerW, bodyRows));
			lines.push(this.separator(innerW));
			lines.push(this.renderHints(innerW, FOLDER_HINTS));
			return this.box(lines, width, "New session");
		}

		lines.push(this.renderFilterLine(innerW));
		lines.push(this.separator(innerW));
		lines.push(...this.renderListBody(innerW, bodyRows));
		lines.push(this.separator(innerW));
		lines.push(this.renderHints(innerW, this.mode === "rename" ? RENAME_HINTS : LIST_HINTS));
		return this.box(lines, width, "Workspaces");
	}

	private bodyRows(): number {
		const rows = this.tui.terminal?.rows ?? 32;
		return Math.max(MIN_BODY_ROWS, Math.min(MAX_BODY_ROWS, rows - CHROME_ROWS));
	}

	private box(lines: string[], width: number, title: string): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const out: string[] = [];
		const titleStr = truncateToWidth(` ${title} `, innerW);
		const titleW = visibleWidth(titleStr);
		const left = "─".repeat(Math.max(0, Math.floor((innerW - titleW) / 2)));
		const right = "─".repeat(Math.max(0, innerW - titleW - left.length));
		out.push(th.fg("border", `╭${left}`) + th.fg("accent", titleStr) + th.fg("border", `${right}╮`));
		for (const line of lines) {
			out.push(th.fg("border", "│") + truncateToWidth(line, innerW, "…", true) + th.fg("border", "│"));
		}
		out.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
		return out;
	}

	private separator(innerW: number): string {
		return this.theme.fg("borderMuted", "─".repeat(innerW));
	}

	/** Pad plain segments to a fixed width, applying a selected-row background. */
	private paint(segs: Seg[], width: number, selected: boolean): string {
		const th = this.theme;
		if (selected) {
			const plain = truncateToWidth(
				segs.map((seg) => seg.text).join(""),
				width,
				"…",
			);
			const padded = plain + " ".repeat(Math.max(0, width - visibleWidth(plain)));
			return th.style(padded, { bg: "selectedBg", fg: "text", bold: true });
		}
		let remaining = width;
		let out = "";
		for (const seg of segs) {
			if (remaining <= 0) break;
			const piece = truncateToWidth(seg.text, remaining, "…");
			out += seg.color ? th.fg(seg.color, piece) : piece;
			remaining -= visibleWidth(piece);
		}
		return out;
	}

	private withRight(segs: Seg[], right: Seg, innerW: number): Seg[] {
		const leftWidth = segs.reduce((total, seg) => total + visibleWidth(seg.text), 0);
		const gap = Math.max(2, innerW - leftWidth - visibleWidth(right.text));
		return [...segs, { text: " ".repeat(gap) }, right];
	}

	private renderFilterLine(innerW: number): string {
		const th = this.theme;
		if (this.mode === "rename") {
			const label = th.fg("accent", "rename ");
			return ` ${label}${truncateToWidth(this.renameValue, innerW - 9, "…")}${th.fg("dim", "▏")}`;
		}
		if (this.mode === "confirm-delete") {
			return ` ${th.fg("error", `delete "${truncateToWidth(this.deleteTarget?.title ?? "", innerW - 12, "…")}"? (y/n)`)}`;
		}
		if (this.filter) {
			return ` ${th.fg("muted", "⌕ ")}${truncateToWidth(this.filter, innerW - 4, "…")}${th.fg("dim", "▏")}`;
		}
		if (this.searching) {
			return ` ${th.fg("muted", "⌕ ")}${th.fg("dim", "▏")}`;
		}
		return ` ${th.fg("muted", "⌕ ")}${th.fg("dim", "/ to search")}`;
	}

	private renderHints(innerW: number, hints: readonly string[]): string {
		const th = this.theme;
		if (this.notice) {
			return ` ${th.fg(this.notice.tone === "error" ? "error" : "warning", truncateToWidth(this.notice.text, innerW - 2, "…"))}`;
		}
		const avail = innerW - 2;
		const chosen = hints.find((hint) => visibleWidth(hint) <= avail) ?? hints[hints.length - 1] ?? "";
		return ` ${th.fg("dim", truncateToWidth(chosen, avail, "…"))}`;
	}

	private renderListBody(innerW: number, bodyRows: number): string[] {
		const entries = this.entries();
		const start = this.windowStart(entries.length, bodyRows, this.selected, "list");
		const lines: string[] = [];
		for (let i = 0; i < bodyRows; i += 1) {
			const entry = entries[start + i];
			if (!entry) {
				lines.push("");
				continue;
			}
			lines.push(this.renderEntry(entry, start + i === this.selected, innerW));
		}
		return lines;
	}

	private renderEntry(entry: Entry, selected: boolean, innerW: number): string {
		if (entry.kind === "workspace") {
			const workspace = entry.workspace;
			const count = workspace.sessions.length;
			const meta = count === 1 ? "1 session" : `${count} sessions`;
			const badges = `${workspace.branch ? ` ⟨${workspace.branch}⟩` : ""}${workspace.isCurrent ? " ●" : ""}${workspace.missing ? " ⚠ missing" : ""}`;
			// Reserve room for the badges and the count so a deep path cannot push
			// them off the row (paint() would otherwise truncate the right segment).
			const labelBudget = Math.max(8, innerW - 4 - visibleWidth(badges) - visibleWidth(meta) - 2);
			const segs: Seg[] = [
				{ text: ` ${entry.expanded ? "▾" : "▸"} `, color: "accent" },
				{ text: truncateToWidth(workspace.label, labelBudget, "…"), color: workspace.isCurrent ? "accent" : "text", bold: true },
			];
			if (workspace.branch) segs.push({ text: ` ⟨${workspace.branch}⟩`, color: "muted" });
			if (workspace.isCurrent) segs.push({ text: " ●", color: "success" });
			if (workspace.missing) segs.push({ text: " ⚠ missing", color: "warning" });
			const right: Seg = { text: `${meta} `, color: "dim" };
			return this.paint(this.withRight(segs, right, innerW), innerW, selected);
		}

		const session = entry.session;
		const meta = `${relativeTime(session.modified)} · ${session.messageCount}`;
		const titleBudget = Math.max(8, innerW - 8 - visibleWidth(meta) - 2);
		const segs: Seg[] = [
			{ text: "    " },
			{ text: session.isCurrent ? "● " : "○ ", color: session.isCurrent ? "success" : "muted" },
			{ text: truncateToWidth(session.title, titleBudget, "…"), color: session.isCurrent ? "accent" : "text" },
		];
		if (session.missingCwd) segs.push({ text: " ⚠", color: "warning" });
		const right: Seg = { text: `${meta} `, color: "dim" };
		return this.paint(this.withRight(segs, right, innerW), innerW, selected);
	}

	private renderFolderHeader(innerW: number): string {
		const th = this.theme;
		if (this.folderFilter) {
			return ` ${th.fg("muted", "⌕ ")}${truncateToWidth(this.folderFilter, innerW - 4, "…")}${th.fg("dim", "▏")}`;
		}
		return ` ${th.fg("accent", truncateToWidth(abbreviatePath(this.folderPath), innerW - 2, "…"))}`;
	}

	private renderFolderBody(innerW: number, bodyRows: number): string[] {
		const rows = this.folderRows;
		const start = this.windowStart(rows.length, bodyRows, this.folderSelected, "folder");
		const lines: string[] = [];
		for (let i = 0; i < bodyRows; i += 1) {
			const row = rows[start + i];
			if (!row) {
				lines.push("");
				continue;
			}
			lines.push(this.renderFolderRow(row, start + i === this.folderSelected, innerW));
		}
		return lines;
	}

	private renderFolderRow(row: FolderRow, selected: boolean, innerW: number): string {
		const th = this.theme;
		let segs: Seg[];
		switch (row.kind) {
			case "create":
				segs = [
					{ text: " ✓ ", color: "success" },
					{ text: "Start a session in this folder", color: "success", bold: true },
				];
				break;
			case "jump":
				segs = [
					{ text: " → ", color: "accent" },
					{ text: `Go to ${abbreviatePath(row.path)}`, color: "accent" },
				];
				break;
			case "parent":
				segs = [
					{ text: " ↑ ", color: "muted" },
					{ text: "..", color: "muted" },
				];
				break;
			default:
				segs = [
					{ text: "   " },
					{ text: row.entry.name, color: "text" },
				];
				break;
		}
		return this.paint(this.withRight(segs, { text: "" }, innerW), innerW, selected);
	}

	/**
	 * Slide a fixed-height window over a list, keeping `selected` visible.
	 * Both the list and the folder browser share this so they scroll alike.
	 */
	private windowStart(total: number, height: number, selected: number, which: "list" | "folder"): number {
		if (which === "list") {
			if (selected < this.scroll) this.scroll = selected;
			if (selected >= this.scroll + height) this.scroll = selected - height + 1;
			this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, total - height)));
			return this.scroll;
		}
		if (selected < this.folderScroll) this.folderScroll = selected;
		if (selected >= this.folderScroll + height) this.folderScroll = selected - height + 1;
		this.folderScroll = Math.max(0, Math.min(this.folderScroll, Math.max(0, total - height)));
		return this.folderScroll;
	}

	// ------------------------------------------------------------- list model

	private entries(): Entry[] {
		const query = this.filter.trim().toLowerCase();
		const out: Entry[] = [];
		for (const workspace of this.workspaces) {
			const workspaceMatches =
				!query ||
				`${workspace.label} ${workspace.cwd} ${workspace.branch ?? ""}`.toLowerCase().includes(query);
			const sessions = !query
				? workspace.sessions
				: workspace.sessions.filter((session) =>
						`${session.title} ${session.path}`.toLowerCase().includes(query),
					);
			if (query && !workspaceMatches && sessions.length === 0) continue;
			// A search forces every surviving workspace open so hits are never hidden.
			const expanded = query ? true : this.expanded.has(workspace.cwd);
			out.push({ kind: "workspace", workspace, expanded });
			if (expanded) {
				for (const session of sessions) out.push({ kind: "session", workspace, session });
			}
		}
		return out;
	}

	private selectedEntry(): Entry | undefined {
		return this.entries()[this.selected];
	}

	private clampSelection(): void {
		const total = this.entries().length;
		this.selected = total === 0 ? 0 : Math.max(0, Math.min(this.selected, total - 1));
	}

	private refresh(): void {
		void this.reload().then((workspaces) => {
			this.workspaces = workspaces;
			this.clampSelection();
			this.tui.requestRender();
		});
	}

	// ---------------------------------------------------------------- input

	handleInput(data: string): void {
		this.notice = undefined;
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.onEscape();
			return;
		}
		switch (this.mode) {
			case "rename":
				this.handleRenameInput(data);
				return;
			case "confirm-delete":
				this.handleDeleteInput(data);
				return;
			case "folder":
				this.handleFolderInput(data);
				return;
			default:
				this.handleListInput(data);
		}
	}

	private onEscape(): void {
		if (this.mode === "rename" || this.mode === "confirm-delete") {
			this.mode = "list";
			this.renameTarget = undefined;
			this.deleteTarget = undefined;
			this.tui.requestRender();
			return;
		}
		if (this.mode === "folder") {
			this.mode = "list";
			this.folderFilter = "";
			this.tui.requestRender();
			return;
		}
		if (this.searching || this.filter) {
			this.filter = "";
			this.searching = false;
			this.clampSelection();
			this.tui.requestRender();
			return;
		}
		this.done({ type: "cancel" });
	}

	private handleListInput(data: string): void {
		this.selected = this.moveSelection(data, this.selected, "list") ?? this.selected;

		if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
			this.activate();
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.left)) {
			this.setExpanded(false);
			return;
		}
		if (matchesKey(data, Key.right) || matchesKey(data, Key.ctrl("l"))) {
			this.setExpanded(true);
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			if (this.filter) {
				this.filter = this.filter.slice(0, -1);
				this.clampSelection();
			} else {
				this.searching = false;
			}
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.ctrl("u"))) {
			this.filter = "";
			this.searching = false;
			this.clampSelection();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.ctrl("n"))) {
			this.selected = Math.min(this.selected + 1, Math.max(0, this.entries().length - 1));
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.ctrl("p"))) {
			this.selected = Math.max(0, this.selected - 1);
			this.tui.requestRender();
			return;
		}

		// Single-keypress actions, live only while the user is not typing a
		// search. `/` enters search mode; from then on every printable key
		// extends the filter instead of firing an action.
		if (!this.searching && this.filter.length === 0) {
			switch (data) {
				case "/":
					this.searching = true;
					this.tui.requestRender();
					return;
				case "n":
					this.startNewSession();
					return;
				case "o":
					this.openFolderBrowser();
					return;
				case "r":
					this.startRename();
					return;
				case "d":
					this.startDelete();
					return;
				case "q":
					this.done({ type: "cancel" });
					return;
				default:
					break;
			}
		}

		const typed = printable(data);
		if (typed) {
			this.searching = true;
			this.filter += typed;
			this.clampSelection();
			this.tui.requestRender();
		}
	}

	private moveSelection(data: string, current: number, which: "list" | "folder"): number | undefined {
		const total = which === "list" ? this.entries().length : this.folderRows.length;
		const clamp = (value: number) => Math.max(0, Math.min(value, total - 1));
		if (matchesKey(data, Key.up)) {
			const next = clamp(current - 1);
			this.applySelection(next, which);
			return next;
		}
		if (matchesKey(data, Key.down)) {
			const next = clamp(current + 1);
			this.applySelection(next, which);
			return next;
		}
		if (matchesKey(data, Key.pageUp)) {
			const next = clamp(current - 5);
			this.applySelection(next, which);
			return next;
		}
		if (matchesKey(data, Key.pageDown)) {
			const next = clamp(current + 5);
			this.applySelection(next, which);
			return next;
		}
		return undefined;
	}

	private applySelection(value: number, which: "list" | "folder"): void {
		if (which === "list") this.selected = value;
		else this.folderSelected = value;
		this.tui.requestRender();
	}

	private setExpanded(expanded: boolean): void {
		const entry = this.selectedEntry();
		if (!entry || entry.kind !== "workspace") return;
		if (expanded) this.expanded.add(entry.workspace.cwd);
		else this.expanded.delete(entry.workspace.cwd);
		this.clampSelection();
		this.tui.requestRender();
	}

	private activate(): void {
		const entry = this.selectedEntry();
		if (!entry) return;
		if (entry.kind === "workspace") {
			if (this.expanded.has(entry.workspace.cwd)) this.expanded.delete(entry.workspace.cwd);
			else this.expanded.add(entry.workspace.cwd);
			this.clampSelection();
			this.tui.requestRender();
			return;
		}
		const session = entry.session;
		if (!session.path) {
			this.notice = { text: "That session has no file on disk yet", tone: "error" };
			this.tui.requestRender();
			return;
		}
		if (session.isCurrent) {
			this.notice = { text: "Already in this session", tone: "info" };
			this.tui.requestRender();
			return;
		}
		this.done({ type: "switch", sessionPath: session.path });
	}

	private workspaceFor(entry: Entry | undefined): WorkspaceRow | undefined {
		return entry?.workspace;
	}

	private startNewSession(): void {
		const workspace = this.workspaceFor(this.selectedEntry());
		const cwd = workspace?.cwd && !workspace.missing ? workspace.cwd : this.currentCwd;
		if (!cwd) {
			this.notice = { text: "Pick a workspace first", tone: "error" };
			this.tui.requestRender();
			return;
		}
		this.done({ type: "new-session", cwd });
	}

	private startRename(): void {
		const entry = this.selectedEntry();
		if (!entry || entry.kind !== "session") return;
		this.renameTarget = entry.session;
		this.renameValue = entry.session.title;
		this.mode = "rename";
		this.tui.requestRender();
	}

	private handleRenameInput(data: string): void {
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
			const target = this.renameTarget;
			const name = this.renameValue.trim();
			this.mode = "list";
			this.renameTarget = undefined;
			if (!target || !name) {
				this.tui.requestRender();
				return;
			}
			const result = this.rename(target.path, name);
			if (!result.ok) {
				this.notice = { text: result.error ?? "Rename failed", tone: "error" };
				this.tui.requestRender();
				return;
			}
			this.notice = { text: `Renamed to "${truncateToWidth(name, 40, "…")}"`, tone: "info" };
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			this.renameValue = this.renameValue.slice(0, -1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.ctrl("u"))) {
			this.renameValue = "";
			this.tui.requestRender();
			return;
		}
		const typed = printable(data);
		if (typed) {
			this.renameValue += typed;
			this.tui.requestRender();
		}
	}

	private startDelete(): void {
		const entry = this.selectedEntry();
		if (!entry || entry.kind !== "session") return;
		if (entry.session.isCurrent) {
			this.notice = { text: "Cannot delete the session you are in", tone: "error" };
			this.tui.requestRender();
			return;
		}
		this.deleteTarget = entry.session;
		this.mode = "confirm-delete";
		this.tui.requestRender();
	}

	private handleDeleteInput(data: string): void {
		const target = this.deleteTarget;
		const yes = data === "y" || data === "Y";
		const no = data === "n" || data === "N";
		if (!yes && !no) return;
		this.mode = "list";
		this.deleteTarget = undefined;
		if (!target || !yes) {
			this.tui.requestRender();
			return;
		}
		void this.remove(target.path).then((result) => {
			if (!result.ok) {
				this.notice = { text: result.error ?? "Delete failed", tone: "error" };
				this.tui.requestRender();
				return;
			}
			this.notice = { text: result.method === "trash" ? "Moved to trash" : "Deleted", tone: "info" };
			this.refresh();
		});
	}

	// -------------------------------------------------------------- folder mode

	private openFolderBrowser(): void {
		const workspace = this.workspaceFor(this.selectedEntry());
		const start = workspace?.cwd && !workspace.missing ? workspace.cwd : this.currentCwd || expandHome("~");
		this.folderPath = start;
		this.folderFilter = "";
		this.folderSelected = 0;
		this.folderScroll = 0;
		this.mode = "folder";
		this.reloadFolderRows();
	}

	private reloadFolderRows(): void {
		const existing = listDirectories(this.folderPath);
		const rows: FolderRow[] = [{ kind: "create", path: this.folderPath }];

		const typed = expandHome(this.folderFilter.trim());
		if (typed && typed !== this.folderPath && (typed.startsWith("/") || typed.startsWith("~"))) {
			const listed = listDirectories(typed);
			if (!listed.error) rows.push({ kind: "jump", path: typed });
		}

		const query = this.folderFilter.trim().toLowerCase();
		if (!query || query.startsWith("/") || query.startsWith("~")) {
			const parent = parentDirectory(this.folderPath);
			if (parent) rows.push({ kind: "parent", path: parent });
		}

		const dirs = existing.entries.filter(
			(entry) => !query || query.startsWith("/") || query.startsWith("~") || entry.name.toLowerCase().includes(query),
		);
		for (const entry of dirs) rows.push({ kind: "dir", entry });

		this.folderRows = rows;
		this.folderSelected = Math.max(0, Math.min(this.folderSelected, rows.length - 1));
		this.tui.requestRender();
	}

	private handleFolderInput(data: string): void {
		this.folderSelected = this.moveSelection(data, this.folderSelected, "folder") ?? this.folderSelected;

		if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
			const row = this.folderRows[this.folderSelected];
			if (!row) return;
			switch (row.kind) {
				case "create":
					this.done({ type: "new-session", cwd: row.path });
					return;
				case "jump":
				case "parent":
				case "dir":
					this.folderPath = row.kind === "dir" ? row.entry.path : row.path;
					this.folderFilter = "";
					this.folderSelected = 0;
					this.folderScroll = 0;
					this.reloadFolderRows();
					return;
			}
			return;
		}

		if (matchesKey(data, Key.tab)) {
			this.done({ type: "new-session", cwd: this.folderPath });
			return;
		}

		if (matchesKey(data, Key.backspace)) {
			this.folderFilter = this.folderFilter.slice(0, -1);
			this.folderSelected = 0;
			this.reloadFolderRows();
			return;
		}

		if (matchesKey(data, Key.ctrl("u"))) {
			this.folderFilter = "";
			this.folderSelected = 0;
			this.reloadFolderRows();
			return;
		}

		const typed = printable(data);
		if (typed) {
			this.folderFilter += typed;
			this.folderSelected = 0;
			this.reloadFolderRows();
		}
	}

	invalidate(): void {}
	dispose(): void {}
}

const LIST_HINTS = [
	"↑↓ move · ⏎ open · / search · n new · o folder · r rename · d delete · esc close",
	"↑↓ move · ⏎ open · / search · n new · o folder · r/d · esc",
	"↑↓ · ⏎ open · n new · o folder · r/d · esc",
	"↑↓ · ⏎ open · n · o · esc",
] as const;
const RENAME_HINTS = ["⏎ save · esc cancel", "⏎ save · esc"] as const;
const FOLDER_HINTS = [
	"↑↓ move · ⏎ open · tab session here · esc back",
	"↑↓ move · ⏎ open · tab here · esc back",
	"↑↓ · ⏎ open · tab here · esc",
	"↑↓ · ⏎ open · esc",
] as const;

/**
 * Recover printable characters from a keypress. Escape sequences (arrows, F
 * keys) are ignored; a pasted run of text is appended as-is.
 */
function printable(data: string): string | undefined {
	if (!data || data.startsWith("\x1b")) return undefined;
	const cleaned = data.replace(/[\x00-\x1f\x7f]/g, "");
	return cleaned.length > 0 ? cleaned : undefined;
}
