/**
 * Data layer for the /ws workspaces sidebar.
 *
 * Reads pi's session store (via SessionManager), groups sessions into workspaces
 * by their recorded cwd, and owns the filesystem side effects a switcher needs:
 * renaming, deleting, and creating session files.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";

export interface SessionRow {
	/** Absolute path to the session JSONL file. Empty for a session not yet persisted. */
	path: string;
	title: string;
	/** Full-text content exposed by pi's session scanner, for local search. */
	searchText: string;
	created: Date;
	modified: Date;
	messageCount: number;
	/** True for the session pi currently has open. */
	isCurrent: boolean;
	/** True when the session's recorded cwd no longer exists on disk. */
	missingCwd: boolean;
}

export interface WorkspaceRow {
	/** Working directory this group of sessions belongs to. Empty for unreadable legacy sessions. */
	cwd: string;
	/** `~`-abbreviated cwd, or a placeholder for an unknown workspace. */
	label: string;
	sessions: SessionRow[];
	/** Most recently modified session, or epoch for an empty workspace. */
	modified: Date;
	isCurrent: boolean;
	missing: boolean;
	/** Current git branch of the workspace, read from .git/HEAD. */
	branch?: string;
}

const HOME = homedir();

/** Collapse the home prefix to `~` so long absolute paths stay readable. */
export function abbreviatePath(path: string): string {
	if (!path) return "(unknown workspace)";
	if (path === HOME) return "~";
	if (path.startsWith(`${HOME}/`)) return `~/${path.slice(HOME.length + 1)}`;
	return path;
}

