/**
 * Panel behaviour: rendering, keyboard navigation, search, and the action
 * hand-off. Everything runs against a temp sessions root, so no check can
 * touch the user's real session store.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { deleteSession, loadWorkspaces, renameSession, type SessionRow, type WorkspaceRow } from "../extensions/workspaces/data.ts";
import { WorkspacePanel, type PanelAction, type PanelDeps } from "../extensions/workspaces/panel.ts";
import { createEnv, writeSession, type FixtureEnv } from "./fixtures.ts";

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const plain = (lines: string[]) => strip(lines.join("\n"));

/** A theme stub that still emits SGR codes, so width math is exercised for real. */
const theme = {
	fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[0m`,
	style: (text: string) => `\x1b[7m${text}\x1b[0m`,
} as unknown as PanelDeps["theme"];

const WIDTH = 64;
const KEYS = {
	up: "\x1b[A",
	down: "\x1b[B",
	left: "\x1b[D",
	right: "\x1b[C",
	pageUp: "\x1b[5~",
	pageDown: "\x1b[6~",
	enter: "\r",
	tab: "\t",
	backspace: "\x7f",
	ctrlU: "\x15",
	escape: "\x1b",
};

describe("workspace panel", () => {
	let env: FixtureEnv;
	let workspaces: WorkspaceRow[];
	let alphaSession: SessionRow;
	let gammaSession: SessionRow;
	const box: { action?: PanelAction } = {};
	const resolved = () => box.action;
	const actionType = () => box.action?.type;
	const actionCwd = () => (box.action?.type === "new-session" ? box.action.cwd : undefined);

	const load = () => loadWorkspaces({ currentCwd: env.dirs.alpha, sessionsDir: env.root });

	/** Entries: 0 = alpha (current, expanded), 1 = alpha's session, 2 = gamma (collapsed). */
	const build = (options: { initialFilter?: string; currentSessionFile?: string; deps?: Partial<PanelDeps> } = {}) => {
		// A current session is whatever pi reports as the open file, so mark it here
		// rather than reloading: the fixture list stays deterministic.
		const list = options.currentSessionFile
			? workspaces.map((row) => ({
					...row,
					sessions: row.sessions.map((session) => ({ ...session, isCurrent: session.path === options.currentSessionFile })),
				}))
			: workspaces;
		return new WorkspacePanel({
			theme,
			tui: { terminal: { rows: 42, columns: 120 }, requestRender: () => {} } as unknown as PanelDeps["tui"],
			currentCwd: env.dirs.alpha,
			workspaces: list,
			reload: load,
			rename: renameSession,
			remove: deleteSession,
			done: (action) => {
				box.action = action;
			},
			...(options.initialFilter === undefined ? {} : { initialFilter: options.initialFilter }),
			...options.deps,
		});
	};

	/** Select the row at `index` by walking down from the top. */
	const selectRow = (panel: WorkspacePanel, index: number) => {
		for (let i = 0; i < index; i += 1) panel.handleInput(KEYS.down);
	};

	before(async () => {
		env = createEnv();
		writeSession(env.root, { cwd: env.dirs.alpha, message: "alpha only session", ageMinutes: 1 });
		writeSession(env.root, { cwd: env.dirs.gamma, message: "gamma older session", ageMinutes: 10 });
		workspaces = await load();
		alphaSession = workspaces.find((row) => row.cwd === env.dirs.alpha)!.sessions[0]!;
		gammaSession = workspaces.find((row) => row.cwd === env.dirs.gamma)!.sessions[0]!;
	});

	after(() => env.cleanup());

	describe("rendering", () => {
		it("draws a bordered frame with the title and the session list", () => {
			box.action = undefined;
			const panel = build();
			const frame = panel.render(WIDTH);
			assert.ok(frame.length > 0);
			assert.ok(frame.every((line) => typeof line === "string"));
			assert.ok(
				frame.every((line) => visibleWidth(line) <= WIDTH),
				`max=${Math.max(...frame.map(visibleWidth))}`,
			);
			const first = strip(frame[0]!);
			assert.ok(first.startsWith("╭") && first.endsWith("╮"), first);
			assert.ok(strip(frame.at(-1)!).startsWith("╰"));
			assert.ok(plain(frame).includes("Workspaces"));
			assert.ok(plain(frame).includes("/ to search"), "idle filter affordance");
			assert.ok(plain(frame).includes("n new"), "key hints");
			assert.ok(plain(frame).includes(alphaSession.title.slice(0, 12)), "current workspace is expanded");
			assert.ok(frame.length <= 42, `bounded height, got ${frame.length}`);
		});

		it("never overflows a narrow terminal", () => {
			const frame = build().render(30);
			assert.ok(
				frame.every((line) => visibleWidth(line) <= 30),
				`max=${Math.max(...frame.map(visibleWidth))}`,
			);
		});

		it("adapts its hints to every width in list and folder mode", () => {
			for (const width of [24, 28, 32, 40, 44, 52, 60, 64, 72, 80, 100, 140]) {
				for (const mode of ["list", "folder"] as const) {
					const panel = build();
					if (mode === "folder") panel.handleInput("o");
					const lines = panel.render(width);
					const why = `${mode} @ ${width}`;
					assert.ok(
						lines.every((line) => visibleWidth(line) <= width),
						`${why} max=${Math.max(...lines.map(visibleWidth))}`,
					);
					assert.ok(strip(lines.at(-2)!).trim().length > 0, `${why} has a hint row`);
					assert.ok(strip(lines[0]!).endsWith("╮") && strip(lines.at(-1)!).endsWith("╯"), `${why} border closes`);
				}
			}
		});
		it("pluralises the per-workspace session count", async () => {
			const env2 = createEnv();
			try {
				writeSession(env2.root, { cwd: env2.dirs.alpha, message: "one", ageMinutes: 5 });
				writeSession(env2.root, { cwd: env2.dirs.alpha, message: "two", ageMinutes: 3 });
				writeSession(env2.root, { cwd: env2.dirs.beta, message: "solo", ageMinutes: 1 });
				const list = await loadWorkspaces({ currentCwd: env2.dirs.alpha, sessionsDir: env2.root });
				const panel = build({ deps: { workspaces: list, currentCwd: env2.dirs.alpha } });
				const text = plain(panel.render(WIDTH));
				assert.ok(text.includes("2 sessions"), text);
				assert.ok(text.includes("1 session"), text);
				assert.equal(text.includes("1 sessions"), false, "no awkward singular");
			} finally {
				env2.cleanup();
			}
		});
	});

	describe("sorting", () => {
		it("toggles between modified and created dates", () => {
			const list = workspaces.map((workspace) => {
				if (workspace.cwd !== env.dirs.alpha) return workspace;
				const base = workspace.sessions[0]!;
				return {
					...workspace,
					sessions: [
						{ ...base, title: "Created newer", created: new Date(200), modified: new Date(100) },
						{ ...base, title: "Modified newer", created: new Date(100), modified: new Date(200) },
					],
				};
			});
			const panel = build({ deps: { workspaces: list } });
			let text = plain(panel.render(WIDTH));
			assert.ok(text.indexOf("Modified newer") < text.indexOf("Created newer"), text);
			panel.handleInput("s");
			text = plain(panel.render(WIDTH));
			assert.ok(text.includes("created"), text);
			assert.ok(text.indexOf("Created newer") < text.indexOf("Modified newer"), text);
			panel.handleInput("s");
			assert.ok(plain(panel.render(WIDTH)).includes("modified"));
		});
	});

	describe("navigation", () => {
		it("survives every movement key", () => {
			const panel = build();
			for (const key of [KEYS.down, KEYS.down, KEYS.up, KEYS.pageDown, KEYS.pageUp, KEYS.tab, KEYS.right, KEYS.left, "\x1b[1;2A", "\x10", "\x0e"]) {
				panel.handleInput(key);
				assert.ok(panel.render(WIDTH).length > 0, `key ${JSON.stringify(key)} renders`);
			}
		});

		it("moves the list selection with mouse-wheel input", () => {
			box.action = undefined;
			const panel = build();
			assert.deepEqual(panel.handleMouse({
				type: "wheel", button: "none", x: 10, y: 5, screenX: 10, screenY: 5,
				width: WIDTH, height: 20, shift: false, alt: false, ctrl: false, wheelDelta: 1,
			}), { handled: true });
			panel.handleInput(KEYS.enter);
			assert.equal(actionType(), "switch", "wheel selected the session row");
		});

		it("expands and collapses a workspace with Tab and the arrows", () => {
			const panel = build();
			selectRow(panel, 2); // gamma workspace row
			assert.equal(plain(panel.render(WIDTH)).includes("gamma older session"), false, "collapsed at first");
			panel.handleInput(KEYS.right);
			assert.ok(plain(panel.render(WIDTH)).includes("gamma older session"), "right expands");
			panel.handleInput(KEYS.tab);
			assert.equal(plain(panel.render(WIDTH)).includes("gamma older session"), false, "tab collapses");
		});
	});

	describe("search", () => {
		it("enters search with / and narrows the list", () => {
			box.action = undefined;
			const panel = build();
			panel.handleInput("/");
			assert.ok(plain(panel.render(WIDTH)).includes("⌕"), "search affordance replaces the idle hint");

			for (const char of ["g", "a", "m"]) panel.handleInput(char);
			const frame = panel.render(WIDTH);
			assert.ok(plain(frame).includes("gam"), "typed text lands in the filter");
			assert.ok(plain(frame).includes("gamma older session"), "matching workspace is forced open");
			assert.equal(plain(frame).includes("alpha only session"), false, "non-matching sessions are hidden");
		});

		it("treats action letters as filter text while searching", () => {
			box.action = undefined;
			const panel = build();
			panel.handleInput("/");
			selectRow(panel, 1);
			panel.handleInput("n");
			assert.equal(resolved(), undefined, "n typed into the search, not fired as an action");
			assert.ok(plain(panel.render(WIDTH)).includes("n"));
		});

		it("edits, clears, and leaves search without closing the panel", () => {
			box.action = undefined;
			const panel = build();
			panel.handleInput("/");
			for (const char of ["S", "u", "m"]) panel.handleInput(char);
			panel.handleInput(KEYS.backspace);
			assert.equal(plain(panel.render(WIDTH)).includes("Sumn"), false);
			panel.handleInput(KEYS.ctrlU);
			assert.ok(plain(panel.render(WIDTH)).includes("/ to search"), "Ctrl+U clears back to idle");

			panel.handleInput("/");
			panel.handleInput("z");
			panel.handleInput(KEYS.escape);
			assert.equal(resolved(), undefined, "first Esc only leaves search");
			assert.ok(plain(panel.render(WIDTH)).includes("/ to search"));
			panel.handleInput(KEYS.escape);
			assert.equal(actionType(), "cancel", "second Esc closes the panel");
		});

		it("starts in search mode when opened with a filter", () => {
			box.action = undefined;
			const panel = build({ initialFilter: "Summ" });
			const frame = panel.render(WIDTH);
			assert.ok(plain(frame).includes("Summ"));
			assert.equal(resolved(), undefined);
		});

		const contentRows = () => workspaces.map((workspace) => ({
			...workspace,
			sessions: workspace.sessions.map((session) => ({
				...session,
				title: "Named session",
				searchText: "earlier text with a secretneedle inside the conversation",
			})),
		}));

		it("finds session content and displays a matching snippet", () => {
			const panel = build({ initialFilter: "secretneedle", deps: { workspaces: contentRows() } });
			const text = plain(panel.render(WIDTH));
			assert.ok(text.includes("Named session"), text);
			assert.ok(text.includes("secretneedle"), text);
		});

		it("matches an unanchored regular expression in session content", () => {
			const panel = build({ deps: { workspaces: contentRows() } });
			panel.handleInput("/");
			panel.handleInput("\x12"); // Ctrl+R toggles regex mode.
			for (const char of "secret.*conversation") panel.handleInput(char);
			const text = plain(panel.render(WIDTH));
			assert.ok(text.includes("/re"), text);
			assert.ok(text.includes("Named session"), text);
			assert.ok(text.includes("secretneedle"), text);
		});

		it("shows an invalid-regex indicator without throwing", () => {
			const panel = build({ deps: { workspaces: contentRows() } });
			panel.handleInput("/");
			panel.handleInput("\x12");
			panel.handleInput("[");
			assert.ok(plain(panel.render(WIDTH)).includes("invalid regex"));
		});
	});

	describe("actions", () => {
		it("starts a new session in the selected workspace", () => {
			box.action = undefined;
			const panel = build();
			panel.handleInput("n");
			assert.equal(actionType(), "new-session");
			assert.equal(actionCwd(), env.dirs.alpha);
		});

		it("falls back to the current cwd for a workspace that vanished", async () => {
			box.action = undefined;
			const env2 = createEnv();
			try {
				writeSession(env2.root, { cwd: env2.dirs.alpha, message: "still here", ageMinutes: 1 });
				const gone = `${env2.dirs.gamma}/gone`;
				writeSession(env2.root, { cwd: gone, message: "vanished workspace", ageMinutes: 0 });
				const list = await loadWorkspaces({ currentCwd: env2.dirs.alpha, sessionsDir: env2.root });
				assert.deepEqual(
					list.map((row) => row.cwd),
					[env2.dirs.alpha, gone],
					"current workspace first, then the vanished one",
				);
				assert.equal(list[1]!.missing, true, "a cwd that is not on disk is flagged missing");

				const panel = build({ deps: { workspaces: list, currentCwd: env2.dirs.alpha } });
				selectRow(panel, 2); // 0 alpha, 1 alpha's session, 2 the vanished workspace
				panel.handleInput("n");
				assert.equal(actionCwd(), env2.dirs.alpha, `a missing workspace falls back to the current cwd, got ${actionCwd()}`);
			} finally {
				env2.cleanup();
			}
		});

		it("switches to a session on Enter", () => {
			box.action = undefined;
			const panel = build();
			selectRow(panel, 1);
			panel.handleInput(KEYS.enter);
			assert.deepEqual(resolved(), { type: "switch", sessionPath: alphaSession.path });
		});

		it("refuses to switch to the session already open", () => {
			box.action = undefined;
			const panel = build({ currentSessionFile: alphaSession.path });
			selectRow(panel, 1);
			panel.handleInput(KEYS.enter);
			assert.equal(resolved(), undefined);
			assert.ok(plain(panel.render(WIDTH)).includes("Already in this session"));
		});

		it("closes on q and Ctrl+C", () => {
			box.action = undefined;
			build().handleInput("q");
			assert.equal(actionType(), "cancel");

			box.action = undefined;
			build().handleInput("\x03");
			assert.equal(actionType(), "cancel");
		});
	});

	describe("folder browser", () => {
		it("offers the current folder, a parent row, and the subdirectories", () => {
			box.action = undefined;
			const panel = build();
			panel.handleInput("o");
			const text = plain(panel.render(WIDTH));
			assert.ok(text.includes("New session"), "title changes in folder mode");
			assert.ok(text.includes("Start a session in this folder"));
			assert.ok(text.includes(".."), "parent row");
			assert.ok(text.includes("session here"), "action-specific hints");
		});

		it("navigates without resolving and returns to the list on Esc", () => {
			box.action = undefined;
			const panel = build();
			panel.handleInput("o");
			for (const key of [KEYS.down, KEYS.up, KEYS.right, KEYS.left, KEYS.pageDown, KEYS.pageUp]) {
				panel.handleInput(key);
			}
			assert.equal(resolved(), undefined, "navigation never resolves");
			assert.ok(panel.render(WIDTH).length > 0);
			panel.handleInput(KEYS.escape);
			assert.equal(resolved(), undefined);
			assert.ok(plain(panel.render(WIDTH)).includes("n new"), "back on the list");
		});

		it("starts a session in the browsed folder with Enter on the first row", () => {
			box.action = undefined;
			const panel = build();
			panel.handleInput("o");
			panel.handleInput(KEYS.enter);
			assert.equal(actionType(), "new-session");
			assert.equal(actionCwd(), env.dirs.alpha);
		});

		it("starts a session in the browsed folder with Tab", () => {
			box.action = undefined;
			const panel = build();
			panel.handleInput("o");
			panel.handleInput("\t");
			assert.equal(actionCwd(), env.dirs.alpha);
		});

		it("descends into a subdirectory and remembers the path", () => {
			box.action = undefined;
			mkdirSync(join(env.dirs.alpha, "child"), { recursive: true });
			const panel = build();
			panel.handleInput("o");
			// Folder rows: 0 = create here, 1 = parent (..), 2 = the subdirectory.
			selectRow(panel, 2);
			panel.handleInput(KEYS.enter);
			assert.equal(resolved(), undefined, "descending does not resolve");
			panel.handleInput("\t");
			assert.equal(actionType(), "new-session");
			assert.ok(
				(actionCwd() ?? "").startsWith(`${env.dirs.alpha}/`),
				JSON.stringify(resolved()),
			);
		});

		it("filters subdirectories as you type", () => {
			const panel = build();
			panel.handleInput("o");
			panel.handleInput("z");
			panel.handleInput("z");
			const text = plain(panel.render(WIDTH));
			assert.ok(text.includes("zz"), "the filter is visible");
			assert.ok(text.includes("Start a session in this folder"), "the create row is never filtered out");
			panel.handleInput(KEYS.ctrlU);
			assert.equal(plain(panel.render(WIDTH)).includes("zz"), false);
		});
	});

	describe("rename", () => {
		it("renames the selected session on Enter, then reloads", async () => {
			box.action = undefined;
			const env2 = createEnv();
			try {
				const target = writeSession(env2.root, { cwd: env2.dirs.alpha, message: "rename target" });
				const loaded = await loadWorkspaces({ currentCwd: env2.dirs.alpha, sessionsDir: env2.root });
				const panel = new WorkspacePanel({
					theme,
					tui: { terminal: { rows: 42, columns: 120 }, requestRender: () => {} } as unknown as PanelDeps["tui"],
					currentCwd: env2.dirs.alpha,
					workspaces: loaded,
					reload: () => loadWorkspaces({ currentCwd: env2.dirs.alpha, sessionsDir: env2.root }),
					rename: renameSession,
					remove: deleteSession,
					done: (action) => {
						box.action = action;
					},
				});
				selectRow(panel, 1);
				panel.handleInput("r");
				assert.ok(plain(panel.render(WIDTH)).includes("rename"));
				panel.handleInput(KEYS.ctrlU);
				for (const char of ["k", "e", "p", "t"]) panel.handleInput(char);
				panel.handleInput(KEYS.enter);
				assert.equal(resolved(), undefined, "renaming stays inside the panel");
				await new Promise((resolve) => setTimeout(resolve, 50));
				assert.ok(plain(panel.render(WIDTH)).includes("Renamed to"), plain(panel.render(WIDTH)));
				assert.ok(plain(panel.render(WIDTH)).includes("kept"), "the list reflects the new name");
				assert.ok(existsSync(target.path), "the session file is untouched");
			} finally {
				env2.cleanup();
			}
		});

		it("leaves rename mode on Esc without changing anything", async () => {
			box.action = undefined;
			const panel = build();
			selectRow(panel, 1);
			panel.handleInput("r");
			panel.handleInput("X");
			assert.ok(plain(panel.render(WIDTH)).includes("rename alpha only sessionX"), plain(panel.render(WIDTH)));
			panel.handleInput(KEYS.escape);
			assert.equal(resolved(), undefined);
			assert.ok(plain(panel.render(WIDTH)).includes("n new"), "hints are back");
		});

		it("does nothing when the selection is not a session row", () => {
			box.action = undefined;
			const panel = build();
			panel.handleInput("r"); // row 0 is a workspace row
			assert.ok(plain(panel.render(WIDTH)).includes("n new"), "still on the list");
		});
	});

	describe("delete", () => {
		it("asks for confirmation and cancels on n", async () => {
			box.action = undefined;
			const panel = build();
			selectRow(panel, 1);
			panel.handleInput("d");
			const text = plain(panel.render(WIDTH));
			assert.ok(text.includes("delete"), text);
			assert.ok(text.includes("(y/n)"), text);
			panel.handleInput("n");
			assert.equal(resolved(), undefined);
			assert.ok(plain(panel.render(WIDTH)).includes("n new"));
			assert.ok(existsSync(alphaSession.path), "the session survives");
		});

		it("removes the file on y and reloads the list", async () => {
			box.action = undefined;
			const env2 = createEnv();
			try {
				const target = writeSession(env2.root, { cwd: env2.dirs.alpha, message: "delete target" });
				const panel = new WorkspacePanel({
					theme,
					tui: { terminal: { rows: 42, columns: 120 }, requestRender: () => {} } as unknown as PanelDeps["tui"],
					currentCwd: env2.dirs.alpha,
					workspaces: await loadWorkspaces({ currentCwd: env2.dirs.alpha, sessionsDir: env2.root }),
					reload: () => loadWorkspaces({ currentCwd: env2.dirs.alpha, sessionsDir: env2.root }),
					rename: renameSession,
					remove: deleteSession,
					done: (action) => {
						box.action = action;
					},
				});
				selectRow(panel, 1);
				panel.handleInput("d");
				panel.handleInput("y");
				await new Promise((resolve) => setTimeout(resolve, 100));
				assert.equal(existsSync(target.path), false, "file removed");
				const text = plain(panel.render(WIDTH));
				assert.ok(text.includes("Moved to trash") || text.includes("Deleted"), text);
				assert.equal(text.includes("delete target"), false, "the row is gone");
			} finally {
				env2.cleanup();
			}
		});

		it("refuses to delete the session you are inside", () => {
			box.action = undefined;
			const panel = build({ currentSessionFile: alphaSession.path });
			selectRow(panel, 1);
			panel.handleInput("d");
			assert.equal(resolved(), undefined);
			assert.ok(plain(panel.render(WIDTH)).includes("Cannot delete the session you are in"));
			assert.ok(existsSync(alphaSession.path));
		});
	});

	describe("filter interaction", () => {
		it("keeps action keys disabled while a filter is present", () => {
			box.action = undefined;
			const panel = build({ initialFilter: "gam" });
			panel.handleInput("d");
			panel.handleInput("q");
			assert.equal(resolved(), undefined, "q/d are filter text while a filter is active");
		});
	});
});

describe("panel fixtures stay honest", () => {
	it("exposes a session whose path is a real file", () => {
		const env = createEnv();
		try {
			const session = writeSession(env.root, { cwd: env.dirs.gamma, message: "honest" });
			assert.ok(existsSync(session.path));
		} finally {
			env.cleanup();
		}
	});
});
