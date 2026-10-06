/**
 * Workspaces sidebar: a docked side panel plus a full-screen overlay.
 *
 * Two surfaces over one model:
 *
 *   - A docked sidebar (`dock.ts` + `sidebar.ts`) that owns the right-hand
 *     columns for the whole session, like opencode's side panel. Shown by
 *     default on terminals at least 80 columns wide. Ctrl+Shift+S moves the
 *     keyboard into it; Esc hands the keyboard back to the editor.
 *   - An overlay panel (`panel.ts`) for narrow terminals, and for the actions a
 *     one-line-per-row list cannot host: searching, browsing to any folder,
 *     renaming, and deleting.
 *
 * pi only exposes switchSession()/newSession() on the *command* context
 * (interactive-mode wires them into createCommandContext(), not into the
 * shortcut context). So neither surface switches sessions itself: both resolve
 * to a PanelAction, which is queued and then dispatched as
 * `/ws-resume <id>`. The dispatch uses
 * `pi.sendUserMessage(text, { expandPromptTemplates: true })`, which pi routes
 * to the command handler with a full command context -- so one keypress
 * switches sessions with no editor round trip.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import {
	abbreviatePath,
	createNewSessionFile,
	deleteSession,
	loadWorkspaces,
	removeEmptySessionFile,
	renameSession,
	sessionsRootFor,
	type WorkspaceRow,
} from "./data.ts";
import { SidebarDock } from "./dock.ts";
import { WorkspacePanel, type PanelAction } from "./panel.ts";
import {
	renderSidebar,
	sidebarEntries,
	type SidebarEntry,
	type SidebarNotice,
	type SidebarView,
} from "./sidebar.ts";

const PANEL_TITLE = "Workspaces";
/** Widget key pi uses to place (and later remove) the dock. */
const DOCK_KEY = "workspaces-sidebar";
/** Below this the dock leaves too little room for the conversation. */
const DOCK_MIN_COLUMNS = 80;
/** Queued actions expire so a stale id cannot resurrect an ancient selection. */
const PENDING_TTL_MS = 5 * 60 * 1000;
const PENDING_LIMIT = 25;

interface DockState {
	workspaces: WorkspaceRow[];
	expanded: Set<string>;
	selected: number;
	focused: boolean;
	notice: SidebarNotice | null;
	/** Requested width in columns; 0 means auto. */
	width: number;
	/** User preference. Independent of whether the terminal is wide enough. */
	enabled: boolean;
	/** True once the current workspace has been expanded for the first time. */
	seeded: boolean;
}

const state: DockState = {
	workspaces: [],
	expanded: new Set(),
	selected: 0,
	focused: false,
	notice: null,
	width: 0,
	enabled: true,
	seeded: false,
};

let dock: SidebarDock | null = null;
let dockTui: TUI | null = null;
let activeCtx: ExtensionContext | null = null;
let unsubscribeInput: (() => void) | null = null;
/** Workspace whose sessions were auto-expanded, so a switch re-expands the new one. */
let seededCwd: string | undefined;

interface PendingAction {
	action: PanelAction;
	createdAt: number;
}

const pendingActions = new Map<string, PendingAction>();
let pendingCounter = 0;

function queuePending(action: PanelAction): string {
	const now = Date.now();
	for (const [id, entry] of pendingActions) {
		if (now - entry.createdAt > PENDING_TTL_MS) pendingActions.delete(id);
	}
	while (pendingActions.size >= PENDING_LIMIT) {
		const oldest = pendingActions.keys().next().value;
		if (oldest === undefined) break;
		pendingActions.delete(oldest);
	}
	const id = `ws-${now.toString(36)}-${(pendingCounter += 1).toString(36)}`;
	pendingActions.set(id, { action, createdAt: now });
	return id;
}

function panelWidth(): number {
	const columns = process.stdout.columns ?? 100;
	return Math.max(44, Math.min(66, columns - 34));
}

function requireTui(ctx: ExtensionContext): boolean {
	if (!ctx.hasUI || ctx.mode !== "tui") {
		ctx.ui.notify(`${PANEL_TITLE} needs the interactive TUI`, "warning");
		return false;
	}
	return true;
}

