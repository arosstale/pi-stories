/** Thread-Based Engineering — IndyDevDan's 7 thread types as first-class primitives
 *
 * Sources:
 *   - agenticengineer.com/thinking-in-threads
 *   - agenticengineer.com/top-2-percent-agentic-engineering
 *   - claudefa.st/blog/guide/mechanics/thread-based-engineering
 *   - disler/pi-vs-claude-code (agent-chain.ts, agent-team.ts)
 *
 * The Core Four: Context, Model, Prompt, Tools
 * The Four Scaling Dimensions: Width (P), Time (L), Depth (B), Attention (Z)
 */

/** The 7 thread types */
export type ThreadType =
	| "base"    // Single prompt → tool calls → review
	| "P"       // Parallel — multiple agents simultaneously
	| "C"       // Chained — phased with human checkpoints
	| "F"       // Fusion — best-of-N + aggregation
	| "B"       // Big/Meta — agents spawning agents
	| "L"       // Long — extended autonomy (hours/days)
	| "Z";      // Zero-touch — no review, maximum trust

export interface ThreadConfig {
	type: ThreadType;
	/** Human-readable name */
	name: string;
	/** Task description */
	task: string;
	/** Which runtimes to use */
	runtimes?: string[];
	/** Agent roles for this thread */
	roles?: string[];
	/** Cost tier override */
	tier?: 1 | 2 | 3;
	/** Max duration in ms (L-threads) */
	maxDuration?: number;
	/** Number of parallel agents (P/F-threads) */
	width?: number;
	/** Chain steps (C-threads) */
	steps?: ChainStep[];
	/** Fusion strategy (F-threads) */
	fusionStrategy?: "best-of-n" | "cherry-pick" | "merge";
	/** Whether human review is required at end */
	requireReview?: boolean;
	/** Budget for this thread */
	budget?: number;
}

export interface ChainStep {
	agent: string;
	prompt: string;
	/** Template vars: $INPUT (prev output), $ORIGINAL (user prompt) */
}

export interface ThreadMetrics {
	threadId: string;
	type: ThreadType;
	/** Total tool calls across all agents in this thread */
	toolCalls: number;
	/** Duration in seconds */
	duration: number;
	/** Number of human interventions */
	checkpoints: number;
	/** Total cost */
	cost: number;
	/** Number of parallel agents used */
	width: number;
	/** Nesting depth (B-threads) */
	depth: number;
	/** Whether review was needed */
	reviewed: boolean;
}

/** The four scaling dimensions — track weekly for improvement */
export interface ThreadScorecard {
	/** More threads: how many concurrent threads? */
	width: number;
	/** Longer threads: avg tool calls before intervention */
	avgToolCalls: number;
	/** Thicker threads: avg work per single prompt (depth) */
	avgDepth: number;
	/** Fewer checkpoints: % of threads that needed no manual review */
	trustRatio: number;
	/** Total threads this week */
	totalThreads: number;
	/** Period */
	weekOf: string;
}

/** Predefined chain templates (from disler's agent-chain.yaml) */
export const CHAIN_TEMPLATES: Record<string, { description: string; steps: ChainStep[] }> = {
	"plan-build-review": {
		description: "Plan, implement, and review — the standard development cycle",
		steps: [
			{ agent: "planner", prompt: "Plan the implementation for: $INPUT" },
			{ agent: "builder", prompt: "Implement the following plan:\n\n$INPUT" },
			{ agent: "reviewer", prompt: "Review this implementation for bugs, style, and correctness:\n\n$INPUT" },
		],
	},
	"plan-build": {
		description: "Plan then build — fast two-step without review",
		steps: [
			{ agent: "planner", prompt: "Plan the implementation for: $INPUT" },
			{ agent: "builder", prompt: "Based on this plan, implement:\n\n$INPUT" },
		],
	},
	"scout-flow": {
		description: "Triple-scout deep recon — explore, validate, verify",
		steps: [
			{ agent: "scout", prompt: "Explore the codebase and investigate: $INPUT\n\nReport findings with structure, key files, and patterns." },
			{ agent: "scout", prompt: "Validate and cross-check the following analysis. Look for anything missed or incorrect:\n\n$INPUT\n\nOriginal request: $ORIGINAL" },
			{ agent: "scout", prompt: "Final review pass. Verify the analysis is accurate and complete:\n\n$INPUT\n\nOriginal request: $ORIGINAL" },
		],
	},
	"plan-review-plan": {
		description: "Iterative planning — plan, critique, then refine",
		steps: [
			{ agent: "planner", prompt: "Create a detailed implementation plan for: $INPUT" },
			{ agent: "reviewer", prompt: "Critically review this plan. Challenge assumptions, find gaps:\n\n$INPUT\n\nOriginal request: $ORIGINAL" },
			{ agent: "planner", prompt: "Revise based on critique. Address every issue:\n\nOriginal request: $ORIGINAL\n\nCritique:\n$INPUT" },
		],
	},
	"full-pipeline": {
		description: "End-to-end: scout → plan → build → review",
		steps: [
			{ agent: "scout", prompt: "Explore the codebase and identify: $INPUT" },
			{ agent: "planner", prompt: "Based on this analysis, create a plan:\n\n$INPUT" },
			{ agent: "builder", prompt: "Implement this plan:\n\n$INPUT" },
			{ agent: "reviewer", prompt: "Review this implementation:\n\n$INPUT" },
		],
	},
};

/** Agent team presets (from disler's teams.yaml) */
export const TEAM_PRESETS: Record<string, string[]> = {
	full: ["scout", "planner", "builder", "reviewer"],
	"plan-build": ["planner", "builder", "reviewer"],
	info: ["scout", "reviewer"],
	frontend: ["planner", "builder"],
};
