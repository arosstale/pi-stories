/** FIFO merge queue with tiered conflict resolution */

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ConflictTier, MergeEntry, MergeStatus } from "../types.ts";

let db: Database | null = null;

export function initMergeDb(configDir: string): Database {
	if (db) return db;

	db = new Database(join(configDir, "merge-queue.db"));
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA busy_timeout=5000");

	db.exec(`
		CREATE TABLE IF NOT EXISTS merge_queue (
			id TEXT PRIMARY KEY,
			branch TEXT NOT NULL,
			agent_name TEXT NOT NULL,
			run_id TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			conflict_files TEXT,
			conflict_tier INTEGER,
			resolved_at TEXT,
			created_at TEXT NOT NULL
		)
	`);

	db.exec("CREATE INDEX IF NOT EXISTS idx_merge_status ON merge_queue(status)");

	return db;
}

export function enqueue(
	configDir: string,
	opts: { branch: string; agentName: string; runId: string },
): MergeEntry {
	const store = initMergeDb(configDir);
	const id = randomUUID().slice(0, 8);
	const now = new Date().toISOString();

	store
		.prepare(
			"INSERT INTO merge_queue (id, branch, agent_name, run_id, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
		)
		.run(id, opts.branch, opts.agentName, opts.runId, now);

	return {
		id,
		branch: opts.branch,
		agentName: opts.agentName,
		runId: opts.runId,
		status: "pending",
		createdAt: now,
	};
}

export function getQueue(configDir: string): MergeEntry[] {
	const store = initMergeDb(configDir);
	const rows = store.prepare("SELECT * FROM merge_queue ORDER BY created_at ASC").all() as Array<
		Record<string, unknown>
	>;
	return rows.map(rowToEntry);
}

export function getPending(configDir: string): MergeEntry[] {
	const store = initMergeDb(configDir);
	const rows = store
		.prepare("SELECT * FROM merge_queue WHERE status = 'pending' ORDER BY created_at ASC")
		.all() as Array<Record<string, unknown>>;
	return rows.map(rowToEntry);
}

export function updateMergeStatus(
	configDir: string,
	id: string,
	status: MergeStatus,
	conflictFiles?: string[],
	conflictTier?: ConflictTier,
): void {
	const store = initMergeDb(configDir);
	const now = new Date().toISOString();

	store
		.prepare(
			"UPDATE merge_queue SET status = ?, conflict_files = ?, conflict_tier = ?, resolved_at = ? WHERE id = ?",
		)
		.run(
			status,
			conflictFiles ? JSON.stringify(conflictFiles) : null,
			conflictTier ?? null,
			status === "merged" || status === "failed" ? now : null,
			id,
		);
}

/** Attempt to merge a branch into target using git */
export async function attemptMerge(
	cwd: string,
	branch: string,
	targetBranch: string,
): Promise<{ success: boolean; conflictFiles: string[] }> {
	// Try merge
	const proc = Bun.spawn(["git", "merge", "--no-ff", branch, "-m", `merge: ${branch}`], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});

	const exitCode = await proc.exited;

	if (exitCode === 0) {
		return { success: true, conflictFiles: [] };
	}

	// Get conflict files
	const statusProc = Bun.spawn(["git", "diff", "--name-only", "--diff-filter=U"], {
		cwd,
		stdout: "pipe",
	});
	await statusProc.exited;
	const conflictOutput = await new Response(statusProc.stdout).text();
	const conflictFiles = conflictOutput.trim().split("\n").filter(Boolean);

	// Abort the failed merge
	const abortProc = Bun.spawn(["git", "merge", "--abort"], { cwd });
	await abortProc.exited;

	return { success: false, conflictFiles };
}

/** Tiered conflict resolution */
export async function resolveConflicts(
	cwd: string,
	branch: string,
	targetBranch: string,
	maxTier: ConflictTier,
): Promise<{ tier: ConflictTier; success: boolean; files: string[] }> {
	// Tier 1: Try auto-merge (textual)
	const result = await attemptMerge(cwd, branch, targetBranch);
	if (result.success) return { tier: 1, success: true, files: [] };

	if (maxTier < 2) return { tier: 1, success: false, files: result.conflictFiles };

	// Tier 2: Accept theirs for non-source files (config, lockfiles)
	const nonSourceConflicts = result.conflictFiles.filter(
		(f) => f.endsWith(".lock") || f.endsWith(".json") || f.endsWith(".yaml") || f.endsWith(".toml"),
	);
	if (nonSourceConflicts.length === result.conflictFiles.length) {
		// All conflicts are non-source — accept theirs
		const proc = Bun.spawn(
			["git", "merge", branch, "-X", "theirs", "-m", `merge: ${branch} (tier 2)`],
			{
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const code = await proc.exited;
		if (code === 0) return { tier: 2, success: true, files: nonSourceConflicts };
	}

	if (maxTier < 3) return { tier: 2, success: false, files: result.conflictFiles };

	// Tier 3: AI resolver — spawn an agent to resolve conflicts
	// For now, just report. Full AI resolution in future version.
	return { tier: 3, success: false, files: result.conflictFiles };

	// Tier 4 would be: human required (not automated)
}

function rowToEntry(row: Record<string, unknown>): MergeEntry {
	return {
		id: row.id as string,
		branch: row.branch as string,
		agentName: row.agent_name as string,
		runId: row.run_id as string,
		status: row.status as MergeStatus,
		conflictFiles: row.conflict_files ? JSON.parse(row.conflict_files as string) : undefined,
		resolvedAt: row.resolved_at as string | undefined,
		createdAt: row.created_at as string,
	};
}
