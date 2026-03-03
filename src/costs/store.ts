/** SQLite cost persistence + pricing table */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { CostEntry, CostTier, ModelPricing } from "../types.ts";

let db: Database | null = null;

/** Model pricing table (per 1K tokens) */
export const PRICING: ModelPricing[] = [
	// Tier 1 — cheap/fast
	{ id: "claude-haiku-4-5", inputPer1k: 0.0008, outputPer1k: 0.004, tier: 1 },
	{ id: "gpt-4o-mini", inputPer1k: 0.00015, outputPer1k: 0.0006, tier: 1 },
	{ id: "gemini-2.5-flash", inputPer1k: 0.00015, outputPer1k: 0.0006, tier: 1 },

	// Tier 2 — balanced
	{ id: "claude-sonnet-4-5", inputPer1k: 0.003, outputPer1k: 0.015, tier: 2 },
	{ id: "gpt-5", inputPer1k: 0.005, outputPer1k: 0.015, tier: 2 },
	{ id: "gemini-2.5-pro", inputPer1k: 0.00125, outputPer1k: 0.01, tier: 2 },

	// Tier 3 — premium
	{ id: "claude-opus-4-5", inputPer1k: 0.015, outputPer1k: 0.075, tier: 3 },
	{ id: "o3", inputPer1k: 0.01, outputPer1k: 0.04, tier: 3 },
];

export function initCostDb(configDir: string): Database {
	if (db) return db;

	db = new Database(join(configDir, "costs.db"));
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA busy_timeout=5000");

	db.exec(`
		CREATE TABLE IF NOT EXISTS cost_entries (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			run_id TEXT NOT NULL,
			step_id TEXT NOT NULL,
			runtime TEXT NOT NULL,
			model TEXT NOT NULL,
			input_tokens INTEGER NOT NULL,
			output_tokens INTEGER NOT NULL,
			cost REAL NOT NULL,
			tier INTEGER NOT NULL,
			created_at TEXT NOT NULL
		)
	`);

	db.exec(`CREATE INDEX IF NOT EXISTS idx_cost_run ON cost_entries(run_id)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_cost_date ON cost_entries(created_at)`);

	return db;
}

export function recordCost(configDir: string, runId: string, stepId: string, entry: CostEntry): void {
	const store = initCostDb(configDir);
	store
		.prepare(
			"INSERT INTO cost_entries (run_id, step_id, runtime, model, input_tokens, output_tokens, cost, tier, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(runId, stepId, entry.runtime, entry.model, entry.inputTokens, entry.outputTokens, entry.cost, entry.tier, new Date().toISOString());
}

export function getCostsByRun(configDir: string, runId: string): CostEntry[] {
	const store = initCostDb(configDir);
	const rows = store.prepare("SELECT * FROM cost_entries WHERE run_id = ? ORDER BY created_at").all(runId) as Array<Record<string, unknown>>;
	return rows.map(rowToEntry);
}

export function getCostSummary(configDir: string): {
	today: number;
	week: number;
	total: number;
	byTier: Record<CostTier, number>;
	byRuntime: Record<string, number>;
} {
	const store = initCostDb(configDir);

	const total = (store.prepare("SELECT COALESCE(SUM(cost), 0) as s FROM cost_entries").get() as { s: number }).s;

	const todayStart = new Date();
	todayStart.setHours(0, 0, 0, 0);
	const today = (store.prepare("SELECT COALESCE(SUM(cost), 0) as s FROM cost_entries WHERE created_at >= ?").get(todayStart.toISOString()) as { s: number }).s;

	const weekStart = new Date(Date.now() - 7 * 86400000);
	const week = (store.prepare("SELECT COALESCE(SUM(cost), 0) as s FROM cost_entries WHERE created_at >= ?").get(weekStart.toISOString()) as { s: number }).s;

	const tierRows = store.prepare("SELECT tier, SUM(cost) as s FROM cost_entries GROUP BY tier").all() as Array<{ tier: number; s: number }>;
	const byTier: Record<CostTier, number> = { 1: 0, 2: 0, 3: 0 };
	for (const row of tierRows) {
		if (row.tier === 1 || row.tier === 2 || row.tier === 3) {
			byTier[row.tier] = row.s;
		}
	}

	const runtimeRows = store.prepare("SELECT runtime, SUM(cost) as s FROM cost_entries GROUP BY runtime").all() as Array<{ runtime: string; s: number }>;
	const byRuntime: Record<string, number> = {};
	for (const row of runtimeRows) {
		byRuntime[row.runtime] = row.s;
	}

	return { today, week, total, byTier, byRuntime };
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
	const pricing = PRICING.find((p) => p.id === model);
	if (!pricing) return 0;
	return (inputTokens / 1000) * pricing.inputPer1k + (outputTokens / 1000) * pricing.outputPer1k;
}

export function getModelTier(model: string): CostTier {
	const pricing = PRICING.find((p) => p.id === model);
	return pricing?.tier ?? 2;
}

function rowToEntry(row: Record<string, unknown>): CostEntry {
	return {
		runtime: row.runtime as string,
		model: row.model as string,
		inputTokens: row.input_tokens as number,
		outputTokens: row.output_tokens as number,
		cost: row.cost as number,
		tier: row.tier as CostTier,
	};
}
