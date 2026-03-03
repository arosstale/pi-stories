/** SQLite session store — agent lifecycle tracking */

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentSession, AgentSessionStatus, AgentRole } from "../types.ts";

let db: Database | null = null;

/** Close the DB handle — required for tests and clean shutdown */
export function closeSessionDb(): void {
	if (db) { db.close(); db = null; }
}

export function initSessionDb(configDir: string): Database {
	if (db) return db;

	db = new Database(join(configDir, "sessions.db"));
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA busy_timeout=5000");

	db.exec(`
		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			runtime TEXT NOT NULL,
			role TEXT NOT NULL,
			task TEXT NOT NULL,
			run_id TEXT,
			pid INTEGER,
			worktree TEXT,
			branch TEXT,
			parent_agent TEXT,
			depth INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL DEFAULT 'running',
			started_at TEXT NOT NULL,
			completed_at TEXT,
			last_activity_at TEXT NOT NULL,
			token_count INTEGER NOT NULL DEFAULT 0,
			cost REAL NOT NULL DEFAULT 0.0
		)
	`);

	db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_run ON sessions(run_id)`);

	return db;
}

export function createSession(
	configDir: string,
	opts: {
		name: string;
		runtime: string;
		role: AgentRole;
		task: string;
		runId?: string;
		pid?: number;
		worktree?: string;
		branch?: string;
		parentAgent?: string;
		depth?: number;
	},
): AgentSession {
	const store = initSessionDb(configDir);
	const id = randomUUID().slice(0, 12);
	const now = new Date().toISOString();

	store
		.prepare(
			`INSERT INTO sessions (id, name, runtime, role, task, run_id, pid, worktree, branch, parent_agent, depth, status, started_at, last_activity_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
		)
		.run(
			id,
			opts.name,
			opts.runtime,
			opts.role,
			opts.task,
			opts.runId ?? null,
			opts.pid ?? null,
			opts.worktree ?? null,
			opts.branch ?? null,
			opts.parentAgent ?? null,
			opts.depth ?? 0,
			now,
			now,
		);

	return {
		id,
		name: opts.name,
		runtime: opts.runtime,
		role: opts.role,
		task: opts.task,
		runId: opts.runId,
		pid: opts.pid,
		worktree: opts.worktree,
		branch: opts.branch,
		parentAgent: opts.parentAgent,
		depth: opts.depth ?? 0,
		status: "running",
		startedAt: now,
		lastActivityAt: now,
		tokenCount: 0,
		cost: 0,
	};
}

export function updateSession(
	configDir: string,
	id: string,
	updates: Partial<Pick<AgentSession, "status" | "tokenCount" | "cost" | "pid">>,
): void {
	const store = initSessionDb(configDir);
	const now = new Date().toISOString();
	const sets: string[] = ["last_activity_at = ?"];
	const params: unknown[] = [now];

	if (updates.status !== undefined) {
		sets.push("status = ?");
		params.push(updates.status);
		if (updates.status === "completed" || updates.status === "failed" || updates.status === "killed") {
			sets.push("completed_at = ?");
			params.push(now);
		}
	}
	if (updates.tokenCount !== undefined) {
		sets.push("token_count = ?");
		params.push(updates.tokenCount);
	}
	if (updates.cost !== undefined) {
		sets.push("cost = ?");
		params.push(updates.cost);
	}
	if (updates.pid !== undefined) {
		sets.push("pid = ?");
		params.push(updates.pid);
	}

	params.push(id);
	store.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

export function getSession(configDir: string, id: string): AgentSession | undefined {
	const store = initSessionDb(configDir);
	const row = store.prepare("SELECT * FROM sessions WHERE id = ? OR name = ?").get(id, id) as
		| Record<string, unknown>
		| undefined;
	return row ? rowToSession(row) : undefined;
}

export function listSessions(
	configDir: string,
	opts?: { status?: AgentSessionStatus; runId?: string; limit?: number },
): AgentSession[] {
	const store = initSessionDb(configDir);
	const conditions: string[] = [];
	const params: unknown[] = [];

	if (opts?.status) {
		conditions.push("status = ?");
		params.push(opts.status);
	}
	if (opts?.runId) {
		conditions.push("run_id = ?");
		params.push(opts.runId);
	}

	const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
	const limit = opts?.limit ?? 50;

	const rows = store
		.prepare(`SELECT * FROM sessions ${where} ORDER BY started_at DESC LIMIT ?`)
		.all(...params, limit) as Array<Record<string, unknown>>;

	return rows.map(rowToSession);
}

export function getActiveSessions(configDir: string): AgentSession[] {
	return listSessions(configDir, { status: "running" });
}

export function findStalledSessions(configDir: string, stallThresholdMs: number): AgentSession[] {
	const store = initSessionDb(configDir);
	const cutoff = new Date(Date.now() - stallThresholdMs).toISOString();

	const rows = store
		.prepare("SELECT * FROM sessions WHERE status = 'running' AND last_activity_at < ?")
		.all(cutoff) as Array<Record<string, unknown>>;

	return rows.map(rowToSession);
}

export function getSessionStats(configDir: string): {
	active: number;
	completed: number;
	failed: number;
	totalCost: number;
	totalTokens: number;
} {
	const store = initSessionDb(configDir);
	const active = (store.prepare("SELECT COUNT(*) as c FROM sessions WHERE status = 'running'").get() as { c: number }).c;
	const completed = (store.prepare("SELECT COUNT(*) as c FROM sessions WHERE status = 'completed'").get() as { c: number }).c;
	const failed = (store.prepare("SELECT COUNT(*) as c FROM sessions WHERE status = 'failed'").get() as { c: number }).c;
	const costs = store.prepare("SELECT SUM(cost) as total_cost, SUM(token_count) as total_tokens FROM sessions").get() as {
		total_cost: number | null;
		total_tokens: number | null;
	};

	return {
		active,
		completed,
		failed,
		totalCost: costs.total_cost ?? 0,
		totalTokens: costs.total_tokens ?? 0,
	};
}

function rowToSession(row: Record<string, unknown>): AgentSession {
	return {
		id: row.id as string,
		name: row.name as string,
		runtime: row.runtime as string,
		role: row.role as AgentRole,
		task: row.task as string,
		runId: row.run_id as string | undefined,
		pid: row.pid as number | undefined,
		worktree: row.worktree as string | undefined,
		branch: row.branch as string | undefined,
		parentAgent: row.parent_agent as string | undefined,
		depth: row.depth as number,
		status: row.status as AgentSessionStatus,
		startedAt: row.started_at as string,
		completedAt: row.completed_at as string | undefined,
		lastActivityAt: row.last_activity_at as string,
		tokenCount: row.token_count as number,
		cost: row.cost as number,
	};
}
