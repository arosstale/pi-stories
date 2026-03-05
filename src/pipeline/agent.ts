/** [N] Non-deterministic agent dispatch — uses runtime registry */

import { RuntimeError } from "../errors.ts";
import { getRuntime, awaitHandle } from "../runtimes/registry.ts";
import type { CostEntry, CostTier, PipelineStep, ProjectConfig, RunState } from "../types.ts";
import { parseCostFromOutput, parseModel } from "./cost-parser.ts";

export interface AgentResult {
	output: string;
	cost?: CostEntry;
	model?: string;
}

/** Run an agent step — spawns the configured runtime CLI via registry */
export async function runAgent(
	step: PipelineStep,
	task: string,
	state: RunState,
	cwd: string,
	runDir: string,
	config?: ProjectConfig,
): Promise<AgentResult> {
	const prompt = buildPrompt(step, task, state, runDir);

	// Resolve runtime from config: role → runtime mapping
	const role = step.role ?? "builder";
	const runtime = config?.runtimes?.[role] ?? "pi";

	// Resolve model from config: tier → model mapping
	const tier = step.tier ?? 2;
	const model = config?.models?.[tier];

	// Spawn via registry adapter
	const adapter = getRuntime(runtime);
	const handle = await adapter.spawn({ prompt, cwd, model });
	const { stdout, stderr, exitCode } = await awaitHandle(handle);

	if (exitCode !== 0) {
		throw new RuntimeError(runtime, `Exit code ${exitCode}: ${stderr.slice(0, 500)}`);
	}

	const cost = parseCostFromOutput(runtime, stdout, stderr);

	const result: AgentResult = {
		output: stdout,
		model: model ?? parseModel(runtime, stderr),
		cost,
	};

	// Tag cost with tier + runtime
	if (result.cost) {
		result.cost.tier = tier;
		result.cost.runtime = runtime;
	}

	return result;
}

/** Build the prompt for an agent step, injecting context from previous steps */
function buildPrompt(step: PipelineStep, task: string, state: RunState, _runDir: string): string {
	const parts: string[] = [];

	parts.push(`# Task: ${task}`);
	parts.push(`# Role: ${step.role ?? "builder"}`);
	parts.push(`# Step: ${step.name}`);
	parts.push("");

	// Include context from previous steps
	const prevResults = state.steps.filter((s) => s.status === "passed" && s.output);
	if (prevResults.length > 0) {
		parts.push("## Previous step results:");
		for (const prev of prevResults) {
			parts.push(`### ${prev.stepId}:`);
			parts.push(prev.output!.slice(0, 800));
			parts.push("");
		}
	}

	// Role-specific instructions
	switch (step.role) {
		case "scout":
			parts.push("Find relevant code and context. Report file paths and key findings.");
			parts.push("Do NOT implement anything. Just explore and report.");
			break;
		case "planner":
			parts.push("Design the implementation plan based on scout findings.");
			parts.push("List files to create/modify, functions to write, tests to add.");
			break;
		case "builder":
			parts.push("Implement the plan. Write code, create files, run tests.");
			parts.push("Follow the plan exactly. If something is unclear, note it.");
			break;
		case "reviewer":
			parts.push("Review the git diff for bugs, style issues, and correctness.");
			parts.push("Output: PASS or FAIL with specific issues listed.");
			break;
		default:
			parts.push("Complete the assigned task.");
	}

	return parts.join("\n");
}