/** Compact age string: 42s, 13m, 5h, 3d, 7mo, 2y. */
export function relativeTime(date: Date): string {
	const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days}d`;
	const months = Math.round(days / 30);
	if (months < 12) return `${months}mo`;
	return `${Math.round(months / 12)}y`;
}

/**
 * Prefer the user-set session name, then the first user message, then the id.
 * Whitespace is collapsed so multi-line prompts render as a single row.
 */
export function sessionTitle(session: SessionInfo): string {
	const named = session.name?.trim();
	if (named) return named;
	const first = session.firstMessage?.trim().replace(/\s+/g, " ");
	if (first) return first.length > 72 ? `${first.slice(0, 71)}…` : first;
	return session.id.slice(0, 8);
}

/** Resolve symlinks so two spellings of the same session compare equal. */
export function canonicalPath(path: string | undefined): string | undefined {
	if (!path) return undefined;
	try {
		return realpathSync(path);
	} catch {
		// Not on disk (yet): still normalize spelling so trailing slashes and
		// `..` segments cannot make two identical paths compare unequal.
		return resolve(path);
	}
}

/**
 * Read the checked-out branch without spawning git: .git/HEAD is either
 * `ref: refs/heads/<branch>` or a detached commit sha. In a worktree .git is a
 * file pointing at the real git dir.
 */
function readGitBranch(cwd: string): string | undefined {
	try {
		let gitDir = join(cwd, ".git");
		if (!existsSync(gitDir)) return undefined;
		if (statSync(gitDir).isFile()) {
			const pointer = readFileSync(gitDir, "utf-8").trim();
			const match = /^gitdir:\s*(.+)$/m.exec(pointer);
			if (!match?.[1]) return undefined;
			const target = match[1].trim();
			gitDir = isAbsolute(target) ? target : resolve(cwd, target);
		}
		const head = readFileSync(join(gitDir, "HEAD"), "utf-8").trim();
		const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
		if (ref?.[1]) return ref[1];
		return head.slice(0, 8);
	} catch {
		return undefined;
	}
}

/**
 * Pi's own encoding of a cwd into a session directory name
 * (see getDefaultSessionDirPath in pi's session-manager).
 */
function encodedCwdDirName(cwd: string): string {
	const resolved = canonicalPath(cwd) ?? resolve(cwd);
	return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * Decide whether to list the default session root or a user-configured one.
 *
 * By default `getSessionDir()` is the cwd-scoped folder
 * `<agentDir>/sessions/--<encoded-cwd>--`, and `listAll()` with no argument
 * already walks the whole root, so those must not be passed on. A sessionDir
 * configured through `--session-dir`, the `sessionDir` setting, or
 * `PI_CODING_AGENT_SESSION_DIR` is a flat root instead and must be passed.
 */
export function sessionsRootFor(sessionDir: string | undefined, cwd: string): string | undefined {
	if (!sessionDir) return undefined;
	return sessionDir === encodedCwdDirName(cwd) || sessionDir.endsWith(`/sessions/${encodedCwdDirName(cwd)}`)
		? undefined
		: sessionDir;
}

export interface LoadOptions {
	/** cwd of the running pi session; always surfaced even with no sessions on disk. */
	currentCwd: string;
	/** Session file pi currently has open, if it has been persisted. */
	currentSessionFile?: string;
	/**
	 * Session root to scan. Omit for the default `~/.pi/agent/sessions` tree;
	 * pass it when the user configured a custom sessionDir (pi keeps that
	 * directory flat, so the tree walk would find nothing).
	 */
	sessionsDir?: string;
}

/** Group every session on disk into workspaces, most recently used first. */
export async function loadWorkspaces(options: LoadOptions): Promise<WorkspaceRow[]> {
	let sessions: SessionInfo[] = [];
	try {
		sessions = await SessionManager.listAll(options.sessionsDir);
	} catch {
		sessions = [];
	}

	const byCwd = new Map<string, SessionInfo[]>();
	for (const session of sessions) {
		const cwd = session.cwd || "";
		const bucket = byCwd.get(cwd);
		if (bucket) bucket.push(session);
		else byCwd.set(cwd, [session]);
	}
	if (options.currentCwd && !byCwd.has(options.currentCwd)) {
		byCwd.set(options.currentCwd, []);
	}

	const currentFile = canonicalPath(options.currentSessionFile);
	const workspaces: WorkspaceRow[] = [];

	for (const [cwd, list] of byCwd) {
		const rows: SessionRow[] = list.map((session) => ({
			path: session.path,
			title: sessionTitle(session),
			searchText: session.allMessagesText.toLowerCase(),
			created: session.created,
			modified: session.modified,
			messageCount: session.messageCount,
			isCurrent: currentFile !== undefined && canonicalPath(session.path) === currentFile,
			missingCwd: Boolean(session.cwd) && !existsSync(session.cwd),
		}));
		rows.sort((a, b) => b.modified.getTime() - a.modified.getTime());

		workspaces.push({
			cwd,
			label: abbreviatePath(cwd),
			sessions: rows,
			modified: rows[0]?.modified ?? new Date(0),
			isCurrent: Boolean(cwd) && cwd === options.currentCwd,
			missing: Boolean(cwd) && !existsSync(cwd),
			branch: cwd ? readGitBranch(cwd) : undefined,
		});
	}

	workspaces.sort((a, b) => {
		if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
		return b.modified.getTime() - a.modified.getTime();
	});
	return workspaces;
}

/** Set a session's display name by appending a session_info entry to its file. */
export function renameSession(sessionPath: string, name: string): { ok: boolean; error?: string } {
	const next = name.trim();
	if (!next) return { ok: false, error: "Name cannot be empty" };
	// SessionManager.open() tolerates a missing path and appendSessionInfo() then
	// silently does nothing, so a vanished file would otherwise look like success.
	if (!existsSync(sessionPath)) return { ok: false, error: "Session file not found" };
	try {
		SessionManager.open(sessionPath).appendSessionInfo(next);
		const applied = SessionManager.open(sessionPath).getSessionName();
		if (applied !== next) return { ok: false, error: "Rename was not applied" };
		return { ok: true };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Delete a session file, preferring the macOS `trash` CLI so the file stays
 * recoverable, then falling back to a permanent unlink (same policy as pi's
 * own /resume picker).
 */
export async function deleteSession(sessionPath: string): Promise<{ ok: boolean; method?: string; error?: string }> {
	const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
	const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });
	const trashHint = [
		trashResult.error ? trashResult.error.message : undefined,
		String(trashResult.stderr ?? "").trim().split("\n")[0],
	]
		.filter(Boolean)
		.join(" · ");

	if (trashResult.status === 0 || !existsSync(sessionPath)) return { ok: true, method: "trash" };

	try {
		await unlink(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, method: "unlink", error: trashHint ? `${message} (trash: ${trashHint})` : message };
	}
}

export interface DirectoryEntry {
	name: string;
	path: string;
}

/** Direct subdirectories of `dir`, for the folder browser. Symlinks are resolved. */
export function listDirectories(dir: string): { entries: DirectoryEntry[]; error?: string } {
	try {
		const entries = readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
			.filter((entry) => {
				try {
					return statSync(join(dir, entry.name)).isDirectory();
				} catch {
					return false;
				}
			})
			.map((entry) => ({ name: entry.name, path: join(dir, entry.name) }))
			.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
		return { entries };
	} catch (error) {
		return { entries: [], error: error instanceof Error ? error.message : String(error) };
	}
}

/** Parent of `dir`, or undefined at the filesystem root. */
export function parentDirectory(dir: string): string | undefined {
	const parent = resolve(dir, "..");
	return parent === dir ? undefined : parent;
}

/** Expand a leading `~` so typed paths work in the folder browser. */
export function expandHome(path: string): string {
	if (path === "~") return HOME;
	if (path.startsWith("~/")) return join(HOME, path.slice(2));
	return path;
}

/**
 * Create a session file for `cwd` so it can be handed to switchSession().
 *
 * SessionManager only writes a file once a conversation exists, so the header
 * is flushed by hand. The caller owns cleanup: if the switch is cancelled this
 * one-line file is dead weight.
 */
export function createNewSessionFile(cwd: string, sessionsDir?: string): { path?: string; error?: string } {
	try {
		const manager = SessionManager.create(cwd, sessionsDir);
		const sessionFile = manager.getSessionFile();
		const header = manager.getHeader();
		if (!sessionFile || !header) return { error: "Could not create a persisted session" };
		if (!existsSync(sessionFile)) {
			writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, { flag: "wx" });
		}
		return { path: sessionFile };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** Best-effort cleanup of a session file created only to satisfy a switch. */
export async function removeEmptySessionFile(sessionPath: string): Promise<void> {
	try {
		if (statSync(sessionPath).size > 4096) return;
		const lines = readFileSync(sessionPath, "utf-8").trim().split("\n").filter(Boolean);
		if (lines.length !== 1) return;
		const header = JSON.parse(lines[0]!) as { type?: string };
		if (header.type !== "session") return;
		await unlink(sessionPath);
	} catch {
		// Ignore: cleanup is opportunistic.
	}
}