export default function workspacesExtension(pi: ExtensionAPI): void {
	// ------------------------------------------------------------ dock state

	function sidebarView(): SidebarView {
		return {
			workspaces: state.workspaces,
			expanded: state.expanded,
			selected: state.selected,
			focused: state.focused,
			notice: state.notice,
		};
	}

	function paintDock(): void {
		if (dock?.installed) dock.paint();
	}

	function setNotice(text: string, tone: SidebarNotice["tone"]): void {
		state.notice = { text, tone };
		paintDock();
	}

	function entries(): SidebarEntry[] {
		return sidebarEntries(state.workspaces, state.expanded);
	}

	function selectedEntry(): SidebarEntry | undefined {
		return entries()[state.selected];
	}

	function moveSelection(delta: number): void {
		const total = entries().length;
		if (total === 0) return;
		state.selected = Math.max(0, Math.min(total - 1, state.selected + delta));
		state.notice = null;
		paintDock();
	}

	function toggleExpanded(cwd: string): void {
		if (state.expanded.has(cwd)) state.expanded.delete(cwd);
		else state.expanded.add(cwd);
		paintDock();
	}

	/** Load the workspace model into the dock's state. */
	async function refreshDockWorkspaces(ctx?: ExtensionContext): Promise<void> {
		const source = ctx ?? activeCtx;
		if (!source) return;
		const sessionsDir = sessionsRootFor(source.sessionManager.getSessionDir(), source.cwd);
		let workspaces: WorkspaceRow[];
		try {
			workspaces = await loadWorkspaces({
				currentCwd: source.cwd,
				currentSessionFile: source.sessionManager.getSessionFile(),
				sessionsDir,
			});
		} catch {
			return;
		}
		state.workspaces = workspaces;
		// Expand the workspace the user is in, plus empty ones, the first time the
		// list loads — and again whenever they land in a different workspace.
		const currentCwd = workspaces.find((workspace) => workspace.isCurrent)?.cwd;
		if (!state.seeded || seededCwd !== currentCwd) {
			state.seeded = true;
			seededCwd = currentCwd;
			for (const workspace of workspaces) {
				if (workspace.isCurrent || workspace.sessions.length === 0) state.expanded.add(workspace.cwd);
			}
		}
		const total = sidebarEntries(workspaces, state.expanded).length;
		state.selected = total === 0 ? 0 : Math.max(0, Math.min(state.selected, total - 1));
		paintDock();
	}

	function installDock(): boolean {
		if (!dock || !dockTui) return false;
		if (dock.installed) return true;
		if (!state.enabled) return false;
		if (dock.rawColumns() < DOCK_MIN_COLUMNS) return false;
		dock.install();
		dockTui.requestRender(true);
		return true;
	}

	function uninstallDock(): void {
		if (!dock) return;
		dock.uninstall();
	}

	function setFocused(next: boolean): void {
		if (state.focused === next) {
			if (next) void refreshDockWorkspaces();
			return;
		}
		state.focused = next;
		state.notice = null;
		paintDock();
		if (next) void refreshDockWorkspaces();
	}

	/** Run an action through a command context, which owns switchSession(). */
	function dispatch(action: PanelAction): void {
		if (!activeCtx) return;
		if (!activeCtx.isIdle()) {
			setNotice("wait for the current turn to finish", "warning");
			return;
		}
		const id = queuePending(action);
		pi.sendUserMessage(`/ws-resume ${id}`, { expandPromptTemplates: true });
	}

	/** Run one of this extension's own commands from a non-command context. */
	function dispatchCommand(text: string): void {
		if (!activeCtx?.isIdle()) {
			setNotice("wait for the current turn to finish", "warning");
			return;
		}
		setFocused(false);
		pi.sendUserMessage(text, { expandPromptTemplates: true });
	}

	function activate(entry: SidebarEntry | undefined): void {
		if (!entry) return;
		if (entry.kind === "workspace") {
			toggleExpanded(entry.workspace.cwd);
			return;
		}
		const session = entry.session;
		if (!session.path) {
			setNotice("that session has no file on disk yet", "warning");
			return;
		}
		if (session.isCurrent) {
			setNotice("already in this session", "info");
			return;
		}
		setFocused(false);
		dispatch({ type: "switch", sessionPath: session.path });
	}

	function startNewSession(entry: SidebarEntry | undefined): void {
		const workspace = entry?.workspace;
		const cwd = workspace && !workspace.missing ? workspace.cwd : (activeCtx?.cwd ?? "");
		if (!cwd) {
			setNotice("pick a workspace first", "warning");
			return;
		}
		setFocused(false);
		dispatch({ type: "new-session", cwd });
	}

	/**
	 * The dock owns the keyboard while focused, so the editor cannot be typed
	 * into by accident. Only keys the dock understands are consumed; control
	 * characters and escape sequences it does not handle fall through to pi, so
	 * Ctrl+C, Ctrl+D and friends keep working.
	 */
	function handleTerminalInput(data: string): { consume?: boolean } | undefined {
		if (!dock?.installed || !state.focused) return undefined;

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			setFocused(false);
			return { consume: true };
		}
		if (matchesKey(data, Key.up)) {
			moveSelection(-1);
			return { consume: true };
		}
		if (matchesKey(data, Key.down)) {
			moveSelection(1);
			return { consume: true };
		}
		if (matchesKey(data, Key.pageUp)) {
			moveSelection(-5);
			return { consume: true };
		}
		if (matchesKey(data, Key.pageDown)) {
			moveSelection(5);
			return { consume: true };
		}
		if (matchesKey(data, Key.enter)) {
			activate(selectedEntry());
			return { consume: true };
		}
		if (data === "n") {
			startNewSession(selectedEntry());
			return { consume: true };
		}
		if (data === "o") {
			dispatchCommand("/ws");
			return { consume: true };
		}
		if (data === "/") {
			dispatchCommand("/ws");
			return { consume: true };
		}
		// Swallow stray printable keys so they cannot leak into the editor.
		if (/^[\x20-\x7e]$/.test(data)) return { consume: true };
		return undefined;
	}

	function createDockWidget(tui: TUI, theme: Theme) {
		dockTui = tui;
		dock = new SidebarDock(tui, {
			width: () => state.width,
			render: (width, height) => renderSidebar(sidebarView(), width, height, theme),
			separator: () => theme.fg("border", "│"),
			background: process.env.PI_SIDEBAR_BG,
		});
		installDock();
		return {
			render: () => [] as string[],
			invalidate: () => dock?.invalidate(),
			dispose: () => {
				dock?.dispose();
				dock = null;
				dockTui = null;
				state.focused = false;
			},
		};
	}

	// -------------------------------------------------------------- overlay

	/** Open the overlay and wait for the user to resolve it into an action. */
	async function openPanel(ctx: ExtensionContext, initialFilter?: string): Promise<PanelAction | undefined> {
		const sessionsDir = sessionsRootFor(ctx.sessionManager.getSessionDir(), ctx.cwd);
		const load = () =>
			loadWorkspaces({
				currentCwd: ctx.cwd,
				currentSessionFile: ctx.sessionManager.getSessionFile(),
				sessionsDir,
			});

		const workspaces = await load();
		const docked = dock?.installed === true;
		return ctx.ui.custom<PanelAction>(
			(tui, theme, _keybindings, done) =>
				new WorkspacePanel({
					theme,
					tui,
					currentCwd: ctx.cwd,
					workspaces,
					reload: load,
					rename: renameSession,
					remove: deleteSession,
					done,
					initialFilter,
				}),
			{
				overlay: true,
				overlayOptions: {
					anchor: docked ? "center" : "right-center",
					width: panelWidth(),
					maxHeight: "90%",
					margin: docked ? undefined : { right: 1 },
				},
			},
		);
	}

	/** Execute an action. Only callable from a command context. */
	async function performAction(ctx: ExtensionCommandContext, action: PanelAction | undefined): Promise<void> {
		if (!action || action.type === "cancel") return;
		await ctx.waitForIdle();

		if (action.type === "new-session") {
			const cwd = action.cwd || ctx.cwd;
			const created = createNewSessionFile(cwd, sessionsRootFor(ctx.sessionManager.getSessionDir(), ctx.cwd));
			if (!created.path) {
				ctx.ui.notify(created.error ?? "Could not create a session file", "error");
				return;
			}
			const result = await ctx.switchSession(created.path, {
				withSession: async (next) => {
					next.ui.notify(`New session in ${abbreviatePath(cwd)}`, "info");
				},
			});
			if (result.cancelled) await removeEmptySessionFile(created.path);
			return;
		}

		const result = await ctx.switchSession(action.sessionPath, {
			withSession: async (next) => {
				next.ui.notify("Switched session", "info");
			},
		});
		if (result.cancelled) ctx.ui.notify("Session switch cancelled", "info");
	}

	async function runCommand(ctx: ExtensionCommandContext, initialFilter?: string): Promise<void> {
		if (!requireTui(ctx)) return;
		activeCtx = ctx;
		await ctx.waitForIdle();
		const action = await openPanel(ctx, initialFilter);
		await performAction(ctx, action);
		// The panel can rename or delete, so the dock's copy may be stale.
		await refreshDockWorkspaces();
	}

	// ------------------------------------------------------------- commands

	pi.registerCommand("ws", {
		description: "Open the workspaces panel: switch, create, rename, or delete sessions",
		handler: async (args, ctx) => {
			const filter = args.trim();
			await runCommand(ctx, filter.length > 0 ? filter : undefined);
		},
	});

	// Hand-off target for the dock, whose input handler has no command context.
	pi.registerCommand("ws-resume", {
		description: "Apply a queued workspace selection from the sidebar",
		handler: async (args, ctx) => {
			const id = args.trim();
			const queued = pendingActions.get(id);
			if (!queued) {
				ctx.ui.notify("That workspace selection is no longer available", "warning");
				return;
			}
			pendingActions.delete(id);
			await performAction(ctx, queued.action);
		},
	});

	pi.registerCommand("ws-sidebar", {
		description: "Dock the workspaces sidebar: on, off, toggle, width <cols>, auto, status",
		handler: async (args, ctx) => {
			if (!requireTui(ctx)) return;
			activeCtx = ctx;
			const [verb, value] = args.trim().split(/\s+/);
			switch (verb) {
				case "on":
					state.enabled = true;
					break;
				case "off":
					state.enabled = false;
					break;
				case "toggle":
					state.enabled = !state.enabled;
					break;
				case "width": {
					const width = Number(value);
					if (!Number.isFinite(width) || width < 20 || width > 120) {
						ctx.ui.notify("Usage: /ws-sidebar width <20-120>", "warning");
						return;
					}
					state.width = Math.round(width);
					break;
				}
				case "auto":
					state.width = 0;
					break;
				case "":
				case "status":
					break;
				default:
					ctx.ui.notify("Usage: /ws-sidebar on|off|toggle|width <cols>|auto|status", "warning");
					return;
			}

			if (state.enabled) installDock();
			else uninstallDock();
			dock?.invalidate();
			paintDock();
			dockTui?.requestRender(true);

			const width = state.width > 0 ? `${state.width} cols` : "auto width";
			if (!state.enabled) {
				ctx.ui.notify("Workspaces sidebar: off", "info");
			} else if (dock?.installed) {
				ctx.ui.notify(`Workspaces sidebar: on, ${width}`, "info");
			} else {
				ctx.ui.notify(
					`Workspaces sidebar hidden: needs a terminal at least ${DOCK_MIN_COLUMNS} columns wide`,
					"warning",
				);
			}
		},
	});

	// --------------------------------------------------------------- events

	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx;
		state.focused = false;
		state.notice = null;
		if (!ctx.hasUI || ctx.mode !== "tui") return;

		unsubscribeInput?.();
		unsubscribeInput = ctx.ui.onTerminalInput(handleTerminalInput);
		await refreshDockWorkspaces(ctx);
		ctx.ui.setWidget(DOCK_KEY, createDockWidget, { placement: "belowEditor" });
	});

	pi.on("session_info_changed", () => {
		void refreshDockWorkspaces();
	});

	pi.registerShortcut(Key.ctrlShift("s"), {
		description: "Focus the workspaces sidebar (opens the panel when it is hidden)",
		handler: async (ctx) => {
			if (!requireTui(ctx)) return;
			activeCtx = ctx;
			// This is the sidebar key: re-enable the dock if it was turned off.
			state.enabled = true;
			if (!installDock()) {
				if (!ctx.isIdle()) {
					ctx.ui.notify(`${PANEL_TITLE}: wait for the current turn to finish`, "warning");
					return;
				}
				// Too narrow for the dock: fall back to the overlay. The panel still
				// cannot switch by itself, so hand the action to /ws-resume, which
				// runs with a command context.
				const action = await openPanel(ctx);
				if (action && action.type !== "cancel") {
					const id = queuePending(action);
					pi.sendUserMessage(`/ws-resume ${id}`, { expandPromptTemplates: true });
				}
				return;
			}
			setFocused(!state.focused);
		},
	});
}
