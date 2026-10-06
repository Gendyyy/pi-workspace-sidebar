/**
 * Hermetic fixtures: every test gets its own temp sessions root and project
 * directories, so the suite never reads or writes the real
 * `~/.pi/agent/sessions` tree.
 *
 * Session files are written by hand (rather than through SessionManager) so
 * each entry can carry an explicit timestamp; pi derives a session's modified
 * time from its last entry, so back-dating entries is the only way to control
 * recency. The line shapes below mirror a real file produced by
 * SessionManager.create() + appendMessage().
 */
import { randomUUID, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export interface FixtureEnv {
	/** Temp sessions root, passed as `sessionsDir` so `listAll` scans only this. */
	root: string;
	/** Temp project directories: alpha, beta, gamma exist; ghost does not. */
	dirs: Record<"alpha" | "beta" | "gamma" | "ghost", string>;
	cleanup(): void;
}

export function createEnv(): FixtureEnv {
	const base = mkdtempSync(join(tmpdir(), "pi-ws-fixtures-"));
	const root = join(base, "sessions");
	mkdirSync(root, { recursive: true });
	const dirs = {} as FixtureEnv["dirs"];
	for (const name of ["alpha", "beta", "gamma"] as const) {
		dirs[name] = join(base, name);
		mkdirSync(dirs[name], { recursive: true });
	}
	dirs.ghost = join(base, "ghost-does-not-exist");
	return { root, dirs, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export interface SessionSpec {
	/** Working directory recorded in the header. */
	cwd: string;
	/** First user message; omitted entirely when undefined. */
	message?: string;
	/** Extra user messages appended after the first. */
	extraMessages?: number;
	/** Back-date every entry by this many minutes. */
	ageMinutes?: number;
	/** Display name, written through the real appendSessionInfo() API. */
	name?: string;
}

export interface FixtureSession {
	path: string;
	id: string;
}

export function writeSession(root: string, spec: SessionSpec): FixtureSession {
	const id = randomUUID();
	const ageMs = (spec.ageMinutes ?? 0) * 60_000;
	const stamp = (offsetMs = 0) => new Date(Date.now() - ageMs - offsetMs).toISOString();
	const line = (entry: Record<string, unknown>) => JSON.stringify(entry);

	const lines: string[] = [line({ type: "session", version: 3, id, timestamp: stamp(), cwd: spec.cwd })];
	const total = spec.message === undefined ? 0 : 1 + (spec.extraMessages ?? 0);
	let parentId: string | null = null;
	for (let i = 0; i < total; i += 1) {
		const entryId = randomBytes(4).toString("hex");
		lines.push(
			line({
				type: "message",
				id: entryId,
				parentId,
				timestamp: stamp(-(total - i) * 1_000),
				message: { role: "user", content: i === 0 ? spec.message : `follow-up ${i}` },
			}),
		);
		parentId = entryId;
	}

	const fileName = `${stamp().replace(/[:.]/g, "-")}_${id}.jsonl`;
	const path = join(root, fileName);
	writeFileSync(path, `${lines.join("\n")}\n`);
	const when = new Date(Date.now() - ageMs);
	utimesSync(path, when, when);

	// Renaming goes through pi so the session_info entry shape stays real.
	if (spec.name !== undefined) SessionManager.open(path, root).appendSessionInfo(spec.name);
	return { path, id };
}

/** Point `<dir>/.git/HEAD` at a branch so the panel's branch read has something to find. */
export function writeGitHead(dir: string, branch: string): void {
	const gitDir = join(dir, ".git");
	mkdirSync(gitDir, { recursive: true });
	writeFileSync(join(gitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
}

/** Same, but for a worktree where `.git` is a file pointing at the real git dir. */
export function writeWorktreeGitFile(dir: string, realGitDir: string, branch: string): void {
	mkdirSync(realGitDir, { recursive: true });
	writeFileSync(join(realGitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
	writeFileSync(join(dir, ".git"), `gitdir: ${realGitDir}\n`);
}
