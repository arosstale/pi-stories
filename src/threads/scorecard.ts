/** Thread Scorecard — track your 4 scaling dimensions weekly
 *
 * "Improving at any of these four dimensions means you're improving
 *  as an agentic engineer. That's the metric." — IndyDevDan
 *
 * Width:     More threads (P-threads)
 * Time:      Longer threads (L-threads, avg tool calls)
 * Depth:     Thicker threads (B-threads, work per prompt)
 * Attention: Fewer checkpoints (Z-threads, trust ratio)
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { ThreadMetrics, ThreadScorecard } from "./types.ts";

let db: Database | null = null;

function initDb(configDir: string): Database {
	if (db) return db;

	db = new Database(join(configDir, "threads.db"));
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA busy_timeout=5000");

	db.exec(`
		CREATE TABLE IF NOT EXISTS thread_runs (
			id TEXT PRIMARY KEY,
			type TEXT NOT NULL,
			tool_calls INTEGER NOT NULL DEFAULT 0,
			duration REAL NOT NULL DEFAULT 0,
			checkpoints INTEGER NOT NULL DEFAULT 0,
			cost REAL NOT NULL DEFAULT 0,
			width INTEGER NOT NULL DEFAULT 1,
			depth INTEGER NOT NULL DEFAULT 0,
			reviewed INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS scorecards (
			week_of TEXT PRIMARY KEY,
			width REAL NOT NULL,
			avg_tool_calls REAL NOT NULL,
			avg_depth REAL NOT NULL,
			trust_ratio REAL NOT NULL,
			total_threads INTEGER NOT NULL,
			created_at TEXT NOT NULL
		)
	`);

	return db;
}

/** Record a completed thread */
export function recordThread(configDir: string, metrics: ThreadMetrics): void {
	const store = initDb(configDir);
	store
		.prepare(
			`INSERT INTO thread_runs (id, type, tool_calls, duration, checkpoints, cost, width, depth, reviewed, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			metrics.threadId,
			metrics.type,
			metrics.toolCalls,
			metrics.duration,
			metrics.checkpoints,
			metrics.cost,
			metrics.width,
			metrics.depth,
			metrics.reviewed ? 1 : 0,
			new Date().toISOString(),
		);
}

/** Calculate scorecard for the current week */
export function calculateScorecard(configDir: string): ThreadScorecard {
	const store = initDb(configDir);

	// Current week: Monday 00:00 to now
	const now = new Date();
	const dayOfWeek = now.getDay();
	const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
	const monday = new Date(now);
	monday.setDate(now.getDate() - mondayOffset);
	monday.setHours(0, 0, 0, 0);
	const weekOf = monday.toISOString().slice(0, 10);

	const rows = store
		.prepare("SELECT * FROM thread_runs WHERE created_at >= ?")
		.all(monday.toISOString()) as Array<Record<string, unknown>>;

	if (rows.length === 0) {
		return {
			width: 0,
			avgToolCalls: 0,
			avgDepth: 0,
			trustRatio: 0,
			totalThreads: 0,
			weekOf,
		};
	}

	// Width: max concurrent threads (proxy: max width value)
	const maxWidth = Math.max(...rows.map((r) => r.width as number));

	// Time: average tool calls before intervention
	const totalToolCalls = rows.reduce((sum, r) => sum + (r.tool_calls as number), 0);
	const avgToolCalls = totalToolCalls / rows.length;

	// Depth: average depth (B-threads contribute)
	const totalDepth = rows.reduce((sum, r) => sum + (r.depth as number), 0);
	const avgDepth = totalDepth / rows.length;

	// Attention: % of threads that needed no review (Z-threads)
	const unreviewedCount = rows.filter((r) => (r.reviewed as number) === 0).length;
	const trustRatio = unreviewedCount / rows.length;

	return {
		width: maxWidth,
		avgToolCalls,
		avgDepth,
		trustRatio,
		totalThreads: rows.length,
		weekOf,
	};
}

/** Save scorecard snapshot */
export function saveScorecard(configDir: string, scorecard: ThreadScorecard): void {
	const store = initDb(configDir);
	store
		.prepare(
			`INSERT OR REPLACE INTO scorecards (week_of, width, avg_tool_calls, avg_depth, trust_ratio, total_threads, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			scorecard.weekOf,
			scorecard.width,
			scorecard.avgToolCalls,
			scorecard.avgDepth,
			scorecard.trustRatio,
			scorecard.totalThreads,
			new Date().toISOString(),
		);
}

/** Get historical scorecards for trend analysis */
export function getHistory(configDir: string, weeks?: number): ThreadScorecard[] {
	const store = initDb(configDir);
	const limit = weeks ?? 12;

	const rows = store
		.prepare("SELECT * FROM scorecards ORDER BY week_of DESC LIMIT ?")
		.all(limit) as Array<Record<string, unknown>>;

	return rows.map((r) => ({
		width: r.width as number,
		avgToolCalls: r.avg_tool_calls as number,
		avgDepth: r.avg_depth as number,
		trustRatio: r.trust_ratio as number,
		totalThreads: r.total_threads as number,
		weekOf: r.week_of as string,
	}));
}

/** Get thread type breakdown for current week */
export function getThreadBreakdown(configDir: string): Record<string, number> {
	const store = initDb(configDir);

	const now = new Date();
	const dayOfWeek = now.getDay();
	const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
	const monday = new Date(now);
	monday.setDate(now.getDate() - mondayOffset);
	monday.setHours(0, 0, 0, 0);

	const rows = store
		.prepare("SELECT type, COUNT(*) as count FROM thread_runs WHERE created_at >= ? GROUP BY type")
		.all(monday.toISOString()) as Array<{ type: string; count: number }>;

	const breakdown: Record<string, number> = {};
	for (const row of rows) {
		breakdown[row.type] = row.count;
	}
	return breakdown;
}
