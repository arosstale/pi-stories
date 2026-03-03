/** [N] Non-deterministic agent dispatch */

import { RuntimeError } from "../errors.ts";
import type { CostEntry, CostTier, PipelineStep, ProjectConfig, RunState } from "../types.ts";
import { parseCostFromOutput, parseModel } from "./cost-parser.ts";

export interface AgentResult {
	output: string;
	cost?: CostEntry;
	model?: string;
}

/** Run an agent step — spawns the configured runtime CLI */
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

	const result = await spawnAgent(runtime, prompt, cwd, model);

	// Tag the cost with tier + runtime info
	if (result.cost) {
		result.cost.tier = tier;
		result.cost.runtime = runtime;
	}

	return result;
}

/** Build the prompt for an agent step, injecting context */
function buildPrompt(step: PipelineStep, task: string, state: RunState, _runDir: string): string {
	const parts: string[] = [];

	parts.push(`# Task: ${task}`);
	parts.push(`# Role: ${step.role ?? "builder"}`);
	parts.push(`# Step: ${step.name}`);
	parts.push("");

	// Include context from previous steps
	if (state.steps.length > 0) {
		parts.push("## Previous step results:");
		for (const prev of state.steps) {
			if (prev.status === "passed" && prev.output) {
				parts.push(`### ${prev.stepId}: ${prev.output.slice(0, 500)}`);
			}
		}
		parts.push("");
	}

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

/** Spawn an agent CLI process and capture output + cost */
async function spawnAgent(
	runtime: string,
	prompt: string,
	cwd: string,
	model?: string,
): Promise<AgentResult> {
	const cmd = buildCommand(runtime, prompt, model);

	const proc = Bun.spawn(cmd, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env },
	});

	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();

	if (exitCode !== 0) {
		throw new RuntimeError(runtime, `Exit code ${exitCode}: ${stderr.slice(0, 500)}`);
	}

	const cost = parseCostFromOutput(runtime, stdout, stderr);

	return {
		output: stdout,
		model: model ?? parseModel(runtime, stderr),
		cost,
	};
}

/** Build the CLI command for a runtime, including model override */
function buildCommand(runtime: string, prompt: string, model?: string): string[] {
	switch (runtime) {
		case "pi":
			return model ? ["pi", "--print", "--model", model, prompt] : ["pi", "--print", prompt];
		case "claude":
			return model
				? ["claude", "--print", "--model", model, prompt]
				: ["claude", "--print", prompt];
		case "codex":
			return model ? ["codex", "--quiet", "--model", model, prompt] : ["codex", "--quiet", prompt];
		case "gemini-cli":
			return model ? ["gemini", "--model", model, prompt] : ["gemini", prompt];
		case "aider":
			return model
				? ["aider", "--message", prompt, "--yes", "--model", model]
				: ["aider", "--message", prompt, "--yes"];
		default:
			return [runtime, prompt];
	}
}
