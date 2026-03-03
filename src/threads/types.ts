/** Thread-Based Engineering — classification and measurement
 *
 * Threads are not a runtime abstraction. They're a mental model for
 * how you work. Every pi-stories action IS a thread — we just classify
 * it so you can measure your progression.
 *
 * Sources:
 *   - agenticengineer.com/thinking-in-threads
 *   - agenticengineer.com/top-2-percent-agentic-engineering
 *   - claudefa.st/blog/guide/mechanics/thread-based-engineering
 */

/** The 7 thread types — classification, not abstraction */
export type ThreadType =
	| "base" // `sling` — single prompt → tool calls → review
	| "P" // `parallel` — multiple agents simultaneously
	| "C" // `run` — phased [D]/[N] pipeline with gates
	| "F" // `parallel --fusion` — same task × N, pick best
	| "B" // `run` with sub-agents — agents spawning agents
	| "L" // `sling --long` — extended autonomy (hours)
	| "Z"; // `sling --no-review` — zero-touch, maximum trust

/** Metrics recorded per thread */
export interface ThreadMetrics {
	threadId: string;
	type: ThreadType;
	toolCalls: number;
	duration: number;
	checkpoints: number;
	cost: number;
	width: number;
	depth: number;
	reviewed: boolean;
}

/** Weekly scorecard — the 4 scaling dimensions */
export interface ThreadScorecard {
	width: number; // Max parallel threads (P-threads)
	avgToolCalls: number; // Avg tool calls before intervention (L-threads)
	avgDepth: number; // Avg work per prompt (B-threads)
	trustRatio: number; // % of threads needing no review (Z-threads)
	totalThreads: number;
	weekOf: string;
}

/** Classify a command invocation into its thread type */
export function classifyThread(command: string, opts: Record<string, unknown> = {}): ThreadType {
	switch (command) {
		case "sling":
			if (opts.noReview) return "Z";
			if (opts.long || (opts.maxDuration && Number(opts.maxDuration) > 3600000)) return "L";
			return "base";
		case "parallel":
			if (opts.fusion) return "F";
			return "P";
		case "run":
			if (opts.depth && Number(opts.depth) > 0) return "B";
			return "C"; // [D]/[N] pipeline = chained thread with gates
		default:
			return "base";
	}
}
