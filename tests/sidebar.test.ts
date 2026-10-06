/**
 * Sidebar renderer: pure functions over workspace rows, so every check here is
 * deterministic and touches no filesystem. Width assertions use visibleWidth()
 * because the renderer must never emit a line wider than the dock.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SessionRow, WorkspaceRow } from "../extensions/workspaces/data.ts";
import { renderSidebar, sidebarEntries, windowStart, type SidebarView } from "../extensions/workspaces/sidebar.ts";

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const plain = (lines: string[]) => strip(lines.join("\n"));

/** Named SGR codes keep the theme stub zero-width, so width math stays honest. */
const FG: Record<string, number> = {
	accent: 111,
	border: 60,
	borderMuted: 60,
	dim: 245,
	muted: 245,
	text: 252,
	success: 114,
	warning: 179,
	error: 203,
};
const BG: Record<string, number> = { selectedBg: 237 };

const theme = {
	fg: (color: string, text: string) => `\x1b[38;5;${FG[color] ?? 250}m${text}\x1b[39m`,
	style: (text: string, options?: { fg?: string; bg?: string; bold?: boolean }) => {
		const fg = options?.fg ? `\x1b[38;5;${FG[options.fg] ?? 250}m` : "";
		const bg = options?.bg ? `\x1b[48;5;${BG[options.bg] ?? 0}m` : "";
		return `${fg}${bg}${options?.bold ? "\x1b[1m" : ""}${text}\x1b[0m`;
	},
} as unknown as Theme;

const hasColor = (line: string, color: string) => line.includes(`\x1b[38;5;${FG[color]}m`);

const session = (over: Partial<SessionRow> = {}): SessionRow => ({
	path: "/tmp/session.jsonl",
	title: "session title",
	modified: new Date(Date.now() - 60_000),
	messageCount: 3,
	isCurrent: false,
	missingCwd: false,
	...over,
});

const workspace = (over: Partial<WorkspaceRow> = {}): WorkspaceRow => ({
	cwd: "/tmp/alpha",
	label: "~/alpha",
	sessions: [],
	modified: new Date(),
	isCurrent: false,
	missing: false,
	...over,
});

const view = (over: Partial<SidebarView> = {}): SidebarView => ({
	workspaces: [],
	expanded: new Set<string>(),
	selected: 0,
	focused: false,
	...over,
});

describe("sidebar entries", () => {
	const alpha = workspace({ cwd: "/a", label: "~/a", sessions: [session({ title: "one" }), session({ title: "two" })] });
	const beta = workspace({ cwd: "/b", label: "~/b", sessions: [session({ title: "three" })] });

	it("lists workspaces collapsed unless they are expanded", () => {
		const entries = sidebarEntries([alpha, beta], new Set());
		assert.equal(entries.length, 2);
		assert.deepEqual(entries.map((entry) => entry.kind), ["workspace", "workspace"]);
		assert.equal(entries[0]?.kind === "workspace" && entries[0].expanded, false);
	});

	it("nests sessions under expanded workspaces only", () => {
		const entries = sidebarEntries([alpha, beta], new Set(["/a"]));
		assert.deepEqual(
			entries.map((entry) => (entry.kind === "workspace" ? `ws:${entry.workspace.cwd}` : `s:${entry.session.title}`)),
			["ws:/a", "s:one", "s:two", "ws:/b"],
		);
	});

	it("keeps an empty expanded workspace as a lone row", () => {
		const empty = workspace({ cwd: "/c", label: "~/c", sessions: [] });
		const entries = sidebarEntries([empty], new Set(["/c"]));
		assert.equal(entries.length, 1);
	});
});

describe("windowStart", () => {
	it("does not scroll when everything fits", () => {
		assert.equal(windowStart(5, 10, 4), 0);
		assert.equal(windowStart(10, 10, 9), 0);
	});

	it("centres the selection when it can", () => {
		assert.equal(windowStart(100, 10, 50), 45);
	});

	it("clamps at both ends", () => {
		assert.equal(windowStart(100, 10, 0), 0);
		assert.equal(windowStart(100, 10, 99), 90);
	});

	it("always returns an in-range start", () => {
		for (const selected of [0, 1, 7, 20, 99, 500]) {
			const start = windowStart(100, 8, selected);
			assert.ok(start >= 0 && start <= 92, `start ${start} for ${selected}`);
		}
	});
});

