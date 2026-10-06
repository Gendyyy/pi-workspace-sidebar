/**
 * Renders the panel to PNG for the README and the pi.dev gallery.
 *
 * Run with: npx tsx scripts/screenshot.mts
 *
 * Fixtures live in a temp tree, and HOME is redirected at it so the panel
 * shows realistic `~/SourceTree/...` labels instead of /var/folders noise.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkspaces, renameSession, deleteSession } from "../extensions/workspaces/data.ts";
import { WorkspacePanel, type PanelAction, type PanelDeps } from "../extensions/workspaces/panel.ts";
import { writeSession } from "../tests/fixtures.ts";

const root = join(tmpdir(), "pi-ws-screenshot");
rmSync(root, { recursive: true, force: true });
const home = join(root, "home");
mkdirSync(home, { recursive: true });

// os.homedir() honours $HOME, so abbreviatePath() renders "~/..." below.
process.env.HOME = home;
const sessions = join(root, "sessions");
mkdirSync(sessions, { recursive: true });
const at = (relative: string) => join(home, relative);

/** ayu-mirage-ish palette; emitted as truecolor so the PNG renderer can parse it. */
const PALETTE: Record<string, [number, number, number]> = {
	accent: [255, 204, 102],
	border: [61, 71, 89],
	borderMuted: [43, 50, 68],
	borderAccent: [89, 194, 255],
	text: [203, 204, 198],
	muted: [143, 154, 168],
	dim: [108, 118, 134],
	error: [255, 102, 102],
	warning: [255, 180, 84],
	success: [127, 217, 98],
	toolTitle: [89, 194, 255],
	toolOutput: [186, 191, 182],
	selectedBg: [45, 54, 70],
};
const rgb = (name: string): [number, number, number] => PALETTE[name] ?? [203, 204, 198];
const fgCode = (name: string) => {
	const [r, g, b] = rgb(name);
	return `\x1b[38;2;${r};${g};${b}m`;
};
const bgCode = (name: string) => {
	const [r, g, b] = rgb(name);
	return `\x1b[48;2;${r};${g};${b}m`;
};

const theme = {
	fg: (color: string, text: string) => `${fgCode(color)}${text}\x1b[39m`,
	style: (text: string, options: { fg?: string; bg?: string; bold?: boolean } = {}) =>
		`${options.bg ? bgCode(options.bg) : ""}${options.fg ? fgCode(options.fg) : ""}${options.bold ? "\x1b[1m" : ""}${text}\x1b[0m`,
} as unknown as PanelDeps["theme"];

const LAYOUT: Array<{ path: string; session: string; ageMinutes: number }> = [
	{ path: "SourceTree/OnCore/BI", session: "add the accrual mart to the nightly dbt run", ageMinutes: 4 },
	{ path: "SourceTree/OnCore/BI", session: "why is fact_encounter missing payer keys", ageMinutes: 190 },
	{ path: "SourceTree/DeepMed", session: "port the OCR pipeline to the new bucket", ageMinutes: 52 },
	{ path: "SourceTree/DeepMed", session: "note to self: rerun the eval after the split fix", ageMinutes: 1_500 },
	{ path: "SourceTree/COPH Python Scripts/coph/automation", session: "schedule the weekly refresh job", ageMinutes: 26 },
	{ path: "Desktop", session: "summarize this CSV before the standup", ageMinutes: 12 },
	{ path: "SourceTree/SummaryAccrualAutomationBun", session: "switch the uploader to the batching API", ageMinutes: 5_800 },
];

for (const item of LAYOUT) {
	const cwd = at(item.path);
	mkdirSync(cwd, { recursive: true });
	writeSession(sessions, { cwd, message: item.session, ageMinutes: item.ageMinutes });
}

const currentCwd = at("SourceTree/OnCore/BI");
const currentSessionFile = join(sessions, "--x--", "placeholder.jsonl");
const workspaces = await loadWorkspaces({ currentCwd, sessionsDir: sessions });
// Mark the newest BI session as the open one so the dot renders as current.
const currentPath = workspaces.find((row) => row.cwd === currentCwd)?.sessions[0]?.path;
const marked = workspaces.map((row) => ({
	...row,
	sessions: row.sessions.map((session) => ({ ...session, isCurrent: session.path === currentPath })),
}));

const ROWS = 26;
const WIDTH = 96;

function build(): WorkspacePanel {
	return new WorkspacePanel({
		theme,
		tui: { terminal: { rows: ROWS, columns: 120 }, requestRender: () => {} } as unknown as PanelDeps["tui"],
		currentCwd,
		workspaces: marked,
		reload: () => loadWorkspaces({ currentCwd, sessionsDir: sessions }),
		rename: renameSession,
		remove: deleteSession,
		done: (_action: PanelAction) => {},
	});
}

const shots: Array<{ name: string; keys: string[] }> = [
	{ name: "screenshot", keys: [] },
	{ name: "folder", keys: ["o"] },
	{ name: "rename", keys: ["\x1b[B", "r", "\x15", "b", "i", " ", "m", "a", "r", "t"] },
	{ name: "search", keys: ["/", "d", "e", "e", "p"] },
];

mkdirSync(join(import.meta.dirname, "..", "assets"), { recursive: true });
const ansiFiles: string[] = [];
for (const shot of shots) {
	const panel = build();
	for (const key of shot.keys) panel.handleInput(key);
	const target = join(import.meta.dirname, "..", "assets", `${shot.name}.ansi`);
	writeFileSync(target, `${panel.render(WIDTH).join("\n")}\n`);
	ansiFiles.push(shot.name);
}

const render = spawnSync("python3", [join(import.meta.dirname, "render_png.py"), ...ansiFiles], { stdio: "inherit" });
if (render.status !== 0) process.exit(render.status ?? 1);
console.log(`wrote ${ansiFiles.length} assets in assets/`);
console.log(`current session used for the dot: ${currentPath ?? "(none)"}`);
console.log(`currentSessionFile placeholder (unused): ${currentSessionFile}`);
