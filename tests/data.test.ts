import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, appendFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import {
	abbreviatePath,
	canonicalPath,
	createNewSessionFile,
	deleteSession,
	expandHome,
	listDirectories,
	loadWorkspaces,
	parentDirectory,
	relativeTime,
	removeEmptySessionFile,
	renameSession,
	sessionTitle,
	sessionsRootFor,
} from "../extensions/workspaces/data.ts";
import { createEnv, writeGitHead, writeSession, writeWorktreeGitFile, type FixtureEnv } from "./fixtures.ts";

/** Pi's own cwd-to-directory encoding (getDefaultSessionDirPath in pi's session-manager). */
function encodedCwdDir(cwd: string): string {
	return `--${realpathSync(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Build the minimal SessionInfo shape sessionTitle() reads. */
const info = (partial: Partial<SessionInfo>): SessionInfo => partial as SessionInfo;

describe("pure helpers", () => {
	it("abbreviates the home directory and leaves other paths alone", () => {
		assert.equal(abbreviatePath(homedir()), "~");
		assert.equal(abbreviatePath(join(homedir(), "Desktop")), "~/Desktop");
		assert.equal(abbreviatePath("/opt/homebrew"), "/opt/homebrew");
		assert.equal(abbreviatePath(""), "(unknown workspace)");
	});

	it("expands a leading ~", () => {
		assert.equal(expandHome("~"), homedir());
		assert.equal(expandHome("~/Desktop"), join(homedir(), "Desktop"));
		assert.equal(expandHome("/opt"), "/opt");
	});

	it("formats compact ages", () => {
		const now = Date.now();
		assert.equal(relativeTime(new Date(now - 42_000)), "42s");
		assert.equal(relativeTime(new Date(now - 13 * 60_000)), "13m");
		assert.equal(relativeTime(new Date(now - 5 * 3_600_000)), "5h");
		assert.equal(relativeTime(new Date(now - 3 * 86_400_000)), "3d");
		assert.equal(relativeTime(new Date(now - 70 * 86_400_000)), "2mo");
		assert.equal(relativeTime(new Date(now - 800 * 86_400_000)), "2y");
		assert.equal(relativeTime(new Date(now + 60_000)), "0s", "future dates clamp to 0s");
	});

	it("titles a session from name, then first message, then id", () => {
		assert.equal(sessionTitle(info({ name: "  hi  ", firstMessage: "x", id: "abcdef12" })), "hi");
		assert.equal(sessionTitle(info({ name: " ", firstMessage: "  hello   world ", id: "abcdef12" })), "hello world");
		assert.equal(sessionTitle(info({ name: undefined, firstMessage: "", id: "abcdef123456" })), "abcdef12");
		const long = sessionTitle(info({ name: undefined, firstMessage: "x".repeat(200), id: "a" }));
		assert.equal(long.length, 72);
		assert.ok(long.endsWith("…"), "long prompts are truncated");
	});

	it("canonicalizes existing, missing, and undefined paths", () => {
		assert.equal(canonicalPath(tmpdir()), realpathSync(tmpdir()));
		assert.equal(canonicalPath("/tmp/pi-ws-definitely-missing/"), "/tmp/pi-ws-definitely-missing");
		assert.equal(canonicalPath(undefined), undefined);
	});

	it("walks parent directories and stops at the root", () => {
		assert.equal(parentDirectory("/Users/example/Desktop"), "/Users/example");
		assert.equal(parentDirectory("/"), undefined);
	});

	it("lists real subdirectories with names and absolute paths", () => {
		const listing = listDirectories(homedir());
		assert.ok(listing.entries.length > 0);
		for (const entry of listing.entries) {
			assert.ok(entry.name.length > 0);
			assert.equal(entry.path, join(homedir(), entry.name));
		}
		const names = listing.entries.map((entry) => entry.name);
		assert.deepEqual(
			names,
			[...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })),
			"entries are sorted case-insensitively",
		);
	});

	it("reports an error for an unreadable directory", () => {
		const listing = listDirectories("/definitely/not/here/xyz");
		assert.equal(listing.entries.length, 0);
		assert.equal(typeof listing.error, "string");
	});
});

describe("sessionsRootFor", () => {
	it("ignores the default cwd-scoped session directory", () => {
		assert.equal(sessionsRootFor(undefined, "/tmp"), undefined);
		const scoped = `${join("/home/example", ".pi/agent/sessions")}/${encodedCwdDir(homedir())}`;
		assert.equal(sessionsRootFor(scoped, homedir()), undefined, "suffix form is recognized");
	});

	it("passes through a configured session root", () => {
		assert.equal(sessionsRootFor("/custom/sessions", "/tmp"), "/custom/sessions");
	});
});

describe("loadWorkspaces", () => {
	let env: FixtureEnv;
	let alphaNewest: string;
	let alphaOldest: string;

	before(() => {
		env = createEnv();
		alphaNewest = writeSession(env.root, { cwd: env.dirs.alpha, message: "alpha newest session", ageMinutes: 1 }).path;
		alphaOldest = writeSession(env.root, {
			cwd: env.dirs.alpha,
			message: "alpha oldest session",
			ageMinutes: 100,
			extraMessages: 2,
		}).path;
		writeSession(env.root, { cwd: env.dirs.beta, message: "beta session", ageMinutes: 30 });
		writeSession(env.root, { cwd: env.dirs.gamma, message: "gamma session", ageMinutes: 200 });
		writeSession(env.root, { cwd: env.dirs.ghost, message: "orphaned session", ageMinutes: 5 });
		writeGitHead(env.dirs.alpha, "fixture-branch");
	});

	after(() => env.cleanup());

	it("groups sessions by cwd and sorts the current workspace first", async () => {
		const rows = await loadWorkspaces({ currentCwd: env.dirs.gamma, sessionsDir: env.root });
		assert.deepEqual(
			rows.map((row) => row.cwd),
			[env.dirs.gamma, env.dirs.alpha, env.dirs.ghost, env.dirs.beta],
			"current first, then by most recent session",
		);
		assert.equal(rows[0]?.isCurrent, true);
		assert.equal(rows.filter((row) => row.isCurrent).length, 1);
	});

	it("sorts sessions newest-first inside a workspace", async () => {
		const rows = await loadWorkspaces({ currentCwd: env.dirs.gamma, sessionsDir: env.root });
		const alpha = rows.find((row) => row.cwd === env.dirs.alpha);
		assert.ok(alpha);
		assert.deepEqual(
			alpha.sessions.map((session) => session.path),
			[alphaNewest, alphaOldest],
		);
		assert.equal(alpha.sessions[1]?.messageCount, 3);
	});

	it("labels workspaces and reads the git branch", async () => {
		const rows = await loadWorkspaces({ currentCwd: env.dirs.gamma, sessionsDir: env.root });
		const alpha = rows.find((row) => row.cwd === env.dirs.alpha);
		assert.ok(alpha);
		assert.ok(alpha.label.length > 0);
		assert.equal(alpha.branch, "fixture-branch");
		assert.equal(alpha.missing, false);
	});

	it("reads the branch of a worktree whose .git is a file", async () => {
		const realGitDir = join(env.dirs.beta, "real-git-dir");
		writeWorktreeGitFile(env.dirs.gamma, realGitDir, "worktree-branch");
		const rows = await loadWorkspaces({ currentCwd: env.dirs.gamma, sessionsDir: env.root });
		assert.equal(rows.find((row) => row.cwd === env.dirs.gamma)?.branch, "worktree-branch");
	});

	it("flags sessions whose workspace no longer exists", async () => {
		const rows = await loadWorkspaces({ currentCwd: env.dirs.gamma, sessionsDir: env.root });
		const ghost = rows.find((row) => row.cwd === env.dirs.ghost);
		assert.ok(ghost);
		assert.equal(ghost.missing, true);
		assert.equal(ghost.sessions[0]?.missingCwd, true);
	});

	it("marks the open session and only that one", async () => {
		const rows = await loadWorkspaces({
			currentCwd: env.dirs.alpha,
			currentSessionFile: alphaOldest,
			sessionsDir: env.root,
		});
		const current = rows.flatMap((row) => row.sessions).filter((session) => session.isCurrent);
		assert.deepEqual(
			current.map((session) => session.path),
			[alphaOldest],
		);
	});

	it("injects the current workspace even when it has no sessions", async () => {
		const empty = createEnv();
		try {
			const rows = await loadWorkspaces({ currentCwd: empty.dirs.alpha, sessionsDir: empty.root });
			assert.deepEqual(
				rows.map((row) => row.cwd),
				[empty.dirs.alpha],
			);
			assert.deepEqual(rows[0]?.sessions, []);
			assert.ok((rows[0]?.modified.getTime() ?? 1) === 0, "an empty workspace sorts at epoch");
		} finally {
			empty.cleanup();
		}
	});

	it("returns an empty list for an unknown session root", async () => {
		const rows = await loadWorkspaces({ currentCwd: "/tmp", sessionsDir: join(tmpdir(), "pi-ws-missing-root") });
		assert.deepEqual(
			rows.map((row) => row.cwd),
			["/tmp"],
		);
	});
});

describe("session file lifecycle", () => {
	let env: FixtureEnv;
	before(() => {
		env = createEnv();
	});
	after(() => env.cleanup());

	it("creates a switchable header-only session file", () => {
		const created = createNewSessionFile(env.dirs.alpha, env.root);
		assert.ok(created.path, JSON.stringify(created));
		const raw = readFileSync(created.path!, "utf8");
		assert.equal(raw.trim().split("\n").length, 1, "exactly the header line");
		const header = JSON.parse(raw.trim());
		assert.equal(header.type, "session");
		assert.equal(typeof header.id, "string");
		assert.equal(header.cwd, env.dirs.alpha);
	});

	it("removes a header-only session file but keeps one with messages", async () => {
		const empty = createNewSessionFile(env.dirs.alpha, env.root);
		await removeEmptySessionFile(empty.path!);
		assert.equal(existsSync(empty.path!), false);

		const used = writeSession(env.root, { cwd: env.dirs.alpha, message: "keep me" });
		await removeEmptySessionFile(used.path);
		assert.equal(existsSync(used.path), true, "a session with messages is never removed");

		const handWritten = createNewSessionFile(env.dirs.beta, env.root);
		appendFileSync(handWritten.path!, `${JSON.stringify({ type: "message" })}\n`);
		await removeEmptySessionFile(handWritten.path!);
		assert.equal(existsSync(handWritten.path!), true);
	});

	it("tolerates a missing file when removing", async () => {
		await removeEmptySessionFile(join(env.root, "gone.jsonl"));
	});

	it("deletes a session file", async () => {
		const target = writeSession(env.root, { cwd: env.dirs.alpha, message: "delete me" });
		const result = await deleteSession(target.path);
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.equal(existsSync(target.path), false);
	});

	it("renames through pi and reports a verified result", () => {
		const target = writeSession(env.root, { cwd: env.dirs.alpha, message: "rename me" });
		const before = readFileSync(target.path, "utf8");
		const result = renameSession(target.path, "renamed-by-test");
		assert.equal(result.ok, true, JSON.stringify(result));
		const after = readFileSync(target.path, "utf8");
		assert.ok(after.length > before.length, "rename appends an entry");
		assert.equal(SessionManager.open(target.path).getSessionName(), "renamed-by-test");

		// Names are append-only entries, so an empty name is the only way back.
		SessionManager.open(target.path).appendSessionInfo("");
		assert.equal(SessionManager.open(target.path).getSessionName(), undefined);
	});

	it("surfaces the renamed name as the session title", async () => {
		const target = writeSession(env.root, { cwd: env.dirs.alpha, message: "auto title here", name: "explicit name" });
		const rows = await loadWorkspaces({ currentCwd: env.dirs.alpha, sessionsDir: env.root });
		const row = rows
			.find((workspace) => workspace.cwd === env.dirs.alpha)
			?.sessions.find((session) => session.path === target.path);
		assert.equal(row?.title, "explicit name");
	});

	it("rejects a blank name and an unreadable path", () => {
		const target = writeSession(env.root, { cwd: env.dirs.beta, message: "guarded" });
		assert.equal(renameSession(target.path, "   ").ok, false);
		assert.equal(renameSession(join(env.root, "not-a-session.jsonl"), "x").ok, false);
		assert.equal(readFileSync(target.path, "utf8").includes("session_info"), false, "nothing was written");
	});

	it("keeps a fresh header inside the configured session root", () => {
		const created = createNewSessionFile(env.dirs.gamma, env.root);
		assert.ok(created.path?.startsWith(env.root), String(created.path));
	});
});