describe("sidebar rendering", () => {
	const alpha = workspace({
		cwd: "/a",
		label: "~/alpha",
		branch: "main",
		isCurrent: true,
		sessions: [session({ title: "alpha current", isCurrent: true, messageCount: 7 }), session({ title: "alpha other" })],
	});
	const gamma = workspace({ cwd: "/g", label: "~/gamma", sessions: [session({ title: "gamma gone", missingCwd: true })] });

	it("draws the header, a rule, and a hint", () => {
		const lines = renderSidebar(view({ workspaces: [alpha], expanded: new Set(["/a"]) }), 40, 12, theme);
		assert.equal(lines.length, 12);
		assert.ok(strip(lines[0]!).includes("WORKSPACES"), strip(lines[0]!));
		assert.ok(visibleWidth(lines[1]!) === 40, String(visibleWidth(lines[1]!)));
		assert.ok(hasColor(lines[1]!, "borderMuted"));
		assert.ok(strip(lines.at(-1)!).includes("ctrl+shift+s"), strip(lines.at(-1)!));
	});

	it("shows the focus dot and navigation hints only while focused", () => {
		const idle = renderSidebar(view({ workspaces: [alpha] }), 40, 8, theme);
		assert.ok(!strip(idle[0]!).includes("●"), strip(idle[0]!));
		const focused = renderSidebar(view({ workspaces: [alpha], focused: true }), 40, 8, theme);
		assert.ok(strip(focused[0]!).includes("●"), strip(focused[0]!));
		assert.ok(hasColor(focused[0]!, "success"));
		assert.ok(strip(focused.at(-1)!).includes("switch"), strip(focused.at(-1)!));
	});

	it("marks the current workspace and shows its branch and session count", () => {
		const lines = renderSidebar(view({ workspaces: [alpha], expanded: new Set(["/a"]) }), 40, 8, theme);
		const row = strip(lines[2]!);
		assert.ok(row.includes("▾"), row);
		assert.ok(row.includes("~/alpha"), row);
		assert.ok(row.includes("⟨main⟩"), row);
		assert.ok(row.includes("(2)"), row);
		assert.ok(row.includes("●"), row);
		assert.ok(hasColor(lines[2]!, "accent"));
	});

	it("uses ▸ for a collapsed workspace", () => {
		const lines = renderSidebar(view({ workspaces: [alpha] }), 40, 8, theme);
		assert.ok(strip(lines[2]!).includes("▸"), strip(lines[2]!));
	});

	it("marks the current session and the missing-cwd session", () => {
		const lines = renderSidebar(view({ workspaces: [alpha, gamma], expanded: new Set(["/a", "/g"]) }), 40, 12, theme);
		const text = plain(lines);
		assert.ok(text.includes("● alpha current"), text);
		assert.ok(text.includes("○ alpha other"), text);
		assert.ok(text.includes("gamma gone ⚠"), text);
	});

	it("drops the message count on a narrow sidebar but keeps the relative time", () => {
		const wide = plain(renderSidebar(view({ workspaces: [alpha], expanded: new Set(["/a"]) }), 40, 8, theme));
		assert.ok(wide.includes("· 7"), wide);
		const narrow = plain(renderSidebar(view({ workspaces: [alpha], expanded: new Set(["/a"]) }), 20, 8, theme));
		assert.ok(!narrow.includes("· 7"), narrow);
		assert.ok(narrow.includes("1m"), narrow);
	});

	it("highlights the selected row with the selected background", () => {
		const lines = renderSidebar(view({ workspaces: [alpha], expanded: new Set(["/a"]), selected: 1, focused: true }), 40, 8, theme);
		assert.ok(lines[3]!.includes("\x1b[48;5;237m"), lines[3]!);
		assert.ok(!lines[2]!.includes("\x1b[48;5;237m"), lines[2]!);
	});

	it("renders an empty state when there are no workspaces", () => {
		const lines = renderSidebar(view(), 40, 8, theme);
		assert.ok(plain(lines).includes("no sessions yet"), plain(lines));
	});

	it("replaces the hints with a notice, toned by kind", () => {
		const warn = renderSidebar(view({ notice: { text: "wait for the current turn", tone: "warning" } }), 40, 8, theme);
		assert.ok(plain(warn).includes("wait for the current turn"), plain(warn));
		assert.ok(hasColor(warn.at(-1)!, "warning"));
		const error = renderSidebar(view({ notice: { text: "that session has no file", tone: "error" } }), 40, 8, theme);
		assert.ok(hasColor(error.at(-1)!, "error"));
	});

	it("keeps the selection inside a scrolling window", () => {
		const many = Array.from({ length: 20 }, (_, i) =>
			workspace({ cwd: `/w${i}`, label: `~/w${i}`, sessions: [session({ title: `s${i}` })] }),
		);
		const lines = renderSidebar(view({ workspaces: many, expanded: new Set(["/w19"]), selected: 21, focused: true }), 40, 8, theme);
		assert.ok(plain(lines).includes("s19"), plain(lines));
	});

	it("never emits a line wider than the dock, at any width", () => {
		const rows = [alpha, gamma, workspace({ cwd: "/e", label: "~/empty", sessions: [] })];
		for (const width of [12, 16, 20, 24, 28, 32, 40, 48, 60, 80, 120]) {
			for (const focused of [false, true]) {
				for (const height of [1, 2, 3, 4, 8, 20]) {
					const lines = renderSidebar(
						view({ workspaces: rows, expanded: new Set(["/a", "/g"]), selected: 3, focused }),
						width,
						height,
						theme,
					);
					assert.equal(lines.length, Math.max(1, height), `height ${height} at width ${width}`);
					for (const line of lines) {
						assert.ok(
							visibleWidth(line) <= Math.max(12, width),
							`width ${width}: ${visibleWidth(line)} > ${width} :: ${strip(line)}`,
						);
					}
				}
			}
		}
	});

	it("truncates a long workspace label instead of pushing the count off the row", () => {
		const deep = workspace({
			cwd: "/deep",
			label: "~/SourceTree/a-very-long-repository-name/nested/deeper/still-more",
			sessions: [session()],
		});
		const lines = renderSidebar(view({ workspaces: [deep] }), 40, 8, theme);
		const row = strip(lines[2]!);
		assert.ok(row.includes("…"), row);
		assert.ok(row.includes("(1)"), row);
		assert.ok(visibleWidth(lines[2]!) <= 40, String(visibleWidth(lines[2]!)));
	});
});
