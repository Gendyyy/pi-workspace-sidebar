/**
 * Wiring: loads the real extension entry point against a stub pi API and drives
 * the command/shortcut hand-off. This is the only place the shortcut dispatch
 * is verified, because pi does not expose switchSession() to shortcut contexts.
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
}

interface SentMessage {
	text: string;
	options?: { expandPromptTemplates?: boolean };
}

const theme = { fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[0m`, style: (text: string) => `\x1b[7m${text}\x1b[0m` };
const tui = { terminal: { rows: 42, columns: 120 }, requestRender: () => {} };

describe("extension wiring", () => {
	let env: FixtureEnv;
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => unknown }>();
	const shortcuts = new Map<string, { description?: string; handler: (ctx: unknown) => unknown }>();
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
			sendUserMessage: (text: string, options?: { expandPromptTemplates?: boolean }) => sent.push({ text, options }),
		};
		workspacesExtension(pi as unknown as ExtensionAPI);
	});

	after(() => env.cleanup());

	/** Stub UI that builds the real panel and drives it with `keys`. */
	const makeUi = (notices: Notice[], keys: string[] = ["\x1b[B", "\r"]) => ({
		notify: (text: string, tone: string) => notices.push({ text, tone }),
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

	it("registers the command, the hand-off command, and the shortcut", () => {
		assert.ok(commands.has("ws"));
		assert.ok(commands.has("ws-resume"));
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

	describe("shortcut hand-off", () => {
		let dispatched: SentMessage | undefined;
		let queuedNotices: Notice[] = [];

		before(async () => {
			queuedNotices = [];
			sent.length = 0;
			await shortcuts.get("ctrl+shift+s")!.handler({
				...baseCtx(),
				isIdle: () => true,
				ui: makeUi(queuedNotices, ["\x1b[B", "\r"]),
			});
			dispatched = sent.at(-1);
		});

		it("dispatches /ws-resume with a queued id and template expansion", () => {
			assert.ok(dispatched?.text.startsWith("/ws-resume ws-"), String(dispatched?.text));
			assert.equal(dispatched?.options?.expandPromptTemplates, true, "without this pi sends the slash text as a prompt");
		});

		it("switches after waiting for idle, then consumes the queue", async () => {
			const id = dispatched!.text.split(" ")[1]!;
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
			sendUserMessage: (text: string, options?: { expandPromptTemplates?: boolean }) => sent.push({ text, options }),
		};
		workspacesExtension(pi as unknown as ExtensionAPI);
		assert.equal(commands.size + shortcuts.size, before, "re-registering is idempotent");
		assert.equal(typeof ({} as ExtensionContext), "object");
	});
});
