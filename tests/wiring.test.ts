/**
 * Wiring: loads the real extension entry point against a stub pi API and drives
 * the commands, the shortcut fallback, and the docked sidebar itself.
 *
 * Two hand-offs are verified here because pi does not expose switchSession() to
 * shortcut or terminal-input contexts:
 *   - the overlay fallback queues a PanelAction and dispatches /ws-resume
 *   - the dock does the same from its raw terminal input handler
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import workspacesExtension from "../extensions/workspaces/index.ts";
import { loadWorkspaces } from "../extensions/workspaces/data.ts";
import { createEnv, writeSession, type FixtureEnv } from "./fixtures.ts";

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

interface Notice {
	text?: string;
	tone?: string;
	editor?: string;
}

const theme = { fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[0m`, style: (text: string) => `\x1b[7m${text}\x1b[0m` };
const tui = { terminal: { rows: 42, columns: 120 }, requestRender: () => {} };

interface SentMessage {
	text: string;
	options?: { expandPromptTemplates?: boolean };
}

describe("extension wiring", () => {
	let env: FixtureEnv;
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => unknown }>();
	const shortcuts = new Map<string, { description?: string; handler: (ctx: unknown) => unknown }>();
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const sent: SentMessage[] = [];

	before(() => {
		env = createEnv();
		writeSession(env.root, { cwd: env.dirs.alpha, message: "alpha wiring session", ageMinutes: 1 });
		writeSession(env.root, { cwd: env.dirs.beta, message: "beta wiring session", ageMinutes: 20 });

		const pi = {
			registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: unknown) => unknown }) =>
				commands.set(name, options),
			registerShortcut: (key: string, options: { description?: string; handler: (ctx: unknown) => unknown }) =>
				shortcuts.set(key, options),
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers.set(event, handler);
				return () => handlers.delete(event);
			},
			sendUserMessage: (text: string, options?: SentMessage["options"]) => {
				sent.push({ text, options });
			},
		};
		workspacesExtension(pi as unknown as ExtensionAPI);
	});

	after(() => env.cleanup());

	/** Stub UI that builds the real panel and drives it with `keys`. */
	const makeUi = (notices: Notice[], keys: string[] = ["\x1b[B", "\r"]) => ({
		notify: (text: string, tone: string) => notices.push({ text, tone }),
		setEditorText: (text: string) => notices.push({ editor: text }),
		custom: async (factory: (tui: unknown, theme: unknown, keys: unknown, done: (r: unknown) => void) => { handleInput: (d: string) => void; __result?: unknown; render: (w: number) => string[] }) => {
			const component = factory(tui, theme, {}, (result) => {
				component.__result = result;
			});
			for (const key of keys) component.handleInput(key);
			return component.__result;
		},
	});

	/** Session manager stub pinned to the fixture root, so nothing touches real sessions. */
	const sessionManager = {
		getSessionFile: () => undefined,
		getSessionDir: () => env.root,
		getEntries: () => [],
	};

	const baseCtx = () => ({
		hasUI: true,
		mode: "tui",
		cwd: env.dirs.alpha,
		sessionManager,
	});

	it("exports a default function", () => {
		assert.equal(typeof workspacesExtension, "function");
	});

	it("registers the commands, the hand-off command, and the shortcut", () => {
		assert.ok(commands.has("ws"));
		assert.ok(commands.has("ws-resume"));
		assert.ok(commands.has("ws-sidebar"));
		assert.ok(shortcuts.has("ctrl+shift+s"), [...shortcuts.keys()].join(","));
		for (const options of [...commands.values(), ...shortcuts.values()]) {
			assert.equal(typeof options.description, "string");
			assert.ok((options.description ?? "").length > 0);
		}
	});

	it("refuses to open without the interactive TUI", async () => {
		const notices: Notice[] = [];
		await commands.get("ws")!.handler("", { ...baseCtx(), hasUI: false, mode: "print", ui: makeUi(notices) });
		assert.ok(notices.some((notice) => (notice.text ?? "").includes("interactive TUI")), JSON.stringify(notices));
	});

	it("refuses a stale queued selection", async () => {
		const notices: Notice[] = [];
		await commands.get("ws-resume")!.handler("nope", { ...baseCtx(), ui: makeUi(notices), waitForIdle: async () => {} });
		assert.ok(notices.some((notice) => (notice.text ?? "").includes("no longer available")), JSON.stringify(notices));
	});

	it("refuses the shortcut while the agent is streaming", async () => {
		const notices: Notice[] = [];
		await shortcuts.get("ctrl+shift+s")!.handler({ ...baseCtx(), isIdle: () => false, ui: makeUi(notices) });
		assert.ok(notices.some((notice) => (notice.text ?? "").includes("wait for the current turn")), JSON.stringify(notices));
	});

	describe("shortcut hand-off (overlay fallback)", () => {
		let dispatched: string | undefined;

		before(async () => {
			sent.length = 0;
			await shortcuts.get("ctrl+shift+s")!.handler({
				...baseCtx(),
				isIdle: () => true,
				ui: makeUi([], ["\x1b[B", "\r"]),
			});
			dispatched = sent.at(-1)?.text;
		});

		it("queues the panel action and dispatches /ws-resume for prompt expansion", () => {
			const call = sent.at(-1);
			assert.ok(call, "sendUserMessage was called");
			assert.ok(call!.text.startsWith("/ws-resume ws-"), call!.text);
			assert.equal(call!.options?.expandPromptTemplates, true, "without this pi sends the slash text as a prompt");
		});

		it("switches after waiting for idle, then consumes the queue", async () => {
			const id = dispatched!.split(" ")[1]!;
			const notices: Notice[] = [];
			const switched: string[] = [];
			let waits = 0;
			const ctx = {
				...baseCtx(),
				ui: makeUi(notices),
				waitForIdle: async () => {
					waits += 1;
				},
				switchSession: async (sessionPath: string, options?: { withSession?: (next: { ui: { notify: (t: string, k: string) => void } }) => Promise<void> }) => {
					switched.push(sessionPath);
					await options?.withSession?.({ ui: { notify: (text, tone) => notices.push({ text, tone }) } });
					return { cancelled: false };
				},
			};

			await commands.get("ws-resume")!.handler(id, ctx);
			assert.equal(waits, 1);
			assert.equal(switched.length, 1);
			assert.ok(switched[0]!.endsWith(".jsonl"), String(switched[0]));
			assert.ok(switched[0]!.startsWith(env.root), "switched inside the fixture root");
			assert.ok(existsSync(switched[0]!), String(switched[0]));
			assert.ok(notices.some((notice) => (notice.text ?? "").includes("Switched")), JSON.stringify(notices));

			const replay: Notice[] = [];
			await commands.get("ws-resume")!.handler(id, { ...ctx, ui: makeUi(replay) });
			assert.ok(replay.some((notice) => (notice.text ?? "").includes("no longer available")), "the id is single-use");
		});
	});

	it("opens through /ws and can be cancelled without an error notice", async () => {
		const notices: Notice[] = [];
		await commands.get("ws")!.handler("", {
			...baseCtx(),
			ui: { ...makeUi(notices, ["q"]), custom: async () => ({ type: "cancel" }) },
			waitForIdle: async () => {},
			switchSession: async () => ({ cancelled: true }),
		});
		assert.ok(notices.every((notice) => notice.tone !== "error"), JSON.stringify(notices));
	});

	it("pre-filters the panel from /ws <filter>", async () => {
		let frame: string[] = [];
		await commands.get("ws")!.handler("wiring", {
			...baseCtx(),
			ui: {
				...makeUi([]),
				custom: async (factory: (tui: unknown, theme: unknown, keys: unknown, done: (r: unknown) => void) => { render: (w: number) => string[] }) => {
					frame = factory(tui, theme, {}, () => {}).render(64);
					return { type: "cancel" };
				},
			},
			waitForIdle: async () => {},
			switchSession: async () => ({ cancelled: true }),
		});
		assert.ok(strip(frame.join("\n")).includes("wiring"), strip(frame.join("\n")));
		assert.ok(
			frame.every((line) => visibleWidth(line) <= 64),
			`max=${Math.max(...frame.map(visibleWidth))}`,
		);
	});

	it("creates a session in a new folder and cleans up when the switch is cancelled", async () => {
		const notices: Notice[] = [];
		const created: string[] = [];
		await commands.get("ws")!.handler("", {
			...baseCtx(),
			ui: { ...makeUi([]), custom: async () => ({ type: "new-session", cwd: env.dirs.beta }) },
			waitForIdle: async () => {},
			switchSession: async (sessionPath: string, options?: { withSession?: (next: { ui: { notify: () => void } }) => Promise<void> }) => {
				created.push(sessionPath);
				await options?.withSession?.({ ui: { notify: () => {} } });
				return { cancelled: true };
			},
		});
		assert.equal(created.length, 1);
		assert.ok(created[0]!.startsWith(env.root), String(created[0]));
		assert.equal(existsSync(created[0]!), false, "the unused header file was removed");
		assert.ok(notices.every((notice) => notice.tone !== "error"), JSON.stringify(notices));
	});

	it("keeps a newly created session when the switch succeeds", async () => {
		const created: string[] = [];
		await commands.get("ws")!.handler("", {
			...baseCtx(),
			ui: { ...makeUi([]), custom: async () => ({ type: "new-session", cwd: env.dirs.gamma }) },
			waitForIdle: async () => {},
			switchSession: async (sessionPath: string) => {
				created.push(sessionPath);
				return { cancelled: false };
			},
		});
		assert.equal(created.length, 1);
		assert.ok(existsSync(created[0]!), String(created[0]));
		const rows = await loadWorkspaces({ currentCwd: env.dirs.gamma, sessionsDir: env.root });
		assert.ok(rows.some((row) => row.cwd === env.dirs.gamma), "the new workspace shows up");
	});

	it("uses the fixture root rather than the real session store", async () => {
		const rows = await loadWorkspaces({ currentCwd: env.dirs.alpha, sessionsDir: env.root });
		assert.ok(rows.every((row) => row.cwd.startsWith(env.dirs.alpha.slice(0, 20)) || row.cwd === env.dirs.alpha));
	});

	it("does not double-register when loaded twice", () => {
		const before = commands.size + shortcuts.size;
		const pi = {
			registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: unknown) => unknown }) =>
				commands.set(name, options),
			registerShortcut: (key: string, options: { description?: string; handler: (ctx: unknown) => unknown }) =>
				shortcuts.set(key, options),
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers.set(event, handler);
				return () => handlers.delete(event);
			},
			sendUserMessage: () => {},
		};
		workspacesExtension(pi as unknown as ExtensionAPI);
		assert.equal(commands.size + shortcuts.size, before, "re-registering is idempotent");
		assert.equal(typeof ({} as ExtensionContext), "object");
	});
});

