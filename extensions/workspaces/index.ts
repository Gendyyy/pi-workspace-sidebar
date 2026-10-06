/**
 * Workspaces sidebar (/ws, Ctrl+Shift+S).
 *
 * A toggleable right-anchored panel listing every workspace pi knows about
 * (grouped by session cwd) and the sessions inside each one. Enter switches,
 * n starts a new session, o browses to any folder, r renames, d deletes.
 *
 * pi only exposes switchSession()/newSession() on the *command* context
 * (dist/modes/interactive/interactive-mode.js wires them into
 * createCommandContext(), not into the shortcut context built at
 * setupExtensionShortcuts). So the panel is pure UI: it resolves to a
 * PanelAction, and the command path performs it. The shortcut path cannot
 * switch sessions itself, so it queues the action and prefills /ws-resume so a
 * single Enter completes it -- the same hand-off @vanillagreen/pi-session-manager
 * uses.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import {
	abbreviatePath,
	createNewSessionFile,
	deleteSession,
	loadWorkspaces,
	removeEmptySessionFile,
	renameSession,
	sessionsRootFor,
} from "./data.ts";
import { WorkspacePanel, type PanelAction } from "./panel.ts";

const PANEL_TITLE = "Workspaces";
/** Queued actions expire so a stale id cannot resurrect an ancient selection. */
const PENDING_TTL_MS = 5 * 60 * 1000;
const PENDING_LIMIT = 25;

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

/** Open the switcher and wait for the user to resolve it into an action. */
async function openPanel(ctx: ExtensionContext, initialFilter?: string): Promise<PanelAction | undefined> {
	const sessionsDir = sessionsRootFor(ctx.sessionManager.getSessionDir(), ctx.cwd);
	const load = () =>
		loadWorkspaces({
			currentCwd: ctx.cwd,
			currentSessionFile: ctx.sessionManager.getSessionFile(),
			sessionsDir,
		});

	const workspaces = await load();
	const action = await ctx.ui.custom<PanelAction>(
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
				anchor: "right-center",
				width: panelWidth(),
				maxHeight: "90%",
				margin: { right: 1 },
			},
		},
	);
	return action;
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
	await ctx.waitForIdle();
	const action = await openPanel(ctx, initialFilter);
	await performAction(ctx, action);
}

export default function workspacesExtension(pi: ExtensionAPI): void {
	pi.registerCommand("ws", {
		description: "Open the workspaces sidebar: switch, create, rename, or delete sessions",
		handler: async (args, ctx) => {
			const filter = args.trim();
			await runCommand(ctx, filter.length > 0 ? filter : undefined);
		},
	});

	// Hand-off target for the shortcut path, which has no switchSession().
	pi.registerCommand("ws-resume", {
		description: "Apply a queued workspace selection from the Ctrl+Shift+S panel",
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

	pi.registerShortcut(Key.ctrlShift("s"), {
		description: "Open the workspaces sidebar",
		handler: async (ctx) => {
			if (!requireTui(ctx)) return;
			if (!ctx.isIdle()) {
				ctx.ui.notify(`${PANEL_TITLE}: wait for the current turn to finish`, "warning");
				return;
			}
			const action = await openPanel(ctx);
			if (!action || action.type === "cancel") return;
			const id = queuePending(action);
			ctx.ui.setEditorText(`/ws-resume ${id}`);
			ctx.ui.notify(
				action.type === "new-session"
					? `New session in ${abbreviatePath(action.cwd)} — press Enter to open`
					: "Press Enter to switch to the selected session",
				"info",
			);
		},
	});
}
