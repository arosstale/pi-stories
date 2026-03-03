/** [N] Non-deterministic agent dispatch */

import type { CostEntry, PipelineStep, RunState } from "../types.ts";
import { RuntimeError } from "../errors.ts";

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
): Promise<AgentResult> {
	const role = step.role ?? "builder";
	const prompt = buildPrompt(step, task, state, runDir);

	// For now, use pi as the default runtime
	// TODO: runtime registry lookup based on config
	const runtime = "pi";

	const result = await spawnAgent(runtime, prompt, cwd);
	return result;
}

/** Build the prompt for an agent step, injecting context */
function buildPrompt(step: PipelineStep, task: string, state: RunState, runDir: string): string {
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

/** Spawn an agent CLI process and capture output */
async function spawnAgent(
	runtime: string,
	prompt: string,
	cwd: string,
): Promise<AgentResult> {
	const cmd = buildCommand(runtime, prompt);

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

	// TODO: parse cost from runtime output (pi outputs cost info)
	return {
		output: stdout,
		model: undefined,
		cost: undefined,
	};
}

/** Build the CLI command for a runtime */
function buildCommand(runtime: string, prompt: string): string[] {
	switch (runtime) {
		case "pi":
			return ["pi", "--print", prompt];
		case "claude":
			return ["claude", "--print", prompt];
		case "codex":
			return ["codex", "--quiet", prompt];
		case "gemini-cli":
			return ["gemini", prompt];
		default:
			// Generic fallback — assume CLI accepts prompt as first arg
			return [runtime, prompt];
	}
}