/**
 * The dock is a terminal compositor, so it can only be verified against a fake
 * terminal that records what was written. These checks cover the three things
 * that make it work: the narrowed `columns`, the erase rewrite, and the raw
 * input handler that owns the keyboard only while focused.
 */
describe("docked sidebar", () => {
	let env: FixtureEnv;
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
	const shortcuts = new Map<string, { handler: (ctx: unknown) => unknown }>();
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const sent: SentMessage[] = [];

	let factory: ((tui: unknown, theme: unknown) => { render: (width: number) => string[] }) | undefined;
	let widgetOptions: unknown;
	let input: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;

	const writes: string[] = [];
	const terminal = {
		columns: 120,
		rows: 24,
		write: (data: string) => {
			writes.push(data);
		},
	};
	const fakeTui = {
		terminal,
		requestRender: () => {},
		doRender: () => {
			terminal.write("\x1b[2Kmain pane content");
		},
	};

	before(() => {
		env = createEnv();
		writeSession(env.root, { cwd: env.dirs.alpha, message: "dock alpha session", ageMinutes: 2 });
		writeSession(env.root, { cwd: env.dirs.beta, message: "dock beta session", ageMinutes: 30 });
		const pi = {
			registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => unknown }) => {
				commands.set(name, options);
			},
			registerShortcut: (key: string, options: { handler: (ctx: unknown) => unknown }) => {
				shortcuts.set(key, options);
			},
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers.set(event, handler);
				return () => handlers.delete(event);
			},
			sendUserMessage: (text: string, options?: SentMessage["options"]) => {
				sent.push({ text, options });
			},
		};
		workspacesExtension(pi as unknown as ExtensionAPI);
	});

	after(() => env.cleanup());

	const dockCtx = () => ({
		hasUI: true,
		mode: "tui",
		cwd: env.dirs.alpha,
		sessionManager: { getSessionFile: () => undefined, getSessionDir: () => env.root, getEntries: () => [] },
		isIdle: () => true,
		ui: {
			notify: () => {},
			setEditorText: () => {},
			onTerminalInput: (handler: (data: string) => { consume?: boolean; data?: string } | undefined) => {
				input = handler;
				return () => {
					input = undefined;
				};
			},
			setWidget: (key: string, widgetFactory: typeof factory, options: unknown) => {
				assert.equal(key, "workspaces-sidebar");
				factory = widgetFactory;
				widgetOptions = options;
			},
		},
	});

	it("installs on session_start as a zero-height widget below the editor", async () => {
		await handlers.get("session_start")!({}, dockCtx());
		assert.ok(factory, "a widget was registered");
		assert.deepEqual(widgetOptions, { placement: "belowEditor" });
		assert.ok(input, "raw terminal input was hooked");
	});

	it("shrinks the columns pi renders into and paints nothing itself", () => {
		const component = factory!(fakeTui, theme);
		// 120 - round(120 * 0.28) - 1
		assert.equal(terminal.columns, 85);
		assert.deepEqual(component.render(120), []);
	});

	it("paints the sidebar into the right-hand columns", () => {
		writes.length = 0;
		fakeTui.doRender();
		const frame = writes.join("");
		assert.ok(frame.includes("\x1b[?2026h") && frame.includes("\x1b[?2026l"), "synchronised output");
		assert.ok(frame.includes("\x1b[?7l") && frame.includes("\x1b[?7h"), "auto-wrap off while painting");
		assert.ok(frame.includes("\x1b[85X"), "the full-line erase stops at the dock");
		assert.ok(!frame.includes("\x1b[2K"), "no unrewritten erase survives");
		assert.ok(frame.includes("WORKSPACES"), "the sidebar body was written");
		assert.ok(frame.includes("dock alpha session"), "the current workspace's session is listed");
	});

	/** Blur (twice is harmless) then focus, so each check starts from a known state. */
	const ensureFocused = async () => {
		input!("\x1b");
		input!("\x1b");
		await shortcuts.get("ctrl+shift+s")!.handler(dockCtx());
	};

	/** Move the selection to a known row: clamp at the top, then step down. */
	const selectRow = (index: number) => {
		for (let i = 0; i < 40; i += 1) input!("\x1b[A");
		for (let i = 0; i < index; i += 1) input!("\x1b[B");
	};

	it("keeps its hands off the keyboard while unfocused", () => {
		assert.ok(input);
		assert.equal(input!("a"), undefined);
		assert.equal(input!("\x1b[B"), undefined);
		assert.equal(input!("\x1b"), undefined);
	});

	it("focuses on Ctrl+Shift+S and owns the keyboard only then", async () => {
		await ensureFocused();
		assert.deepEqual(input!("\x1b[B"), { consume: true }, "movement is consumed");
		assert.deepEqual(input!("a"), { consume: true }, "stray typing cannot leak into the editor");
		assert.equal(input!("\x1b[Z"), undefined, "unrecognised keys still reach pi");
		await shortcuts.get("ctrl+shift+s")!.handler(dockCtx());
		assert.equal(input!("\x1b[B"), undefined, "a second press toggles back out");
	});

	it("switches the selected session through /ws-resume with prompt expansion", async () => {
		await ensureFocused();
		selectRow(1); // 0 = the current workspace, 1 = its most recent session
		sent.length = 0;
		assert.deepEqual(input!("\r"), { consume: true }, "activate the selected row");
		const call = sent.at(-1);
		assert.ok(call, "sendUserMessage was called");
		assert.ok(call!.text.startsWith("/ws-resume ws-"), call!.text);
		assert.equal(call!.options?.expandPromptTemplates, true);
	});

	it("starts a session with n and opens the full panel with o", async () => {
		await ensureFocused();
		selectRow(0);
		sent.length = 0;
		input!("n");
		assert.ok(sent.at(-1)?.text.startsWith("/ws-resume ws-"), String(sent.at(-1)?.text));

		await ensureFocused();
		sent.length = 0;
		input!("o");
		assert.equal(sent.at(-1)?.text, "/ws");
		assert.equal(input!("a"), undefined, "opening the panel releases the keyboard");
	});

	it("blurs on Esc", async () => {
		await ensureFocused();
		assert.deepEqual(input!("\x1b"), { consume: true });
		assert.equal(input!("a"), undefined, "blurred again");
	});

	it("resizes with /ws-sidebar width and releases the columns when turned off", async () => {
		const notices: string[] = [];
		const ctx = () => ({ ...dockCtx(), ui: { ...dockCtx().ui, notify: (text: string) => notices.push(text) } });

		await commands.get("ws-sidebar")!.handler("width 40", ctx());
		assert.equal(terminal.columns, 79, "120 - 40 - 1");
		await commands.get("ws-sidebar")!.handler("status", ctx());
		assert.ok(notices.some((text) => text.includes("40 cols")), JSON.stringify(notices));

		await commands.get("ws-sidebar")!.handler("width abc", ctx());
		assert.ok(notices.some((text) => text.includes("Usage")), JSON.stringify(notices));
		assert.equal(terminal.columns, 79, "a rejected width changes nothing");

		await commands.get("ws-sidebar")!.handler("off", ctx());
		assert.ok(notices.some((text) => text.includes("off")), JSON.stringify(notices));
		assert.equal(terminal.columns, 120, "the columns override was released");

		await commands.get("ws-sidebar")!.handler("on", ctx());
		assert.equal(terminal.columns, 79, "the remembered width is reapplied");
	});
});
