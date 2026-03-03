/** JSONL event logger */

import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PipelineEvent } from "../types.ts";

const buffer: PipelineEvent[] = [];

/** Emit a pipeline event (buffered) */
export async function emitEvent(event: PipelineEvent): Promise<void> {
	buffer.push(event);

	// Also log to console in development
	const icon = eventIcon(event.type);
	const step = event.stepId ? ` [${event.stepId}]` : "";
	const cost = event.data?.cost ? ` ($${Number(event.data.cost).toFixed(4)})` : "";
	console.log(`  ${icon}${step} ${event.type}${cost}`);
}

/** Flush buffered events to JSONL file */
export async function flushEvents(runDir: string): Promise<void> {
	if (buffer.length === 0) return;

	const lines = buffer.map((e) => JSON.stringify(e)).join("\n") + "\n";
	await writeFile(join(runDir, "events.jsonl"), lines);
	buffer.length = 0;
}

/** Read events from a run directory */
export async function readEvents(runDir: string): Promise<PipelineEvent[]> {
	try {
		const raw = await Bun.file(join(runDir, "events.jsonl")).text();
		return raw
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line) as PipelineEvent);
	} catch {
		return [];
	}
}

function eventIcon(type: string): string {
	switch (type) {
		case "run:start":
			return "🚀";
		case "run:complete":
			return "✅";
		case "run:fail":
			return "❌";
		case "step:start":
			return "▶️";
		case "step:pass":
			return "✓";
		case "step:fail":
			return "✗";
		case "step:retry":
			return "🔄";
		case "gate:pass":
			return "🔧";
		case "gate:fail":
			return "🚫";
		case "cost:update":
			return "💰";
		default:
			return "·";
	}
}
